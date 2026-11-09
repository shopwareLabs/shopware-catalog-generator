/**
 * Media Product Processor - Creates a "Media Showcase" product with 3D models and videos
 *
 * The product gallery holds the GLB models and MP4 videos from `src/fixtures/media/`.
 * Each file is only added when the shop supports it (3D: 6.6.0, video: 6.6.1), so the
 * same run works on every Shopware version. On older shops the processor is skipped.
 *
 * Like the gift card, the product is shared across SalesChannels and only its visibility
 * is per channel. All IDs are deterministic, so re-runs upsert the same rows and every
 * file is uploaded once per shop.
 *
 * NOTE: All content comes from fixtures - NO AI generation at runtime.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { MediaShowcaseFile } from "../fixtures/index.js";
import type { ProductSyncPayload } from "../types/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

import {
    MEDIA_FIXTURE_DIR,
    MEDIA_SHOWCASE_FILES,
    MEDIA_SHOWCASE_PRODUCT,
} from "../fixtures/index.js";
import { deterministicUUID, logger } from "../utils/index.js";

/** Deterministic ID of the showcase product (same on every shop) */
export const MEDIA_SHOWCASE_PRODUCT_ID = deterministicUUID("media-showcase:product");

/** Media ID of a showcase file */
export function mediaShowcaseMediaId(file: MediaShowcaseFile): string {
    return deterministicUUID(`media-showcase:media:${file.key}`);
}

function productMediaId(file: MediaShowcaseFile): string {
    return deterministicUUID(`media-showcase:product-media:${file.key}`);
}

function visibilityId(salesChannelId: string): string {
    return deterministicUUID(`media-showcase:visibility:${salesChannelId}`);
}

/** Gallery files the connected shop can display */
export function getSupportedShowcaseFiles(context: PostProcessorContext): MediaShowcaseFile[] {
    return MEDIA_SHOWCASE_FILES.filter((file) => context.shopware.supports(file.feature));
}

interface MediaRow {
    id: string;
    fileName?: string | null;
}

class MediaProductProcessorImpl implements PostProcessor {
    readonly name = "media-product";
    readonly description = "Create a Media Showcase product with 3D models and videos";
    readonly dependsOn: string[] = [];

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const startTime = Date.now();
        const result = (
            processed: number,
            skipped: number,
            errors: string[] = []
        ): PostProcessorResult => ({
            name: this.name,
            processed,
            skipped,
            errors,
            durationMs: Date.now() - startTime,
        });

        const files = getSupportedShowcaseFiles(context);
        if (files.length === 0) {
            logger.info(
                `    ⊘ Shopware ${context.shopware.version?.raw ?? "(unknown)"} has no 3D/video gallery, skipping media showcase`,
                { cli: true }
            );
            return result(0, 1);
        }

        if (context.options.dryRun) {
            logger.info(
                `    [DRY RUN] Would create "${MEDIA_SHOWCASE_PRODUCT.name}" with ${files.length} media files`,
                { cli: true }
            );
            return result(1, 0);
        }

        try {
            const errors = await this.ensureShowcase(context, files);
            return errors.length > 0 ? result(0, 0, errors) : result(1, 0);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return result(0, 0, [`Media showcase failed: ${message}`]);
        }
    }

    async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        if (context.options.dryRun) {
            logger.info(`    [DRY RUN] Would remove media showcase from SalesChannel`, {
                cli: true,
            });
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        // The product is shared across SalesChannels: only remove this channel's visibility
        const removed = await context.api.deleteEntity(
            "product-visibility",
            visibilityId(context.salesChannelId)
        );
        if (removed) {
            logger.info(`    ✓ Removed media showcase from SalesChannel`, { cli: true });
        }
        return { name: this.name, deleted: removed ? 1 : 0, errors: [], durationMs: 0 };
    }

    private async ensureShowcase(
        context: PostProcessorContext,
        files: MediaShowcaseFile[]
    ): Promise<string[]> {
        await this.ensureProduct(context);

        const failed = await this.ensureMediaFiles(context, files);
        const uploaded = files.filter((file) => !failed.has(file));
        if (uploaded.length > 0) {
            await this.assignGallery(context, uploaded);
            logger.info(
                `    ✓ Media showcase gallery: ${uploaded.map((f) => f.fileName).join(", ")}`,
                {
                    cli: true,
                }
            );
        }

        await this.ensureVisibility(context);
        return [...failed.values()];
    }

    private async ensureProduct(context: PostProcessorContext): Promise<void> {
        const existing = await context.api.searchEntities<{ id: string }>("product", [], {
            ids: [MEDIA_SHOWCASE_PRODUCT_ID],
            limit: 1,
        });
        if (existing.length > 0) {
            logger.info(`    ⊘ "${MEDIA_SHOWCASE_PRODUCT.name}" product already exists`, {
                cli: true,
            });
            return;
        }

        const [taxId, currencyId] = await Promise.all([
            context.api.getStandardTaxId(),
            context.api.getDefaultCurrencyId(),
        ]);
        const { price } = MEDIA_SHOWCASE_PRODUCT;
        const payload: ProductSyncPayload = {
            id: MEDIA_SHOWCASE_PRODUCT_ID,
            productNumber: MEDIA_SHOWCASE_PRODUCT.productNumber,
            name: MEDIA_SHOWCASE_PRODUCT.name,
            description: MEDIA_SHOWCASE_PRODUCT.description,
            stock: 9999,
            taxId,
            price: [{ currencyId, gross: price, net: price, linked: false }],
            active: true,
            // Immutable in Shopware: must be set on create
            ...(context.shopware.supports("productType") && { type: "physical" }),
        };

        await context.api.syncEntities({
            createMediaShowcaseProduct: { entity: "product", action: "upsert", payload: [payload] },
        });
        logger.info(`    ✓ Created "${MEDIA_SHOWCASE_PRODUCT.name}" product`, { cli: true });
    }

    /**
     * Create media entities and upload files that have no file yet.
     * Returns the files that failed, with their error message.
     */
    private async ensureMediaFiles(
        context: PostProcessorContext,
        files: MediaShowcaseFile[]
    ): Promise<Map<MediaShowcaseFile, string>> {
        const existing = await context.api.searchEntities<MediaRow>("media", [], {
            ids: files.map(mediaShowcaseMediaId),
            limit: files.length,
        });
        const withFile = new Set(existing.filter((m) => m.fileName).map((m) => m.id));
        const missing = files.filter((file) => !withFile.has(mediaShowcaseMediaId(file)));
        if (missing.length === 0) return new Map();

        const mediaFolderId = await context.api.getProductMediaFolderId();
        await context.api.syncEntities({
            createMediaShowcaseMedia: {
                entity: "media",
                action: "upsert",
                payload: missing.map((file) => ({
                    id: mediaShowcaseMediaId(file),
                    private: false,
                    mediaFolderId: mediaFolderId ?? undefined,
                    alt: file.alt,
                    title: file.title,
                })),
            },
        });

        const results = await Promise.all(
            missing.map(async (file) => [file, await this.uploadFile(context, file)] as const)
        );
        return new Map(
            results.filter((entry): entry is readonly [MediaShowcaseFile, string] => !!entry[1])
        );
    }

    private async uploadFile(
        context: PostProcessorContext,
        file: MediaShowcaseFile
    ): Promise<string | null> {
        try {
            const buffer = fs.readFileSync(path.join(MEDIA_FIXTURE_DIR, file.fileName));
            await context.api.uploadMedia(
                mediaShowcaseMediaId(file),
                buffer,
                `media-showcase-${file.key}`,
                file.extension
            );
            logger.info(`    ✓ Uploaded ${file.fileName}`, { cli: true });
            return null;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return `${file.fileName}: upload failed (${message})`;
        }
    }

    private async assignGallery(
        context: PostProcessorContext,
        files: MediaShowcaseFile[]
    ): Promise<void> {
        const [cover] = files;
        if (!cover) return;

        await context.api.syncEntities({
            assignMediaShowcaseGallery: {
                entity: "product",
                action: "upsert",
                payload: [
                    {
                        id: MEDIA_SHOWCASE_PRODUCT_ID,
                        coverId: productMediaId(cover),
                        media: files.map((file, position) => ({
                            id: productMediaId(file),
                            mediaId: mediaShowcaseMediaId(file),
                            position,
                        })),
                    },
                ],
            },
        });
    }

    private async ensureVisibility(context: PostProcessorContext): Promise<void> {
        await context.api.syncEntities({
            addMediaShowcaseVisibility: {
                entity: "product_visibility",
                action: "upsert",
                payload: [
                    {
                        id: visibilityId(context.salesChannelId),
                        productId: MEDIA_SHOWCASE_PRODUCT_ID,
                        salesChannelId: context.salesChannelId,
                        visibility: 30,
                    },
                ],
            },
        });
    }
}

export const MediaProductProcessor = new MediaProductProcessorImpl();
