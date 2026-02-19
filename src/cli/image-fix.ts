/**
 * Image fix CLI command: regenerate images for products, categories, or CMS pages.
 */

import type { HydratedBlueprint } from "../types/index.js";
import type { CliArgs } from "./shared.js";

import { createCacheFromEnv } from "../cache.js";
import { createProvidersFromEnv } from "../providers/index.js";
import { DataHydrator } from "../shopware/index.js";
import {
    CLIError,
    executePostProcessors,
    requireHydratedBlueprint,
    requireValidName,
} from "./shared.js";

type ImageFixType = "product" | "category" | "cms";

export async function imageFixCommand(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);
    const fixType = (args.type as ImageFixType) || "product";

    if (!["product", "category", "cms"].includes(fixType)) {
        throw new CLIError(
            `--type must be 'product', 'category', or 'cms' (got: ${fixType})`,
            "INVALID_OPTION"
        );
    }

    if (!args.product) {
        throw new CLIError(
            `--product is required (${fixType === "cms" ? "CMS page name" : `${fixType} name or ID`})`,
            "MISSING_ARG"
        );
    }

    console.log(`\n=== Image Fix (${fixType}) ===`);
    console.log(`SalesChannel: ${salesChannelName}`);
    console.log(`Target: ${args.product}`);
    console.log();

    if (fixType === "product") {
        await fixProductImages(salesChannelName, args);
    } else if (fixType === "category") {
        await fixCategoryImages(salesChannelName, args);
    } else {
        await fixCmsImages(salesChannelName, args);
    }
}

async function fixProductImages(salesChannelName: string, args: CliArgs): Promise<void> {
    const cache = createCacheFromEnv();
    const blueprint = requireHydratedBlueprint(cache, salesChannelName);

    const searchTerm = args.product!.toLowerCase();
    const product = blueprint.products.find(
        (p) => p.id === args.product || p.name.toLowerCase().includes(searchTerm)
    );

    if (!product) {
        const available = blueprint.products
            .slice(0, 10)
            .map((p) => p.name)
            .join(", ");
        throw new CLIError(
            `Product "${args.product}" not found. Available: ${available}...`,
            "PRODUCT_NOT_FOUND"
        );
    }

    console.log(`Found product: ${product.name} (${product.id})`);

    const imageDescriptions = product.metadata.imageDescriptions;
    if (imageDescriptions.length === 0) {
        throw new CLIError("Product has no image descriptions", "NO_IMAGE_DESCRIPTIONS");
    }

    console.log(`Images to generate: ${imageDescriptions.length}`);
    for (const desc of imageDescriptions) {
        console.log(`  - ${desc.view}: ${desc.prompt.substring(0, 50)}...`);
    }

    if (args.dryRun) {
        console.log("\n[DRY RUN] Would generate and upload images");
        return;
    }

    const { image: imageProvider } = createProvidersFromEnv();

    for (const desc of imageDescriptions) {
        console.log(`Generating ${desc.view} image...`);
        cache.images.deleteImageWithView(salesChannelName, product.id, desc.view, "product_media");

        const imageData = await imageProvider.generateImage(desc.prompt);
        if (!imageData) {
            console.error(`  ✗ Failed to generate ${desc.view} image`);
            continue;
        }

        cache.images.saveImageWithView(
            salesChannelName,
            product.id,
            desc.view,
            imageData,
            desc.prompt,
            undefined,
            "product_media"
        );
        console.log(`  ✓ Generated and cached ${desc.view} image`);
    }

    console.log(`\nUploading to Shopware...`);
    await uploadViaProcessor(
        salesChannelName,
        { ...blueprint, products: [product] },
        cache,
        "images"
    );
}

async function fixCategoryImages(salesChannelName: string, args: CliArgs): Promise<void> {
    const cache = createCacheFromEnv();
    const blueprint = requireHydratedBlueprint(cache, salesChannelName);

    const searchTerm = args.product!.toLowerCase();
    const allFlat = flattenCategories(blueprint.categories);
    const category = allFlat.find(
        (c) => c.id === args.product || c.name.toLowerCase().includes(searchTerm)
    );

    if (!category) {
        const available = allFlat
            .slice(0, 10)
            .map((c) => c.name)
            .join(", ");
        throw new CLIError(
            `Category "${args.product}" not found. Available: ${available}...`,
            "CATEGORY_NOT_FOUND"
        );
    }

    console.log(`Found category: ${category.name} (${category.id})`);

    if (!category.imageDescription) {
        throw new CLIError("Category has no image description", "NO_IMAGE_DESCRIPTIONS");
    }

    if (args.dryRun) {
        console.log(`[DRY RUN] Would regenerate category banner image`);
        return;
    }

    const { image: imageProvider } = createProvidersFromEnv();

    console.log(`Generating category banner...`);
    cache.images.deleteImageWithView(salesChannelName, category.id, "banner", "category_media");

    const imageData = await imageProvider.generateImage(category.imageDescription);
    if (!imageData) {
        throw new CLIError("Failed to generate category image", "IMAGE_GENERATION_FAILED");
    }

    cache.images.saveImageWithView(
        salesChannelName,
        category.id,
        "banner",
        imageData,
        category.imageDescription,
        undefined,
        "category_media"
    );
    console.log(`  ✓ Generated and cached category banner`);

    console.log(`\nUploading to Shopware...`);
    await uploadViaProcessor(salesChannelName, blueprint, cache, "images");
}

async function fixCmsImages(salesChannelName: string, args: CliArgs): Promise<void> {
    const cache = createCacheFromEnv();
    const blueprint = requireHydratedBlueprint(cache, salesChannelName);

    const searchTerm = args.product!.toLowerCase();
    console.log(`Regenerating CMS images matching "${searchTerm}"...`);

    const processors = resolveCmsProcessors(searchTerm);
    if (processors.length === 0) {
        console.log(
            `No matching CMS pages/processors. Try: "Home Listing", "Image Elements", "Text & Images", or "all"`
        );
        return;
    }

    // Delete matching CMS images from cache
    const cmsDir = cache.images.getCmsImagesDir(salesChannelName);
    const { readdirSync, unlinkSync, existsSync } = await import("node:fs");
    const imageKeyPrefixes = getCmsImageKeyPrefixes(processors);

    if (existsSync(cmsDir)) {
        const files = readdirSync(cmsDir);
        const matching = files.filter((f) =>
            imageKeyPrefixes.some((prefix) => f.toLowerCase().startsWith(prefix))
        );
        for (const file of matching) {
            unlinkSync(`${cmsDir}/${file}`);
            console.log(`  Deleted cached: ${file}`);
        }
    }

    if (args.dryRun) {
        console.log(`\n[DRY RUN] Would regenerate and upload CMS images`);
        return;
    }

    console.log(`\nRunning processors: ${processors.join(", ")}...`);
    await uploadViaProcessor(salesChannelName, blueprint, cache, processors.join(","));
}

async function uploadViaProcessor(
    salesChannelName: string,
    blueprint: HydratedBlueprint,
    cache: ReturnType<typeof createCacheFromEnv>,
    processors: string
): Promise<void> {
    const swEnvUrl = process.env.SW_ENV_URL;
    if (!swEnvUrl) {
        throw new CLIError("SW_ENV_URL environment variable is required", "MISSING_ENV");
    }

    const dataHydrator = new DataHydrator();
    await dataHydrator.authenticateWithClientCredentials(
        swEnvUrl,
        process.env.SW_CLIENT_ID,
        process.env.SW_CLIENT_SECRET
    );

    const salesChannel = await dataHydrator.findSalesChannelByName(salesChannelName);
    if (!salesChannel) {
        throw new CLIError(
            `SalesChannel "${salesChannelName}" not found in Shopware`,
            "SALESCHANNEL_NOT_FOUND"
        );
    }

    const { totalProcessed, totalErrors } = await executePostProcessors({
        salesChannelId: salesChannel.id,
        salesChannelName,
        blueprint,
        cache,
        swEnvUrl,
        getAccessToken: () => dataHydrator.getAccessToken(),
        processors: processors.split(","),
        dryRun: false,
    });

    console.log(`\n=== Image Fix Complete ===`);
    console.log(`Processed: ${totalProcessed}, Errors: ${totalErrors}`);
}

function flattenCategories(
    categories: HydratedBlueprint["categories"]
): HydratedBlueprint["categories"] {
    const result: HydratedBlueprint["categories"] = [];
    for (const cat of categories) {
        result.push(cat);
        if (cat.children.length > 0) {
            result.push(...flattenCategories(cat.children));
        }
    }
    return result;
}

function resolveCmsProcessors(searchTerm: string): string[] {
    if (searchTerm === "all" || searchTerm === "cms") {
        return ["cms-home", "cms-images", "cms-text-images"];
    }

    const selected = new Set<string>();

    if (searchTerm.includes("home") || searchTerm.includes("listing")) {
        selected.add("cms-home");
    }

    if (
        searchTerm.includes("text & images") ||
        searchTerm.includes("text-images") ||
        (searchTerm.includes("text") && searchTerm.includes("image"))
    ) {
        selected.add("cms-text-images");
    }

    if (
        searchTerm.includes("image elements") ||
        searchTerm === "images" ||
        searchTerm === "cms-images"
    ) {
        selected.add("cms-images");
    }

    return Array.from(selected);
}

function getCmsImageKeyPrefixes(processors: string[]): string[] {
    const prefixes = new Set<string>();
    for (const processor of processors) {
        if (processor === "cms-home") {
            prefixes.add("home-hero");
        }
        if (processor === "cms-images") {
            prefixes.add("img-slider-");
            prefixes.add("img-gallery-");
        }
        if (processor === "cms-text-images") {
            prefixes.add("ti-");
            prefixes.add("ct-");
            prefixes.add("bubble-");
            prefixes.add("toi-");
        }
    }
    return Array.from(prefixes);
}
