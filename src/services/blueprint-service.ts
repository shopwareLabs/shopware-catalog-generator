/**
 * Blueprint Service - shared application logic for blueprint create/hydrate/fix commands.
 *
 * Returns string[] (output lines) so both CLI (prints) and MCP (joins) can consume it.
 * Never calls console.log directly.
 */

import type { HydratedBlueprint } from "../types/index.js";
import type { ExistingProperty } from "../utils/index.js";

import {
    BlueprintGenerator,
    BlueprintHydrator,
    generateCmsBlueprint,
    hydrateCmsBlueprint,
    hydrateCmsImages,
    hydrateProductImages,
    hydrateThemeMedia,
} from "../blueprint/index.js";
import { createCacheFromEnv } from "../cache.js";
import { createProvidersFromEnv } from "../providers/index.js";
import { DataHydrator } from "../shopware/index.js";
import { countCategories, logger, PropertyCollector } from "../utils/index.js";

export async function createBlueprint(
    salesChannelName: string,
    description: string,
    products: number
): Promise<string[]> {
    const maxProductsPerBranch = parseInt(process.env.PRODUCTS_PER_CATEGORY || "30", 10);
    const topLevelCategories = Math.max(1, Math.ceil(products / maxProductsPerBranch));
    const productsPerBranch = Math.ceil(products / topLevelCategories);

    const cache = createCacheFromEnv();

    const generator = new BlueprintGenerator({
        totalProducts: products,
        topLevelCategories,
        productsPerBranch,
    });

    const blueprint = generator.generateBlueprint(salesChannelName, description);
    cache.saveBlueprint(salesChannelName, blueprint);

    const categoryCount = countCategories(blueprint.categories);
    return [
        `=== Blueprint Create ===`,
        `Name: ${salesChannelName}`,
        `Description: ${description}`,
        `Products: ${products} (${topLevelCategories} categories)`,
        ``,
        `Blueprint created:`,
        `  Categories: ${categoryCount}`,
        `  Products: ${blueprint.products.length}`,
        `  Saved to: generated/sales-channels/${salesChannelName}/blueprint.json`,
    ];
}

export async function hydrateBlueprint(
    salesChannelName: string,
    options: { only?: "categories" | "properties" | "cms"; force?: boolean }
): Promise<string[]> {
    const { only: hydrateOnly, force: forceHydration = false } = options;

    logger.configure({ minLevel: "debug" });

    const cache = createCacheFromEnv();
    const existingHydratedBlueprint = cache.loadHydratedBlueprint(salesChannelName);

    if (existingHydratedBlueprint && !hydrateOnly && !forceHydration) {
        return [
            `Error: Hydrated blueprint already exists for "${salesChannelName}". ` +
                `Re-hydrating will change product names and trigger image regeneration. ` +
                `Use --only=categories, --only=properties, or --rehydrate.`,
        ];
    }

    const blueprint = cache.loadBlueprint(salesChannelName);
    if (!blueprint) {
        return [
            `Error: No blueprint found for "${salesChannelName}". ` +
                `Run: blueprint create --name=${salesChannelName}`,
        ];
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
        }
    } catch {
        // Proceed without existing properties
    }

    // CMS-only hydration
    if (hydrateOnly === "cms") {
        const cmsBlueprint = generateCmsBlueprint(salesChannelName);
        const description = resolveCmsStoreDescription(
            salesChannelName,
            blueprint.salesChannel.description,
            existingHydratedBlueprint?.salesChannel.description
        );
        const hydratedCms = await hydrateCmsBlueprint(cmsBlueprint, textProvider, description);
        cache.saveCmsBlueprint(salesChannelName, hydratedCms);

        await hydrateCmsImages(imageProvider, cache, salesChannelName, description);

        return [
            `=== Blueprint Hydrate (cms only) ===`,
            `Name: ${salesChannelName}`,
            ``,
            `CMS blueprint hydrated:`,
            `  Pages: ${hydratedCms.pages.length}`,
            `  Saved to: generated/sales-channels/${salesChannelName}/cms-blueprint.json`,
        ];
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

    if (!hydrateOnly) {
        const cmsBlueprint = generateCmsBlueprint(salesChannelName);
        const description = resolveCmsStoreDescription(
            salesChannelName,
            blueprint.salesChannel.description,
            hydratedBlueprint.salesChannel.description
        );
        const hydratedCms = await hydrateCmsBlueprint(cmsBlueprint, textProvider, description);
        cache.saveCmsBlueprint(salesChannelName, hydratedCms);

        await hydrateCmsImages(imageProvider, cache, salesChannelName, description);

        if (imageProvider.name !== "noop") {
            await hydrateProductImages(imageProvider, cache, salesChannelName, hydratedBlueprint);

            const storeDescription =
                hydratedBlueprint.salesChannel.description ||
                blueprint.salesChannel.description ||
                `${salesChannelName} webshop`;
            await hydrateThemeMedia(
                imageProvider,
                cache,
                salesChannelName,
                storeDescription,
                hydratedBlueprint.brandColors
            );
        }
    }

    const collector = new PropertyCollector();
    const propertyGroups = collector.collectFromBlueprint(hydratedBlueprint, existingProperties);
    hydratedBlueprint.propertyGroups = propertyGroups;

    cache.saveHydratedBlueprint(salesChannelName, hydratedBlueprint);

    const results = [
        `=== Blueprint Hydrate ===`,
        `Name: ${salesChannelName}`,
        hydrateOnly
            ? `Mode: ${hydrateOnly} only`
            : forceHydration
              ? `Mode: full (--rehydrate)`
              : `Mode: full`,
        `Log file: ${logger.getLogFile()}`,
        ``,
        `Hydrated blueprint saved:`,
        `  Mode: ${hydrateOnly || "full"}`,
        `  Property groups: ${propertyGroups.length}`,
        `  Manufacturers: ${collector.collectManufacturers(hydratedBlueprint).length}`,
    ];

    if (hydratedBlueprint.brandColors) {
        results.push(
            `  Brand colors: ${hydratedBlueprint.brandColors.primary} / ${hydratedBlueprint.brandColors.secondary}`
        );
    }

    results.push(
        `  Saved to: generated/sales-channels/${salesChannelName}/hydrated-blueprint.json`
    );
    return results;
}

export async function fixBlueprint(salesChannelName: string): Promise<string[]> {
    logger.configure({ minLevel: "debug" });

    const cache = createCacheFromEnv();
    const blueprint = cache.loadHydratedBlueprint(salesChannelName);

    if (!blueprint) {
        return [
            `Error: No hydrated blueprint found for "${salesChannelName}". ` +
                `Run: blueprint hydrate --name=${salesChannelName}`,
        ];
    }

    const { text: textProvider } = createProvidersFromEnv();
    const hydrator = new BlueprintHydrator(textProvider);

    const placeholderCategories = hydrator.findPlaceholderCategories(blueprint.categories);
    const placeholderProducts = hydrator.findPlaceholderProducts(blueprint.products);

    if (placeholderCategories.length === 0 && placeholderProducts.length === 0) {
        return [
            `=== Blueprint Fix ===`,
            `Name: ${salesChannelName}`,
            ``,
            `No placeholders to fix. Blueprint is complete.`,
        ];
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

    return [
        `=== Blueprint Fix ===`,
        `Name: ${salesChannelName}`,
        ``,
        `Fixed blueprint saved:`,
        `  Categories fixed: ${placeholderCategories.length}`,
        `  Products fixed: ${placeholderProducts.length}`,
        `  Saved to: generated/sales-channels/${salesChannelName}/hydrated-blueprint.json`,
    ];
}

export function resolveCmsStoreDescription(
    salesChannelName: string,
    blueprintDescription?: string,
    hydratedDescription?: string
): string {
    const normalizedHydrated = hydratedDescription?.trim();
    if (normalizedHydrated) return normalizedHydrated;

    const normalizedBlueprint = blueprintDescription?.trim();
    if (normalizedBlueprint) return normalizedBlueprint;

    return `${salesChannelName} webshop`;
}
