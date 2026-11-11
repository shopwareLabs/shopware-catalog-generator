/**
 * Variant colour images - recolour the parent product images once per colour variant.
 *
 * The parent images show the default colour (first colour variant). Every other colour
 * gets an edited copy of each parent view, so a variant shows its own colour in the
 * storefront. This needs an image provider that can edit images (`editImage`); providers
 * without it are skipped with one warning, the variants then use the parent images.
 *
 * Cache layout: `product_media/{productId}-{view}--{shade-slug}.webp` plus `.json` with the
 * shade, hex and a hash of the source image. A changed parent image makes them stale.
 */

import { createHash } from "node:crypto";

import type { DataCache } from "../../cache.js";
import type {
    BlueprintProduct,
    HydratedBlueprint,
    ImageProvider,
    VariantColor,
    VariantSettings,
} from "../../types/index.js";

import {
    compressImage,
    ConcurrencyLimiter,
    createShortHash,
    executeWithRetry,
    logger,
    toKebabCase,
} from "../../utils/index.js";

/** Env var that limits colour images to the first (cover) view */
export const VARIANT_IMAGE_VIEWS_ENV = "VARIANT_IMAGE_VIEWS";

/** Which parent views get a colour copy: every view, or only the cover (first) one */
export type VariantImageViews = "all" | "cover";

/** Separator between the parent view and the shade slug in the cached view name */
export const SHADE_VIEW_SEPARATOR = "--";

export const NO_EDIT_SUPPORT_WARNING =
    "Colour images need image editing (OpenAI). This image provider cannot recolour an " +
    "existing image, so variants use the parent images.";

export interface VariantImageTask {
    productId: string;
    productName: string;
    /** Parent view the colour image is made from, e.g. "front" */
    sourceView: string;
    /** Cached view name, e.g. "front--burgundy" */
    view: string;
    color: VariantColor;
}

export interface VariantImagePlan {
    /** Tasks whose colour image is missing or stale */
    pending: VariantImageTask[];
    /** Colour images that are cached and match their source image */
    fresh: number;
    /** Cached colour images whose source image changed */
    stale: VariantImageTask[];
    /** Tasks skipped because the parent image is not cached yet */
    missingSource: number;
}

export interface VariantImageHydrationResult {
    generated: number;
    skipped: number;
    stale: number;
    failed: number;
    missingSource: number;
    total: number;
    /** False when the provider cannot edit images and the pass was skipped */
    supported: boolean;
}

/** Read VARIANT_IMAGE_VIEWS: "cover" limits colour images to the first view, anything else is "all" */
export function resolveVariantImageViews(
    env: Record<string, string | undefined>
): VariantImageViews {
    return env[VARIANT_IMAGE_VIEWS_ENV]?.trim().toLowerCase() === "cover" ? "cover" : "all";
}

/** Stable, file-safe slug for a shade name (falls back to a hash for non-ASCII names) */
export function shadeSlug(shade: string): string {
    return toKebabCase(shade) || `shade-${createShortHash(shade.toLowerCase(), 6)}`;
}

/** Cached view name of a colour image: "front" + "Burgundy" -> "front--burgundy" */
export function variantImageView(sourceView: string, shade: string): string {
    return `${sourceView}${SHADE_VIEW_SEPARATOR}${shadeSlug(shade)}`;
}

/** Prompt that recolours the product and keeps everything else */
export function buildRecolorPrompt(color: VariantColor): string {
    const target = color.hex ? `${color.name} (${color.hex})` : color.name;
    return [
        `Recolour the product to ${target}.`,
        `Keep shape, materials, logo, background, lighting and packaging layout identical.`,
        `Only the product's main colour changes.`,
    ].join(" ");
}

/** Short hash of an image, stored with each colour image to detect a changed source */
export function hashImage(base64: string): string {
    return createHash("sha256").update(base64).digest("hex").slice(0, 16);
}

/** Parent views of a product that get colour copies */
function productViews(product: BlueprintProduct, views: VariantImageViews): string[] {
    const all = (product.metadata.imageDescriptions ?? []).map((d) => d.view);
    return views === "cover" ? all.slice(0, 1) : all;
}

/** All colour images a hydrated blueprint needs (every colour except the default one) */
export function collectVariantImageTasks(
    blueprint: Pick<HydratedBlueprint, "products">,
    views: VariantImageViews
): VariantImageTask[] {
    return blueprint.products.flatMap((product) => {
        const colors = product.metadata.variantColors?.slice(1) ?? [];
        return productViews(product, views).flatMap((sourceView) =>
            colors.map((color) => ({
                productId: product.id,
                productName: product.name,
                sourceView,
                view: variantImageView(sourceView, color.name),
                color,
            }))
        );
    });
}

/**
 * Forecast count before text hydration: products without colours yet count as
 * `settings.colors - 1` colours (upper bound, not every variant product has a colour group).
 */
export function countVariantImages(
    blueprint: Pick<HydratedBlueprint, "products">,
    settings: VariantSettings,
    views: VariantImageViews
): number {
    return blueprint.products.reduce((acc, product) => {
        const colors = product.metadata.variantColors
            ? product.metadata.variantColors.length - 1
            : product.metadata.isVariant && !product.metadata.variantConfigs
              ? settings.colors - 1
              : 0;
        return acc + Math.max(0, colors) * productViews(product, views).length;
    }, 0);
}

/** Split the tasks into pending, fresh and stale by comparing the stored source hash */
export function planVariantImages(
    cache: DataCache,
    salesChannelName: string,
    blueprint: Pick<HydratedBlueprint, "products">,
    views: VariantImageViews
): VariantImagePlan {
    const plan: VariantImagePlan = { pending: [], fresh: 0, stale: [], missingSource: 0 };
    const sourceHashes = new Map<string, string | null>();
    const sourceHashOf = (task: VariantImageTask): string | null => {
        const key = `${task.productId}-${task.sourceView}`;
        if (!sourceHashes.has(key)) {
            const source = cache.images.loadImageWithView(
                salesChannelName,
                task.productId,
                task.sourceView,
                "product_media"
            );
            sourceHashes.set(key, source ? hashImage(source) : null);
        }
        return sourceHashes.get(key) ?? null;
    };

    for (const task of collectVariantImageTasks(blueprint, views)) {
        const sourceHash = sourceHashOf(task);
        if (!sourceHash) {
            plan.missingSource++;
            continue;
        }
        const cached = cache.images.loadImageMetadataWithView(
            salesChannelName,
            task.productId,
            task.view,
            "product_media"
        );
        if (
            !cached ||
            !cache.images.hasImageWithView(salesChannelName, task.productId, task.view)
        ) {
            plan.pending.push(task);
            continue;
        }
        if (cached.sourceHash === sourceHash) {
            plan.fresh++;
            continue;
        }
        plan.stale.push(task);
        plan.pending.push(task);
    }
    return plan;
}

/**
 * Recolour the parent product images for every colour variant (except the default colour).
 *
 * Runs after `hydrateProductImages`, because it reads the parent images from the cache.
 */
export async function hydrateVariantImages(
    imageProvider: ImageProvider,
    cache: DataCache,
    salesChannelName: string,
    blueprint: HydratedBlueprint,
    views: VariantImageViews = resolveVariantImageViews(process.env)
): Promise<VariantImageHydrationResult> {
    const result: VariantImageHydrationResult = {
        generated: 0,
        skipped: 0,
        stale: 0,
        failed: 0,
        missingSource: 0,
        total: 0,
        supported: Boolean(imageProvider.editImage),
    };

    const tasks = collectVariantImageTasks(blueprint, views);
    result.total = tasks.length;
    if (tasks.length === 0) return result;

    const editImage = imageProvider.editImage?.bind(imageProvider);
    if (!editImage) {
        logger.warn(`  ⚠ ${NO_EDIT_SUPPORT_WARNING}`, { cli: true });
        return result;
    }

    const plan = planVariantImages(cache, salesChannelName, blueprint, views);
    result.skipped = plan.fresh;
    result.stale = plan.stale.length;
    result.missingSource = plan.missingSource;

    for (const task of plan.stale) {
        cache.images.deleteImageWithView(salesChannelName, task.productId, task.view);
    }
    if (plan.missingSource > 0) {
        logger.warn(
            `  Colour images: ${plan.missingSource} skipped, parent image not cached ` +
                `(run blueprint hydrate first)`,
            { cli: true }
        );
    }
    if (plan.pending.length === 0) {
        logger.info(`  Colour images: all ${plan.fresh} already cached`, { cli: true });
        return result;
    }

    logger.info(
        `  Colour images: generating ${plan.pending.length}/${tasks.length} ` +
            `(${plan.fresh} cached, ${plan.stale.length} stale)`,
        { cli: true }
    );

    const limiter = new ConcurrencyLimiter(imageProvider.maxConcurrency);
    await limiter.all(
        plan.pending.map((task) => async () => {
            const generated = await recolorOne(
                editImage,
                imageProvider.name,
                cache,
                salesChannelName,
                task
            );
            if (generated) {
                result.generated++;
                return;
            }
            result.failed++;
        })
    );

    logger.info(`  Colour images: ${result.generated} generated, ${result.failed} failed`, {
        cli: true,
    });
    return result;
}

type EditImageFn = NonNullable<ImageProvider["editImage"]>;

async function recolorOne(
    editImage: EditImageFn,
    providerName: string,
    cache: DataCache,
    salesChannelName: string,
    task: VariantImageTask
): Promise<boolean> {
    const source = cache.images.loadImageWithView(
        salesChannelName,
        task.productId,
        task.sourceView,
        "product_media"
    );
    if (!source) return false;

    const prompt = buildRecolorPrompt(task.color);
    try {
        const edited = await executeWithRetry(
            async () => {
                const data = await editImage(prompt, source);
                if (!data) throw new Error("Image edit returned null");
                return data;
            },
            { maxRetries: 3, baseDelay: 5000 }
        );
        const base64 = await compressImage(edited);
        cache.images.saveVariantColorImage(salesChannelName, task.productId, task.view, base64, {
            prompt,
            imageModel: providerName,
            sourceHash: hashImage(source),
            shade: task.color.name,
            hex: task.color.hex,
        });
        return true;
    } catch {
        logger.warn(
            `    Failed to recolour ${task.productName} (${task.sourceView}) to ${task.color.name}`
        );
        return false;
    }
}
