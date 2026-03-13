/**
 * Image Fix Service - shared application logic for the image-fix command.
 *
 * Returns string[] (output lines) so both CLI (prints) and MCP (joins) can consume it.
 * Never calls console.log directly.
 */

import type { DataCache } from "../cache.js";
import type { HydratedBlueprint } from "../types/index.js";

import { hydrateThemeMedia } from "../blueprint/index.js";
import { DEFAULT_PROCESSOR_OPTIONS, runProcessors } from "../post-processors/index.js";
import { createProvidersFromEnv } from "../providers/index.js";
import { DataHydrator } from "../shopware/index.js";
import { createProcessorDeps } from "./shopware-context.js";

export const THEME_MEDIA_KEYS = ["store-logo", "store-favicon", "store-share"] as const;

export interface ImageFixUploadParams {
    salesChannelName: string;
    blueprint: HydratedBlueprint;
    cache: DataCache;
    processors: string;
}

export async function fixProductImages(
    salesChannelName: string,
    blueprint: HydratedBlueprint,
    cache: DataCache,
    target: string,
    dryRun: boolean
): Promise<string[]> {
    const searchTerm = target.toLowerCase();
    const product = blueprint.products.find(
        (p) => p.id === target || p.name.toLowerCase().includes(searchTerm)
    );

    if (!product) {
        const available = blueprint.products
            .slice(0, 5)
            .map((p) => `  - ${p.name}`)
            .join("\n");
        return [`Error: Product "${target}" not found\n\nAvailable (first 5):\n${available}`];
    }

    const imageDescriptions = product.metadata.imageDescriptions;
    if (imageDescriptions.length === 0) {
        return [`Error: Product "${product.name}" has no image descriptions`];
    }

    const results: string[] = [
        `=== Image Fix (product) ===`,
        `Product: ${product.name} (${product.id})`,
        `Images: ${imageDescriptions.length}`,
    ];

    if (dryRun) {
        results.push(`[DRY RUN] Would regenerate ${imageDescriptions.length} images`);
        return results;
    }

    const { image: imageProvider } = createProvidersFromEnv();

    for (const desc of imageDescriptions) {
        cache.images.deleteImageWithView(salesChannelName, product.id, desc.view, "product_media");
        const imageData = await imageProvider.generateImage(desc.prompt);
        if (!imageData) {
            results.push(`  ✗ Failed: ${desc.view}`);
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
        results.push(`  ✓ Generated: ${desc.view}`);
    }

    await uploadViaProcessors({
        salesChannelName,
        blueprint: { ...blueprint, products: [product] },
        cache,
        processors: "images",
    });
    results.push(`✓ Uploaded to Shopware`);
    return results;
}

export async function fixCategoryImages(
    salesChannelName: string,
    blueprint: HydratedBlueprint,
    cache: DataCache,
    target: string,
    dryRun: boolean
): Promise<string[]> {
    const searchTerm = target.toLowerCase();
    const allFlat = flattenCategories(blueprint.categories);
    const category = allFlat.find(
        (c) => c.id === target || c.name.toLowerCase().includes(searchTerm)
    );

    if (!category) {
        const available = allFlat
            .slice(0, 5)
            .map((c) => `  - ${c.name}`)
            .join("\n");
        return [`Error: Category "${target}" not found\n\nAvailable (first 5):\n${available}`];
    }

    const results: string[] = [
        `=== Image Fix (category) ===`,
        `Category: ${category.name} (${category.id})`,
    ];

    if (!category.imageDescription) {
        return [...results, `Error: Category "${category.name}" has no image description`];
    }

    if (dryRun) {
        results.push(`[DRY RUN] Would regenerate category banner`);
        return results;
    }

    const { image: imageProvider } = createProvidersFromEnv();
    cache.images.deleteImageWithView(salesChannelName, category.id, "banner", "category_media");
    const imageData = await imageProvider.generateImage(category.imageDescription);
    if (!imageData) {
        return [...results, `✗ Failed to generate`];
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
    results.push(`  ✓ Generated banner`);

    await uploadViaProcessors({ salesChannelName, blueprint, cache, processors: "images" });
    results.push(`✓ Uploaded to Shopware`);
    return results;
}

export async function fixCmsImages(
    salesChannelName: string,
    blueprint: HydratedBlueprint,
    cache: DataCache,
    target: string,
    dryRun: boolean
): Promise<string[]> {
    const searchTerm = target.toLowerCase();
    const results: string[] = [`=== Image Fix (cms) ===`, `Target: ${searchTerm}`];

    if (dryRun) {
        results.push(`[DRY RUN] Would regenerate CMS images matching "${searchTerm}"`);
        return results;
    }

    const processors = resolveCmsProcessors(searchTerm);
    if (processors.length === 0) {
        return [
            ...results,
            `Error: No CMS pages matching "${target}". Try: "home", "images", "text-images", or "all"`,
        ];
    }

    await uploadViaProcessors({
        salesChannelName,
        blueprint,
        cache,
        processors: processors.join(","),
    });
    results.push(`✓ Processed: ${processors.join(", ")}`);
    return results;
}

export async function fixThemeImages(
    salesChannelName: string,
    blueprint: HydratedBlueprint,
    cache: DataCache,
    target: string | undefined,
    dryRun: boolean
): Promise<string[]> {
    const resolvedTarget = (target || "all").toLowerCase();
    const keysToRegenerate =
        resolvedTarget === "all"
            ? [...THEME_MEDIA_KEYS]
            : THEME_MEDIA_KEYS.filter(
                  (k) => k === resolvedTarget || k === `store-${resolvedTarget}`
              );

    if (keysToRegenerate.length === 0) {
        return [
            `Error: No theme media matching "${target}". Available: ${THEME_MEDIA_KEYS.join(", ")}, or "all"`,
        ];
    }

    const results: string[] = [
        `=== Image Fix (theme) ===`,
        `SalesChannel: ${salesChannelName}`,
        `Target: ${keysToRegenerate.join(", ")}`,
    ];

    if (dryRun) {
        results.push(`[DRY RUN] Would regenerate ${keysToRegenerate.length} theme image(s)`);
        return results;
    }

    for (const key of keysToRegenerate) {
        cache.images.deleteImageForSalesChannel(salesChannelName, key, "theme_media");
        results.push(`  Deleted cached: ${key}`);
    }

    const { image: imageProvider } = createProvidersFromEnv();
    const storeDescription = blueprint.salesChannel.description || `${salesChannelName} webshop`;

    const result = await hydrateThemeMedia(
        imageProvider,
        cache,
        salesChannelName,
        storeDescription,
        blueprint.brandColors
    );

    results.push(
        `  Generated: ${result.generated}, Skipped: ${result.skipped}, Failed: ${result.failed}`
    );

    await uploadViaProcessors({ salesChannelName, blueprint, cache, processors: "theme" });
    results.push(`✓ Uploaded to Shopware`);
    return results;
}

// =============================================================================
// Internal helpers
// =============================================================================

export function flattenCategories(
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

export function resolveCmsProcessors(searchTerm: string): string[] {
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

async function uploadViaProcessors(params: ImageFixUploadParams): Promise<void> {
    const swEnvUrl = process.env.SW_ENV_URL;
    if (!swEnvUrl) throw new Error("SW_ENV_URL is required");

    const dataHydrator = new DataHydrator();
    await dataHydrator.authenticateWithClientCredentials(
        swEnvUrl,
        process.env.SW_CLIENT_ID,
        process.env.SW_CLIENT_SECRET
    );

    const salesChannel = await dataHydrator.findSalesChannelByName(params.salesChannelName);
    if (!salesChannel) {
        throw new Error(`SalesChannel "${params.salesChannelName}" not found`);
    }

    const deps = createProcessorDeps({
        baseURL: swEnvUrl,
        getAccessToken: () => dataHydrator.getAccessToken(),
        clientId: process.env.SW_CLIENT_ID,
        clientSecret: process.env.SW_CLIENT_SECRET,
    });

    await runProcessors(
        {
            salesChannelId: salesChannel.id,
            salesChannelName: params.salesChannelName,
            blueprint: params.blueprint,
            cache: params.cache,
            textProvider: deps.textProvider,
            imageProvider: deps.imageProvider,
            api: deps.apiHelpers,
            options: { ...DEFAULT_PROCESSOR_OPTIONS, dryRun: false },
        },
        params.processors.split(",")
    );
}
