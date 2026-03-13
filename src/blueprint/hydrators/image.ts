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

import sharp from "sharp";

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

// =============================================================================
// Theme Media Hydration
// =============================================================================

interface ThemeImageSpec {
    key: string;
    prompt: string;
    width: number;
    height: number;
    transparent?: boolean;
    fitHeight?: boolean;
}

export interface ThemeMediaHydrationResult {
    generated: number;
    skipped: number;
    failed: number;
    total: number;
}

/**
 * Strip the SalesChannel name prefix from descriptions when present.
 * Descriptions sometimes start with "{storeName} is your ..." —
 * we want just the product/category description for image prompts.
 */
function cleanStoreDescription(storeName: string, description: string): string {
    const cleaned = description
        .replace(new RegExp(`^${storeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"), "")
        .replace(/^is\s+(your\s+)?(one-stop\s+)?(shop|store|destination)\s+(for|of)\s+/i, "")
        .trim();

    return cleaned || description;
}

export function buildThemeImageSpecs(
    storeName: string,
    storeDescription: string,
    brandColors?: { primary: string; secondary: string }
): ThemeImageSpec[] {
    const colorHint = brandColors
        ? `Use brand colors: primary ${brandColors.primary}, secondary ${brandColors.secondary}.`
        : "";

    // Build a human-readable display name for use in logo prompts.
    // Two classes of segments are stripped before title-casing:
    //   • Leading technical prefixes: "e2e", "test" — never part of a real brand
    //   • Trailing all-digit segment of 8+ chars — Unix timestamps from scripts
    //     like `name-$(date +%s)`. Short numbers like "54" or "360" are kept.
    const segments = storeName.split("-");
    const LEADING_NOISE = new Set(["e2e", "test"]);
    let start = 0;
    while (start < segments.length && LEADING_NOISE.has(segments[start]!.toLowerCase())) {
        start++;
    }
    const trimmed = segments
        .slice(start)
        .filter((w, i, arr) => !(i === arr.length - 1 && /^\d{8,}$/.test(w)));
    const displayName = (trimmed.length > 0 ? trimmed : segments)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");

    const productDescription = cleanStoreDescription(storeName, storeDescription);

    return [
        {
            key: "store-logo",
            prompt: [
                `A compact logo for "${displayName}" — an online store selling ${productDescription}.`,
                `The logo MUST include the text "${displayName}" as the main element.`,
                `Small icon or symbol next to the store name. Compact landscape format, tightly cropped with no padding.`,
                colorHint,
                `Flat vector style, transparent background, no photorealism. Looks good at 237x35px.`,
            ]
                .filter(Boolean)
                .join(" "),
            width: 474,
            height: 70,
            transparent: true,
            fitHeight: true,
        },
        {
            key: "store-favicon",
            prompt: [
                `A bold, simple favicon icon for an online store selling ${productDescription}.`,
                `Single flat-design shape representing the store category.`,
                `Must be recognizable at 32x32px — no fine details, no text.`,
                colorHint,
                `Clean silhouette on transparent background, vector-style.`,
            ]
                .filter(Boolean)
                .join(" "),
            width: 96,
            height: 96,
            transparent: true,
        },
        {
            key: "store-share",
            prompt: [
                `A social media sharing card for an online store selling ${productDescription}.`,
                `Wide 1.91:1 format showing an appealing lifestyle scene of the products.`,
                colorHint,
                `Eye-catching, brand-appropriate, professional e-commerce photography. No text overlay.`,
            ]
                .filter(Boolean)
                .join(" "),
            width: 1200,
            height: 630,
        },
    ];
}

interface TrimAndResizeOptions {
    transparent?: boolean;
    fitHeight?: boolean;
}

/**
 * Trim whitespace from an AI-generated image and resize to target dimensions.
 *
 * AI image generators (e.g. OpenAI) only support fixed canvas sizes like 1536x1024,
 * so a logo requested at 474x70 gets centered in a huge white canvas. This function
 * trims the white border and resizes to the exact target dimensions.
 *
 * When `transparent` is true, outputs PNG with transparent background (for logos/favicons).
 * When `fitHeight` is true, resizes to target height only (width scales proportionally) —
 * ideal for logos where the storefront CSS handles width.
 */
export async function trimAndResize(
    base64: string,
    targetWidth: number,
    targetHeight: number,
    options: TrimAndResizeOptions | boolean = false
): Promise<string> {
    const opts: TrimAndResizeOptions =
        typeof options === "boolean" ? { transparent: options } : options;

    try {
        const buffer = Buffer.from(base64, "base64");
        const trimmed = await sharp(buffer).trim().toBuffer();
        const background = opts.transparent
            ? { r: 0, g: 0, b: 0, alpha: 0 }
            : { r: 255, g: 255, b: 255, alpha: 1 };

        const resizeOptions = opts.fitHeight
            ? { height: targetHeight, withoutEnlargement: false }
            : { width: targetWidth, height: targetHeight, fit: "contain" as const, background };

        let pipeline = sharp(trimmed).resize(resizeOptions);
        pipeline = opts.transparent ? pipeline.png() : pipeline.webp();
        const resized = await pipeline.toBuffer();
        return resized.toString("base64");
    } catch {
        return base64;
    }
}

export async function hydrateThemeMedia(
    imageProvider: ImageProvider,
    cache: DataCache,
    salesChannelName: string,
    storeDescription: string,
    brandColors?: { primary: string; secondary: string }
): Promise<ThemeMediaHydrationResult> {
    const specs = buildThemeImageSpecs(salesChannelName, storeDescription, brandColors);
    const result: ThemeMediaHydrationResult = {
        generated: 0,
        skipped: 0,
        failed: 0,
        total: specs.length,
    };

    const pending = specs.filter(
        (spec) => !cache.images.hasImageForSalesChannel(salesChannelName, spec.key, "theme_media")
    );

    result.skipped = specs.length - pending.length;

    if (pending.length === 0) {
        logger.info(`  Theme media: all ${specs.length} already cached`, { cli: true });
        return result;
    }

    logger.info(
        `  Theme media: generating ${pending.length}/${specs.length} (${result.skipped} cached)`,
        { cli: true }
    );

    const limiter = new ConcurrencyLimiter(imageProvider.maxConcurrency);

    await limiter.all(
        pending.map((spec) => async () => {
            try {
                const base64 = await executeWithRetry(
                    async () => {
                        const data = await imageProvider.generateImage(spec.prompt, {
                            width: spec.width,
                            height: spec.height,
                        });
                        if (!data) throw new Error("Image generation returned null");
                        return data;
                    },
                    { maxRetries: 3, baseDelay: 5000 }
                );

                const processed = await trimAndResize(base64, spec.width, spec.height, {
                    transparent: spec.transparent,
                    fitHeight: spec.fitHeight,
                });

                cache.images.saveImageForSalesChannel(
                    salesChannelName,
                    spec.key,
                    spec.key,
                    processed,
                    spec.prompt,
                    undefined,
                    "theme_media"
                );
                result.generated++;
            } catch {
                result.failed++;
                logger.warn(`    Failed to generate theme image "${spec.key}"`);
            }
        })
    );

    logger.info(`  Theme media: ${result.generated} generated, ${result.failed} failed`, {
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

    // Product images from the in-memory blueprint metadata.
    // We intentionally do NOT load from cache.loadProductMetadata here because
    // saveHydratedBlueprint (which writes the metadata files) is called AFTER
    // hydrateProductImages in blueprint-service.ts. Reading from the blueprint
    // directly avoids the ordering dependency.
    for (const product of blueprint.products) {
        const { metadata } = product;
        if (!metadata.imageDescriptions || metadata.imageDescriptions.length === 0) continue;

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
