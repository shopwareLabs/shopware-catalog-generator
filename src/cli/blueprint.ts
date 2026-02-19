/**
 * Blueprint CLI commands: create, hydrate, fix.
 */

import type { HydratedBlueprint } from "../types/index.js";
import type { ExistingProperty } from "../utils/index.js";
import type { CliArgs } from "./shared.js";

import {
    BlueprintGenerator,
    BlueprintHydrator,
    generateCmsBlueprint,
    hydrateCmsBlueprint,
    hydrateCmsImages,
    hydrateProductImages,
} from "../blueprint/index.js";
import { createCacheFromEnv } from "../cache.js";
import { createProvidersFromEnv } from "../providers/index.js";
import { DataHydrator } from "../shopware/index.js";
import { countCategories, logger, PropertyCollector } from "../utils/index.js";
import { CLIError, requireHydratedBlueprint, requireValidName } from "./shared.js";

export async function blueprintCreate(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);
    const description = args.description || `${salesChannelName} webshop`;
    const products = args.products || 90;

    const maxProductsPerBranch = parseInt(process.env.PRODUCTS_PER_CATEGORY || "30", 10);
    const topLevelCategories = Math.max(1, Math.ceil(products / maxProductsPerBranch));
    const productsPerBranch = Math.ceil(products / topLevelCategories);

    console.log(`\n=== Blueprint Create ===`);
    console.log(`Name: ${salesChannelName}`);
    console.log(`Description: ${description}`);
    console.log(`Products: ${products} (${topLevelCategories} categories)`);
    console.log();

    const cache = createCacheFromEnv();

    const generator = new BlueprintGenerator({
        totalProducts: products,
        topLevelCategories,
        productsPerBranch,
    });

    console.log("Generating blueprint...");
    const blueprint = generator.generateBlueprint(salesChannelName, description);

    cache.saveBlueprint(salesChannelName, blueprint);

    const categoryCount = countCategories(blueprint.categories);
    console.log(`\nBlueprint created:`);
    console.log(`  Categories: ${categoryCount}`);
    console.log(`  Products: ${blueprint.products.length}`);
    console.log(`  Saved to: generated/sales-channels/${salesChannelName}/blueprint.json`);
}

export async function blueprintHydrate(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);

    const hydrateOnly = args.only?.[0] as "categories" | "properties" | "cms" | undefined;
    const forceHydration = args.force === true;

    if (hydrateOnly && !["categories", "properties", "cms"].includes(hydrateOnly)) {
        throw new CLIError(
            `--only must be 'categories', 'properties', or 'cms' for blueprint hydrate (got: ${hydrateOnly})`,
            "INVALID_OPTION"
        );
    }

    logger.configure({ minLevel: "debug" });
    console.log(`\n=== Blueprint Hydrate ===`);
    console.log(`Name: ${salesChannelName}`);
    if (hydrateOnly) {
        console.log(
            `Mode: ${hydrateOnly} only (preserving ${hydrateOnly === "categories" ? "products" : "product names"})`
        );
    } else if (forceHydration) {
        console.log(`Mode: full (--force)`);
    }
    console.log(`Log file: ${logger.getLogFile()}`);
    console.log();

    const cache = createCacheFromEnv();

    const existingHydratedBlueprint = cache.loadHydratedBlueprint(salesChannelName);

    if (existingHydratedBlueprint && !hydrateOnly && !forceHydration) {
        throw new CLIError(
            `Hydrated blueprint already exists for "${salesChannelName}". ` +
                `Re-hydrating will change product names and trigger image regeneration. ` +
                `Use --only=categories, --only=properties, or --force.`,
            "BLUEPRINT_EXISTS"
        );
    }

    const blueprint = cache.loadBlueprint(salesChannelName);
    if (!blueprint) {
        throw new CLIError(
            `No blueprint found for "${salesChannelName}". ` +
                `Run: bun run src/main.ts blueprint create --name=${salesChannelName}`,
            "BLUEPRINT_NOT_FOUND"
        );
    }

    const { text: textProvider, image: imageProvider } = createProvidersFromEnv();

    let existingProperties: ExistingProperty[] = [];
    try {
        const dataHydrator = new DataHydrator();
        const swEnvUrl = process.env.SW_ENV_URL;
        if (swEnvUrl) {
            await dataHydrator.authenticateWithClientCredentials(
                swEnvUrl,
                process.env.SW_CLIENT_ID,
                process.env.SW_CLIENT_SECRET
            );
            existingProperties = await dataHydrator.getExistingPropertyGroups();
            console.log(`Found ${existingProperties.length} existing property groups in Shopware`);
        }
    } catch {
        console.log("Could not connect to Shopware, proceeding without existing properties");
    }

    // CMS-only hydration: generate and hydrate CMS text blueprint + images
    if (hydrateOnly === "cms") {
        const cmsBlueprint = generateCmsBlueprint(salesChannelName);
        const description = blueprint.salesChannel.description || `${salesChannelName} webshop`;
        const hydratedCms = await hydrateCmsBlueprint(cmsBlueprint, textProvider, description);
        cache.saveCmsBlueprint(salesChannelName, hydratedCms);

        await hydrateCmsImages(imageProvider, cache, salesChannelName, description);

        console.log(`\nCMS blueprint hydrated:`);
        console.log(`  Pages: ${hydratedCms.pages.length}`);
        console.log(`  Saved to: generated/sales-channels/${salesChannelName}/cms-blueprint.json`);
        return;
    }

    const hydrator = new BlueprintHydrator(textProvider);
    let hydratedBlueprint: HydratedBlueprint;

    if (hydrateOnly === "categories" && existingHydratedBlueprint) {
        hydratedBlueprint = await hydrator.hydrateCategoriesOnly(existingHydratedBlueprint);
    } else if (hydrateOnly === "properties" && existingHydratedBlueprint) {
        hydratedBlueprint = await hydrator.hydratePropertiesOnly(
            existingHydratedBlueprint,
            existingProperties
        );
    } else {
        hydratedBlueprint = await hydrator.hydrate(blueprint, existingProperties);
    }

    // Also hydrate CMS text + images (for full/force mode)
    if (!hydrateOnly) {
        const cmsBlueprint = generateCmsBlueprint(salesChannelName);
        const description = blueprint.salesChannel.description || `${salesChannelName} webshop`;
        const hydratedCms = await hydrateCmsBlueprint(cmsBlueprint, textProvider, description);
        cache.saveCmsBlueprint(salesChannelName, hydratedCms);
        console.log(`  CMS text: ${hydratedCms.pages.length} pages hydrated`);

        await hydrateCmsImages(imageProvider, cache, salesChannelName, description);
    }

    const collector = new PropertyCollector();
    const propertyGroups = collector.collectFromBlueprint(hydratedBlueprint, existingProperties);
    hydratedBlueprint.propertyGroups = propertyGroups;

    cache.saveHydratedBlueprint(salesChannelName, hydratedBlueprint);

    // Generate product + category images (needs metadata from hydrated blueprint)
    if (imageProvider.name !== "noop") {
        await hydrateProductImages(imageProvider, cache, salesChannelName, hydratedBlueprint);
    }

    console.log(`\nHydrated blueprint saved:`);
    console.log(`  Mode: ${hydrateOnly || "full"}`);
    console.log(`  Property groups: ${propertyGroups.length}`);
    console.log(`  Manufacturers: ${collector.collectManufacturers(hydratedBlueprint).length}`);
    console.log(`  Saved to: generated/sales-channels/${salesChannelName}/hydrated-blueprint.json`);
}

export async function blueprintFix(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);

    console.log(`\n=== Blueprint Fix ===`);
    console.log(`Name: ${salesChannelName}`);
    console.log();

    logger.configure({ minLevel: "debug" });

    const cache = createCacheFromEnv();

    const blueprint = requireHydratedBlueprint(cache, salesChannelName);

    const { text: textProvider } = createProvidersFromEnv();
    console.log(`Text provider: ${textProvider.name} (sequential: ${textProvider.isSequential})`);
    console.log();

    const hydrator = new BlueprintHydrator(textProvider);

    const placeholderCategories = hydrator.findPlaceholderCategories(blueprint.categories);
    const placeholderProducts = hydrator.findPlaceholderProducts(blueprint.products);

    console.log(`Found ${placeholderCategories.length} placeholder categories:`);
    for (const cat of placeholderCategories) {
        console.log(`  - ${cat.name}`);
    }
    console.log(`Found ${placeholderProducts.length} placeholder products:`);
    for (const prod of placeholderProducts.slice(0, 10)) {
        console.log(`  - ${prod.name}`);
    }
    if (placeholderProducts.length > 10) {
        console.log(`  ... and ${placeholderProducts.length - 10} more`);
    }
    console.log();

    if (placeholderCategories.length === 0 && placeholderProducts.length === 0) {
        console.log("No placeholders to fix. Blueprint is complete.");
        return;
    }

    const fixedBlueprint = await hydrator.fixPlaceholders(blueprint);

    if (placeholderProducts.length > 0) {
        const collector = new PropertyCollector();
        const existingProperties: ExistingProperty[] = blueprint.propertyGroups.map((pg) => ({
            id: pg.id,
            name: pg.name,
            displayType: pg.displayType || "text",
            options: pg.options.map((o) => ({
                id: o.id,
                name: o.name,
                colorHexCode: o.colorHexCode,
            })),
        }));
        const propertyGroups = collector.collectFromBlueprint(fixedBlueprint, existingProperties);
        fixedBlueprint.propertyGroups = propertyGroups;
    }

    cache.saveHydratedBlueprint(salesChannelName, fixedBlueprint);

    console.log(`\nFixed blueprint saved:`);
    console.log(`  Categories fixed: ${placeholderCategories.length}`);
    console.log(`  Products fixed: ${placeholderProducts.length}`);
    console.log(`  Saved to: generated/sales-channels/${salesChannelName}/hydrated-blueprint.json`);
}
