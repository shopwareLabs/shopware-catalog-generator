/**
 * Variant Image Processor - gives every colour variant its own images.
 *
 * Reads the recoloured images from the cache (`blueprint hydrate --only=variant-images`,
 * no AI here), uploads them as media and sets the gallery and cover of each colour
 * variant. Views without a colour image keep the parent image, so the gallery has the
 * same order and length as the parent's. The default colour variant keeps inheriting the
 * parent images, because the parent images already show that colour.
 *
 * Each colour variant also gets its own colour family instead of all families of the
 * parent, so the "Color family" filter matches the variant that has the colour.
 *
 * All IDs are deterministic, so re-runs upsert the same rows and skip uploaded files.
 */

import type { BlueprintProduct, VariantColor } from "../types/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

import {
    collectVariantImageTasks,
    type VariantImageTask,
    variantImageView,
} from "../blueprint/hydrators/variant-images.js";
import {
    COLOR_FAMILY_GROUP_ID,
    colorFamilyOptionId,
    variantMediaTexts,
} from "../fixtures/index.js";
import { searchAllByEqualsAny } from "../shopware/api-helpers.js";
import {
    ConcurrencyLimiter,
    deterministicUUID,
    detectImageFormat,
    logger,
} from "../utils/index.js";
import { uploadImageWithRetry, viewFromFileName } from "./image-utils.js";

/** Parallel uploads (same as the image processor's per-product limit) */
const UPLOAD_CONCURRENCY = 5;

/** Media ID of a colour image ("front--burgundy" of a product) */
export function variantImageMediaId(productId: string, view: string): string {
    return deterministicUUID(`variant-image:${productId}:${view}`);
}

/** product_media ID of one gallery entry of a variant */
export function variantProductMediaId(variantId: string, slot: string): string {
    return deterministicUUID(`variant-product-media:${variantId}:${slot}`);
}

interface ParentProductRow {
    id: string;
    properties?: Array<{ id: string; groupId: string }> | null;
    media?: Array<{
        mediaId: string;
        position?: number | null;
        media?: { fileName?: string | null } | null;
    }> | null;
    children?: Array<{
        id: string;
        options?: Array<{ id: string; name: string }> | null;
    }> | null;
}

/** One gallery position of the parent: its view (if known) and its media */
interface GallerySlot {
    view: string | null;
    mediaId: string | null;
}

interface VariantUpdate {
    productMedia: Array<{ id: string; productId: string; mediaId: string; position: number }>;
    product: { id: string; coverId?: string; properties?: Array<{ id: string }> };
}

class VariantImageProcessorImpl implements PostProcessor {
    readonly name = "variant-images";
    readonly description = "Upload recoloured images and set them on each colour variant";
    readonly dependsOn = ["variants", "images"];

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const startTime = Date.now();
        const errors: string[] = [];
        const result = (processed: number, skipped: number): PostProcessorResult => ({
            name: this.name,
            processed,
            skipped,
            errors,
            durationMs: Date.now() - startTime,
        });

        const tasks = this.collectCachedTasks(context);
        const products = context.blueprint.products.filter((p) =>
            tasks.some((t) => t.productId === p.id)
        );
        if (tasks.length === 0) {
            logger.info(
                `    No cached colour images (run blueprint hydrate --only=variant-images)`,
                { cli: true }
            );
            return result(0, 0);
        }

        logger.info(`    ${tasks.length} colour images for ${products.length} variant products`, {
            cli: true,
        });
        if (context.options.dryRun) {
            for (const product of products) {
                const count = tasks.filter((t) => t.productId === product.id).length;
                logger.info(`    [DRY RUN] ${product.name}: ${count} colour images`, {
                    cli: true,
                });
            }
            return result(products.length, 0);
        }

        const available = await this.uploadColorImages(context, tasks, errors);
        const parents = await searchAllByEqualsAny<ParentProductRow>(
            context,
            "product",
            "id",
            products.map((p) => p.id),
            {
                associations: {
                    properties: {},
                    media: { associations: { media: {} } },
                    children: { associations: { options: {} } },
                },
            }
        );
        const parentById = new Map(parents.map((p) => [p.id, p]));

        let processed = 0;
        for (const product of products) {
            const parent = parentById.get(product.id);
            if (!parent) {
                errors.push(`${product.name}: product not found in Shopware`);
                continue;
            }
            const linked = await this.linkVariants(context, product, parent, available, errors);
            if (linked > 0) processed++;
        }

        logger.info(`    ✓ Colour images set for ${processed} products`, { cli: true });
        return result(processed, products.length - processed);
    }

    async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        const startTime = Date.now();
        const errors: string[] = [];
        const done = (deleted: number): PostProcessorCleanupResult => ({
            name: this.name,
            deleted,
            errors,
            durationMs: Date.now() - startTime,
        });

        const productIds = context.blueprint.products.map((p) => p.id);
        const mediaIds = collectVariantImageTasks(context.blueprint, "all").map((t) =>
            variantImageMediaId(t.productId, t.view)
        );
        if (mediaIds.length === 0) return done(0);

        if (context.options.dryRun) {
            logger.info(`    [DRY RUN] Would delete variant galleries and colour images`, {
                cli: true,
            });
            return done(0);
        }

        try {
            // Variants have no own images apart from the ones this processor sets
            const productMedia = await searchAllByEqualsAny<{ id: string }>(
                context,
                "product-media",
                "product.parentId",
                productIds,
                { includes: { product_media: ["id"] } }
            );
            await context.api.deleteEntities(
                "product_media",
                productMedia.map((m) => m.id)
            );
            const media = await searchAllByEqualsAny<{ id: string }>(
                context,
                "media",
                "id",
                mediaIds,
                { includes: { media: ["id"] } }
            );
            await context.api.deleteEntities(
                "media",
                media.map((m) => m.id)
            );
            logger.info(`    ✓ Deleted ${media.length} colour images`, { cli: true });
            return done(productMedia.length + media.length);
        } catch (error) {
            errors.push(`Cleanup failed: ${errorMessage(error)}`);
            return done(0);
        }
    }

    /** Colour image tasks whose image is in the cache */
    private collectCachedTasks(context: PostProcessorContext): VariantImageTask[] {
        return collectVariantImageTasks(context.blueprint, "all").filter((task) =>
            context.cache.images.hasImageWithView(
                context.salesChannelName,
                task.productId,
                task.view,
                "product_media"
            )
        );
    }

    /**
     * Create the media entities and upload files that are not uploaded yet.
     * Returns the media IDs that have a file in Shopware.
     */
    private async uploadColorImages(
        context: PostProcessorContext,
        tasks: VariantImageTask[],
        errors: string[]
    ): Promise<Set<string>> {
        const mediaFolderId = await context.api.getProductMediaFolderId();
        const mediaIds = tasks.map((t) => variantImageMediaId(t.productId, t.view));
        const existing = await searchAllByEqualsAny<{ id: string; fileName?: string | null }>(
            context,
            "media",
            "id",
            mediaIds,
            { includes: { media: ["id", "fileName"] } }
        );
        const withFile = new Set(existing.filter((m) => m.fileName).map((m) => m.id));

        await context.api.syncEntities({
            variantImageMedia: {
                entity: "media",
                action: "upsert",
                payload: tasks.map((task) => ({
                    id: variantImageMediaId(task.productId, task.view),
                    private: false,
                    ...(mediaFolderId && { mediaFolderId }),
                    ...variantMediaTexts(task.productName, task.sourceView, task.color.name),
                })),
            },
        });

        const pending = tasks.filter(
            (t) => !withFile.has(variantImageMediaId(t.productId, t.view))
        );
        const limiter = new ConcurrencyLimiter(UPLOAD_CONCURRENCY);
        const uploaded = await limiter.all(
            pending.map((task) => () => this.uploadColorImage(context, task, errors))
        );
        logger.info(
            `    Uploaded ${uploaded.filter(Boolean).length} colour images ` +
                `(${withFile.size} already uploaded)`,
            { cli: true }
        );
        return new Set([...withFile, ...uploaded.filter((id): id is string => id !== null)]);
    }

    private async uploadColorImage(
        context: PostProcessorContext,
        task: VariantImageTask,
        errors: string[]
    ): Promise<string | null> {
        const mediaId = variantImageMediaId(task.productId, task.view);
        const base64 = context.cache.images.loadImageWithView(
            context.salesChannelName,
            task.productId,
            task.view,
            "product_media"
        );
        if (!base64) return null;

        const buffer = Buffer.from(base64, "base64");
        // Product ID keeps the file name unique when two products share a name
        const fileName =
            `${task.productName.replace(/[^a-zA-Z0-9]/g, "-")}-${task.view}-` +
            task.productId.slice(0, 8);
        try {
            const response = await uploadImageWithRetry(
                context,
                mediaId,
                fileName,
                buffer,
                detectImageFormat(buffer)
            );
            if (response.ok) return mediaId;
            errors.push(`Upload of ${fileName} failed: ${response.status}`);
            return null;
        } catch (error) {
            errors.push(`Upload of ${fileName} failed: ${errorMessage(error)}`);
            return null;
        }
    }

    /** Set gallery, cover and colour family of every colour variant of one product */
    private async linkVariants(
        context: PostProcessorContext,
        product: BlueprintProduct,
        parent: ParentProductRow,
        available: Set<string>,
        errors: string[]
    ): Promise<number> {
        const slots = gallerySlots(product, parent);
        const updates = (parent.children ?? []).flatMap((child) => {
            const color = colorOfVariant(product, child.options ?? []);
            if (!color) return [];
            const update = buildVariantUpdate(product.id, child.id, color, slots, available);
            if (!update) return [];
            const properties = variantProperties(parent, color);
            return [
                { ...update, product: { ...update.product, ...(properties && { properties }) } },
            ];
        });
        if (updates.length === 0) return 0;

        try {
            await context.api.syncEntities({
                variantProductMedia: {
                    entity: "product_media",
                    action: "upsert",
                    payload: updates.flatMap((u) => u.productMedia),
                },
                variantCovers: {
                    entity: "product",
                    action: "upsert",
                    payload: updates.map((u) => u.product),
                },
            });
            return updates.length;
        } catch (error) {
            errors.push(`${product.name}: ${errorMessage(error)}`);
            return 0;
        }
    }
}

/** Gallery positions of the parent; falls back to the blueprint views without parent images */
function gallerySlots(product: BlueprintProduct, parent: ParentProductRow): GallerySlot[] {
    const media = [...(parent.media ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    if (media.length > 0) {
        return media.map((m) => ({
            view: viewFromFileName(m.media?.fileName),
            mediaId: m.mediaId,
        }));
    }
    return (product.metadata.imageDescriptions ?? []).map((d) => ({ view: d.view, mediaId: null }));
}

/** Non-default colour of a variant, matched by its option names */
function colorOfVariant(
    product: BlueprintProduct,
    options: Array<{ name: string }>
): VariantColor | undefined {
    const names = new Set(options.map((o) => o.name.toLowerCase()));
    return product.metadata.variantColors?.slice(1).find((c) => names.has(c.name.toLowerCase()));
}

/**
 * Gallery of one colour variant: the colour image per view, the parent image where the
 * colour image is missing. Null when no colour image is available (keep inheriting).
 */
function buildVariantUpdate(
    productId: string,
    variantId: string,
    color: VariantColor,
    slots: GallerySlot[],
    available: Set<string>
): VariantUpdate | null {
    const entries = slots.flatMap((slot, index) => {
        const colorMediaId = slot.view
            ? variantImageMediaId(productId, variantImageView(slot.view, color.name))
            : null;
        const mediaId = colorMediaId && available.has(colorMediaId) ? colorMediaId : slot.mediaId;
        if (!mediaId) return [];
        return [
            { slot: slot.view ?? `position-${index}`, mediaId, isColor: mediaId === colorMediaId },
        ];
    });
    if (!entries.some((e) => e.isColor)) return null;

    const productMedia = entries.map((entry, position) => ({
        id: variantProductMediaId(variantId, entry.slot),
        productId: variantId,
        mediaId: entry.mediaId,
        position,
    }));
    return { productMedia, product: { id: variantId, coverId: productMedia[0]?.id } };
}

/**
 * Parent properties with only the variant's colour family. Undefined when the parent does
 * not have that family option (then the variant keeps inheriting).
 */
function variantProperties(
    parent: ParentProductRow,
    color: VariantColor
): Array<{ id: string }> | undefined {
    const familyOptionId = colorFamilyOptionId(color.family);
    const properties = parent.properties ?? [];
    if (!properties.some((p) => p.id === familyOptionId)) return undefined;
    return [
        ...properties.filter((p) => p.groupId !== COLOR_FAMILY_GROUP_ID).map((p) => ({ id: p.id })),
        { id: familyOptionId },
    ];
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export const VariantImageProcessor = new VariantImageProcessorImpl();
