/**
 * Image Hydrator - Pre-generates ALL images during blueprint hydration
 *
 * Two categories of images:
 * 1. CMS images (20 fixed): slider, gallery, text-image blocks, home hero
 * 2. Product/category images (variable): multi-view product photos + category banners
 *
 * All images are cached locally. Post-processors only read from cache and upload
 * to Shopware -- no AI calls at post-processing time.
 */

import type { DataCache } from "../../cache.js";
import type { HydratedBlueprint, ImageProvider } from "../../types/index.js";

import {
    buildImagePrompt,
    ConcurrencyLimiter,
    executeWithRetry,
    logger,
} from "../../utils/index.js";
import { flattenCategories } from "./category.js";

interface CmsImageSpec {
    key: string;
    prompt: string;
    width: number;
    height: number;
}

/**
 * Build all CMS image specs for a given store.
 *
 * Prompt templates use `storeDescription` to make images store-specific.
 * The home hero also uses `storeName` for a branded feel.
 */
export function buildCmsImageSpecs(storeName: string, storeDescription: string): CmsImageSpec[] {
    return [
        // ── Home hero ────────────────────────────────────────────────────
        {
            key: "home-hero",
            prompt: [
                `A vibrant, eye-catching promotional banner image for a ${storeName} online store.`,
                `The store sells: ${storeDescription}.`,
                `Show an artistic collage or lifestyle scene representing the products.`,
                `Bold, modern design with warm lighting. No text overlay.`,
            ].join(" "),
            width: 800,
            height: 800,
        },

        // ── Image Elements page – slider (5 landscape banners) ───────────
        ...Array.from({ length: 5 }, (_, i) => ({
            key: `img-slider-${i}`,
            prompt: `Professional product showcase photo for a ${storeDescription}. Slide ${i + 1} of 5. Clean, modern e-commerce banner image. High quality, well-lit, no text overlays.`,
            width: 1920,
            height: 1080,
        })),

        // ── Image Elements page – gallery (6 square photos) ──────────────
        ...Array.from({ length: 6 }, (_, i) => ({
            key: `img-gallery-${i}`,
            prompt: `Product gallery photo for a ${storeDescription}. Gallery item ${i + 1} of 6. Clean product photography on neutral background. Square format, centered composition.`,
            width: 1200,
            height: 1200,
        })),

        // ── Text & Images page – image-text blocks (2 images) ────────────
        {
            key: "ti-left",
            prompt: `Lifestyle product photo for a ${storeDescription}. Clean, modern composition suitable for a side-by-side text-image layout. Well-lit, professional.`,
            width: 960,
            height: 960,
        },
        {
            key: "ti-right",
            prompt: `Detail product shot for a ${storeDescription}. Close-up or angled view showing quality and craftsmanship. Clean background, professional lighting.`,
            width: 960,
            height: 960,
        },

        // ── Text & Images page – center-text flanking images (2 images) ──
        {
            key: "ct-left",
            prompt: `Artistic product photo for a ${storeDescription}. Compact square format, suitable as a decorative flanking image. Warm tones, inviting.`,
            width: 640,
            height: 640,
        },
        {
            key: "ct-right",
            prompt: `Creative product arrangement for a ${storeDescription}. Compact square format, complementary to a central text block. Professional, appealing.`,
            width: 640,
            height: 640,
        },

        // ── Text & Images page – bubble feature images (3 images) ────────
        ...["left", "center", "right"].map((position, i) => ({
            key: `bubble-${position}`,
            prompt: `Feature highlight photo for a ${storeDescription}. Feature ${i + 1} of 3. Square format, icon-like quality, clean and modern.`,
            width: 640,
            height: 640,
        })),

        // ── Text & Images page – text-on-image background (1 image) ─────
        {
            key: "toi-bg",
            prompt: `Wide atmospheric banner photo for a ${storeDescription}. Suitable as a text overlay background. Slightly dark or blurred, moody lighting, wide 16:9 format.`,
            width: 1920,
            height: 1080,
        },
    ];
}

export interface CmsImageHydrationResult {
    generated: number;
    skipped: number;
    failed: number;
    total: number;
}

/**
 * Pre-generate all CMS images and save to local cache.
 *
 * Called during `blueprint hydrate` (full or --only=cms mode).
 * Skips images already in cache. Uses ConcurrencyLimiter to respect
 * the image provider's rate limits.
 */
export async function hydrateCmsImages(
    imageProvider: ImageProvider,
    cache: DataCache,
    salesChannelName: string,
    storeDescription: string
): Promise<CmsImageHydrationResult> {
    const specs = buildCmsImageSpecs(salesChannelName, storeDescription);
    const result: CmsImageHydrationResult = {
        generated: 0,
        skipped: 0,
        failed: 0,
        total: specs.length,
    };

    // Filter to only specs that need generation
    const pending = specs.filter(
        (spec) => !cache.images.hasImageForSalesChannel(salesChannelName, spec.key, "cms_media")
    );

    result.skipped = specs.length - pending.length;

    if (pending.length === 0) {
        logger.info(`  CMS images: all ${specs.length} already cached`, { cli: true });
        return result;
    }

    logger.info(
        `  CMS images: generating ${pending.length}/${specs.length} (${result.skipped} cached)`,
        { cli: true }
    );

    const limiter = new ConcurrencyLimiter(imageProvider.maxConcurrency);

    await limiter.all(
        pending.map((spec) => async () => {
            const base64 = await imageProvider.generateImage(spec.prompt, {
                width: spec.width,
                height: spec.height,
            });

            if (!base64) {
                result.failed++;
                logger.warn(`    Failed to generate CMS image "${spec.key}"`);
                return;
            }

            cache.images.saveImageForSalesChannel(
                salesChannelName,
                spec.key,
                spec.key,
                base64,
                spec.prompt,
                undefined,
                "cms_media"
            );
            result.generated++;
        })
    );

    logger.info(`  CMS images: ${result.generated} generated, ${result.failed} failed`, {
        cli: true,
    });

    return result;
}

// =============================================================================
// Product & Category Image Hydration
// =============================================================================

export interface ProductImageHydrationResult {
    generated: number;
    skipped: number;
    failed: number;
    stale: number;
    total: number;
}

interface ImageTask {
    type: "product" | "category";
    id: string;
    name: string;
    view: string;
    prompt: string;
}

/**
 * Pre-generate product and category images from the hydrated blueprint.
 *
 * Called during `blueprint hydrate` after text hydration completes (needs
 * product metadata in cache). Handles staleness detection: if a product's
 * baseImagePrompt changed (e.g. after re-hydration), stale images are
 * deleted and regenerated.
 */
export async function hydrateProductImages(
    imageProvider: ImageProvider,
    cache: DataCache,
    salesChannelName: string,
    blueprint: HydratedBlueprint
): Promise<ProductImageHydrationResult> {
    const result: ProductImageHydrationResult = {
        generated: 0,
        skipped: 0,
        failed: 0,
        stale: 0,
        total: 0,
    };

    const imageTasks = collectImageTasks(cache, salesChannelName, blueprint, result);
    result.total = imageTasks.length + result.skipped;

    if (imageTasks.length === 0) {
        logger.info(`  Product images: all ${result.total} already cached`, { cli: true });
        return result;
    }

    logger.info(
        `  Product images: generating ${imageTasks.length}/${result.total} (${result.skipped} cached, ${result.stale} stale)`,
        { cli: true }
    );

    const limiter = new ConcurrencyLimiter(imageProvider.maxConcurrency);

    await limiter.all(
        imageTasks.map((task) => async () => {
            try {
                const base64 = await executeWithRetry(
                    async () => {
                        const data = await imageProvider.generateImage(task.prompt);
                        if (!data) throw new Error("Image generation returned null");
                        return data;
                    },
                    { maxRetries: 3, baseDelay: 5000 }
                );

                const mediaType = task.type === "category" ? "category_media" : "product_media";
                cache.images.saveImageWithView(
                    salesChannelName,
                    task.id,
                    task.view,
                    base64,
                    task.prompt,
                    imageProvider.name,
                    mediaType
                );
                result.generated++;
            } catch {
                result.failed++;
                logger.warn(
                    `    Failed to generate ${task.type} image: ${task.name} (${task.view})`
                );
            }
        })
    );

    logger.info(`  Product images: ${result.generated} generated, ${result.failed} failed`, {
        cli: true,
    });

    return result;
}

function collectImageTasks(
    cache: DataCache,
    salesChannelName: string,
    blueprint: HydratedBlueprint,
    result: ProductImageHydrationResult
): ImageTask[] {
    const tasks: ImageTask[] = [];

    // Product images from metadata
    for (const product of blueprint.products) {
        const metadata = cache.loadProductMetadata(salesChannelName, product.id);
        if (!metadata || metadata.imageDescriptions.length === 0) continue;

        for (const desc of metadata.imageDescriptions) {
            const hasImage = cache.images.hasImageWithView(
                salesChannelName,
                product.id,
                desc.view,
                "product_media"
            );

            if (!hasImage) {
                const prompt = metadata.baseImagePrompt
                    ? buildImagePrompt(metadata.baseImagePrompt, desc.view)
                    : desc.prompt;
                tasks.push({
                    type: "product",
                    id: product.id,
                    name: product.name,
                    view: desc.view,
                    prompt,
                });
                continue;
            }

            // Staleness check: prompt mismatch means product name changed
            const basePrompt = metadata.baseImagePrompt || product.name;
            const isStale = cache.images.isImageStale(
                salesChannelName,
                product.id,
                desc.view,
                basePrompt,
                "product_media"
            );

            if (isStale) {
                cache.images.deleteImageWithView(
                    salesChannelName,
                    product.id,
                    desc.view,
                    "product_media"
                );
                result.stale++;
                const prompt = metadata.baseImagePrompt
                    ? buildImagePrompt(metadata.baseImagePrompt, desc.view)
                    : desc.prompt;
                tasks.push({
                    type: "product",
                    id: product.id,
                    name: product.name,
                    view: desc.view,
                    prompt,
                });
            } else {
                result.skipped++;
            }
        }
    }

    // Category banner images
    const categories = flattenCategories(blueprint.categories);
    for (const category of categories) {
        if (!category.hasImage || !category.imageDescription) continue;

        const hasImage = cache.images.hasImageWithView(
            salesChannelName,
            category.id,
            "banner",
            "category_media"
        );

        if (hasImage) {
            result.skipped++;
        } else {
            tasks.push({
                type: "category",
                id: category.id,
                name: category.name,
                view: "banner",
                prompt: category.imageDescription,
            });
        }
    }

    return tasks;
}
