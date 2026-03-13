/**
 * Digital Product Processor - Creates a €50 Gift Card as a digital product
 *
 * Creates a dedicated digital product (gift card) that:
 * 1. Has a proper name and description (from fixture)
 * 2. Is priced at €50
 * 3. Has a downloadable voucher
 * 4. Is shared across all SalesChannels (but visibility added per-channel)
 *
 * NOTE: All content comes from fixtures - NO AI generation at runtime.
 * This keeps post-processor execution fast.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ProductSyncPayload } from "../types/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

import { GIFT_CARD_50 } from "../fixtures/digital-products.js";
import { apiPost, generateUUID, logger } from "../utils/index.js";
import { resolvePrimaryCurrencyId } from "./currency-utils.js";

/** Cache file for storing digital product info */
const DIGITAL_PRODUCT_CACHE_FILE = "digital-product.json";

interface DigitalProductCache {
    productId: string;
    mediaId: string;
    downloadId: string;
    createdNew: boolean;
}

/**
 * Digital Product Processor implementation
 */
class DigitalProductProcessorImpl implements PostProcessor {
    readonly name = "digital-product";
    readonly description = "Create a €50 Gift Card as a digital product";
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

        if (context.options.dryRun) {
            logger.info(`    [DRY RUN] Would create gift card digital product`, { cli: true });
            return result(1, 0);
        }

        try {
            const cached = await this.handleCachedProduct(context);
            if (cached) return result(0, 1);

            const productId = await this.ensureGiftCardProduct(context);
            if (!productId) return result(0, 0, ["Failed to create gift card product"]);

            await this.ensureCoverImage(context, productId);
            await this.ensureVisibility(context, productId);
            const downloadResult = await this.ensureDownload(context, productId);
            if (downloadResult.error) return result(0, 0, [downloadResult.error]);

            this.saveCache(context, {
                productId,
                mediaId: downloadResult.mediaId,
                downloadId: downloadResult.downloadId,
                createdNew: downloadResult.createdNew ?? false,
            });

            return result(1, 0);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return result(0, 0, [`Digital product creation failed: ${message}`]);
        }
    }

    /**
     * Returns true if a valid cached product was found (caller should skip).
     * Clears stale cache and returns false to continue with fresh setup.
     */
    private async handleCachedProduct(context: PostProcessorContext): Promise<boolean> {
        const cached = this.loadCache(context);
        if (!cached) return false;

        const valid = await this.isCachedGiftCardValid(context, cached.productId);
        if (!valid) {
            logger.warn(`    ⚠ Stale digital-product cache detected, rebuilding gift card state`, {
                cli: true,
            });
            this.clearCache(context);
            return false;
        }

        await this.ensureCoverImage(context, cached.productId);
        logger.info(`    ⊘ Gift card already exists (${cached.productId})`, { cli: true });
        return true;
    }

    /**
     * Find or create the gift card product. Returns the product ID or null on failure.
     */
    private async ensureGiftCardProduct(context: PostProcessorContext): Promise<string | null> {
        const existingId = await this.findExistingGiftCard(context);
        if (existingId) {
            logger.info(`    ⊘ Gift card product already exists globally`, { cli: true });
            return existingId;
        }

        const taxId = await this.getDefaultTaxId(context);
        if (!taxId) return null;

        const productId = await this.createGiftCardProduct(context, taxId);
        if (productId) {
            logger.info(`    ✓ Created gift card product "${GIFT_CARD_50.name}"`, { cli: true });
        }
        return productId;
    }

    private async ensureCoverImage(
        context: PostProcessorContext,
        productId: string
    ): Promise<void> {
        const hasCover = await this.productHasCoverImage(context, productId);
        if (hasCover) return;

        const uploaded = await this.uploadProductCoverImage(context, productId);
        if (uploaded) {
            logger.info(`    ✓ Uploaded gift card cover image`, { cli: true });
        }
    }

    private async ensureVisibility(
        context: PostProcessorContext,
        productId: string
    ): Promise<void> {
        const added = await this.addSalesChannelVisibility(context, productId);
        if (added) {
            logger.info(`    ✓ Added gift card to SalesChannel`, { cli: true });
            return;
        }
        logger.info(`    ⊘ Gift card already visible in SalesChannel`, { cli: true });
    }

    private async ensureDownload(
        context: PostProcessorContext,
        productId: string
    ): Promise<{
        mediaId: string;
        downloadId: string;
        createdNew?: boolean;
        error?: string;
    }> {
        const existingMediaId = await this.findExistingDownloadMedia(context, productId);
        if (existingMediaId) {
            logger.info(`    ⊘ Download media already exists`, { cli: true });
            return { mediaId: existingMediaId, downloadId: "" };
        }

        const mediaId = await this.createDownloadMedia(context);
        if (!mediaId)
            return { mediaId: "", downloadId: "", error: "Failed to create download media" };

        const downloadId = await this.createProductDownload(context, productId, mediaId);
        if (!downloadId)
            return { mediaId, downloadId: "", error: "Failed to create product download" };

        logger.info(`    ✓ Created downloadable voucher`, { cli: true });
        return { mediaId, downloadId, createdNew: true };
    }

    async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        const { options } = context;
        let deleted = 0;
        const errors: string[] = [];

        if (options.dryRun) {
            logger.info(`    [DRY RUN] Would remove gift card visibility from SalesChannel`, {
                cli: true,
            });
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        try {
            const cached = this.loadCache(context);
            if (!cached) {
                logger.info(`    ⊘ No gift card found in cache`, { cli: true });
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            // Remove visibility from this SalesChannel (don't delete the product)
            const removed = await this.removeSalesChannelVisibility(context, cached.productId);
            if (removed) {
                logger.info(`    ✓ Removed gift card from SalesChannel`, { cli: true });
                deleted++;
            }

            // Clear cache
            this.clearCache(context);
        } catch (error) {
            errors.push(
                `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        return { name: this.name, deleted, errors, durationMs: 0 };
    }

    // =========================================================================
    // Product Operations
    // =========================================================================

    /**
     * Find existing gift card product by product number
     */
    private async findExistingGiftCard(context: PostProcessorContext): Promise<string | null> {
        try {
            interface ProductResponse {
                data?: Array<{ id: string }>;
            }

            const response = await apiPost(context, "search/product", {
                filter: [
                    {
                        type: "equals",
                        field: "productNumber",
                        value: GIFT_CARD_50.productNumber,
                    },
                ],
                limit: 1,
            });

            if (response.ok) {
                const data = (await response.json()) as ProductResponse;
                return data.data?.[0]?.id || null;
            }
        } catch (error) {
            logger.warn("Failed to find existing gift card", { data: error });
        }

        return null;
    }

    /**
     * Validate cached product ID still exists and is visible in this SalesChannel
     */
    private async isCachedGiftCardValid(
        context: PostProcessorContext,
        productId: string
    ): Promise<boolean> {
        try {
            interface ProductResponse {
                data?: Array<{ id: string }>;
            }
            interface VisibilityResponse {
                data?: Array<{ id: string }>;
            }

            const productResponse = await apiPost(context, "search/product", {
                ids: [productId],
                limit: 1,
            });
            if (!productResponse.ok) {
                return false;
            }
            const productData = (await productResponse.json()) as ProductResponse;
            if (!productData.data?.length) {
                return false;
            }

            const visibilityResponse = await apiPost(context, "search/product-visibility", {
                filter: [
                    { type: "equals", field: "productId", value: productId },
                    { type: "equals", field: "salesChannelId", value: context.salesChannelId },
                ],
                limit: 1,
            });
            if (!visibilityResponse.ok) {
                return false;
            }
            const visibilityData = (await visibilityResponse.json()) as VisibilityResponse;
            return !!visibilityData.data?.length;
        } catch {
            return false;
        }
    }

    /**
     * Get the default tax rate ID
     */
    private async getDefaultTaxId(context: PostProcessorContext): Promise<string | null> {
        try {
            interface TaxResponse {
                data?: Array<{ id: string }>;
            }

            const response = await apiPost(context, "search/tax", {
                filter: [
                    {
                        type: "equals",
                        field: "name",
                        value: "Standard rate",
                    },
                ],
                limit: 1,
            });

            if (response.ok) {
                const data = (await response.json()) as TaxResponse;
                if (data.data?.[0]?.id) {
                    return data.data[0].id;
                }
            }

            // Fallback: get any tax rate
            const fallbackResponse = await apiPost(context, "search/tax", { limit: 1 });
            if (fallbackResponse.ok) {
                const data = (await fallbackResponse.json()) as TaxResponse;
                return data.data?.[0]?.id || null;
            }
        } catch (error) {
            logger.warn("Failed to get default tax ID", { data: error });
        }

        return null;
    }

    /**
     * Get the "Instant download" delivery time ID (min=0)
     */
    private async getInstantDeliveryTimeId(context: PostProcessorContext): Promise<string | null> {
        try {
            const response = await apiPost(context, "search/delivery-time", {
                limit: 1,
                filter: [{ type: "equals", field: "min", value: 0 }],
            });

            if (!response.ok) return null;

            const data = (await response.json()) as { data?: Array<{ id: string }> };
            return data.data?.[0]?.id ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Create the gift card product using fixture data
     */
    private async createGiftCardProduct(
        context: PostProcessorContext,
        taxId: string
    ): Promise<string | null> {
        const productId = generateUUID();
        const deliveryTimeId = await this.getInstantDeliveryTimeId(context);
        const currencyId = await resolvePrimaryCurrencyId(context.api);

        try {
            const payload: ProductSyncPayload = {
                id: productId,
                productNumber: GIFT_CARD_50.productNumber,
                name: GIFT_CARD_50.name,
                description: GIFT_CARD_50.description,
                stock: 9999,
                taxId,
                price: [
                    {
                        currencyId,
                        gross: GIFT_CARD_50.price,
                        net: GIFT_CARD_50.price,
                        linked: false,
                    },
                ],
                active: true,
                shippingFree: true,
                isCloseout: false,
                markAsTopseller: false,
                deliveryTimeId: deliveryTimeId ?? undefined,
            };

            const response = await apiPost(context, "_action/sync", {
                createProduct: {
                    entity: "product",
                    action: "upsert",
                    payload: [payload],
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.apiError("_action/sync (create gift card)", response.status, {
                    error: errorText,
                });
                return null;
            }

            return productId;
        } catch (error) {
            logger.warn("Failed to create gift card product", { data: error });
            return null;
        }
    }

    /**
     * Check if a product already has a cover image assigned
     */
    private async productHasCoverImage(
        context: PostProcessorContext,
        productId: string
    ): Promise<boolean> {
        try {
            const response = await apiPost(context, "search/product", {
                ids: [productId],
                limit: 1,
                associations: { cover: { associations: { media: {} } } },
            });

            if (!response.ok) return false;

            const data = (await response.json()) as {
                data?: Array<{ coverId: string | null; cover?: { media?: { url?: string } } }>;
            };
            const product = data.data?.[0];
            return !!product?.coverId;
        } catch {
            return false;
        }
    }

    /**
     * Upload the product cover image from fixtures
     */
    private async uploadProductCoverImage(
        context: PostProcessorContext,
        productId: string
    ): Promise<boolean> {
        try {
            // Check if image file exists
            if (!fs.existsSync(GIFT_CARD_50.imagePath)) {
                logger.warn("Gift card image not found at path", {
                    data: { path: GIFT_CARD_50.imagePath },
                });
                return false;
            }

            // Create media entity
            const mediaId = generateUUID();
            const createMediaResponse = await apiPost(context, "_action/sync", {
                createMedia: {
                    entity: "media",
                    action: "upsert",
                    payload: [
                        {
                            id: mediaId,
                            private: false,
                            mediaFolderId: null,
                        },
                    ],
                },
            });

            if (!createMediaResponse.ok) {
                logger.apiError(
                    "_action/sync (create cover media)",
                    createMediaResponse.status,
                    {}
                );
                return false;
            }

            // Read and upload image file
            const imageBuffer = fs.readFileSync(GIFT_CARD_50.imagePath);
            try {
                const uniqueName = `gift-card-50-cover-${mediaId.slice(0, 8)}`;
                await context.api.uploadMedia(mediaId, imageBuffer, uniqueName, "png");
            } catch (uploadError) {
                logger.apiError("media upload (cover)", 500, uploadError);
                return false;
            }

            // Set as product cover
            const productMediaId = generateUUID();
            const setCoverResponse = await apiPost(context, "_action/sync", {
                setProductCover: {
                    entity: "product",
                    action: "upsert",
                    payload: [
                        {
                            id: productId,
                            coverId: productMediaId,
                            media: [
                                {
                                    id: productMediaId,
                                    mediaId,
                                    position: 1,
                                },
                            ],
                        },
                    ],
                },
            });

            return setCoverResponse.ok;
        } catch (error) {
            logger.warn("Failed to upload product cover image", { data: error });
            return false;
        }
    }

    /**
     * Add product visibility to SalesChannel
     */
    private async addSalesChannelVisibility(
        context: PostProcessorContext,
        productId: string
    ): Promise<boolean> {
        try {
            // Check if visibility already exists
            interface VisibilityResponse {
                data?: Array<{ id: string }>;
            }

            const checkResponse = await apiPost(context, "search/product-visibility", {
                filter: [
                    { type: "equals", field: "productId", value: productId },
                    { type: "equals", field: "salesChannelId", value: context.salesChannelId },
                ],
                limit: 1,
            });

            if (checkResponse.ok) {
                const data = (await checkResponse.json()) as VisibilityResponse;
                if (data.data?.length) {
                    return false; // Already visible
                }
            }

            // Add visibility
            const visibilityId = generateUUID();
            const response = await apiPost(context, "_action/sync", {
                createVisibility: {
                    entity: "product_visibility",
                    action: "upsert",
                    payload: [
                        {
                            id: visibilityId,
                            productId,
                            salesChannelId: context.salesChannelId,
                            visibility: 30, // All (search + listing)
                        },
                    ],
                },
            });

            return response.ok;
        } catch (error) {
            logger.warn("Failed to add SalesChannel visibility", { data: error });
            return false;
        }
    }

    /**
     * Remove product visibility from SalesChannel
     */
    private async removeSalesChannelVisibility(
        context: PostProcessorContext,
        productId: string
    ): Promise<boolean> {
        try {
            interface VisibilityResponse {
                data?: Array<{ id: string }>;
            }

            const response = await apiPost(context, "search/product-visibility", {
                filter: [
                    { type: "equals", field: "productId", value: productId },
                    { type: "equals", field: "salesChannelId", value: context.salesChannelId },
                ],
                limit: 1,
            });

            if (!response.ok) {
                return false;
            }

            const data = (await response.json()) as VisibilityResponse;
            const visibilityId = data.data?.[0]?.id;

            if (!visibilityId) {
                return false;
            }

            return await this.deleteEntity(context, "product-visibility", visibilityId);
        } catch (error) {
            logger.warn("Failed to remove SalesChannel visibility", { data: error });
            return false;
        }
    }

    /**
     * Find existing download media for the product
     */
    private async findExistingDownloadMedia(
        context: PostProcessorContext,
        productId: string
    ): Promise<string | null> {
        try {
            interface DownloadResponse {
                data?: Array<{ id: string; mediaId: string }>;
            }

            const response = await apiPost(context, "search/product-download", {
                filter: [{ type: "equals", field: "productId", value: productId }],
                limit: 1,
            });

            if (response.ok) {
                const data = (await response.json()) as DownloadResponse;
                return data.data?.[0]?.mediaId || null;
            }
        } catch (error) {
            logger.warn("Failed to find existing download media", { data: error });
        }

        return null;
    }

    /**
     * Create a media file for download (PDF voucher)
     */
    private async createDownloadMedia(context: PostProcessorContext): Promise<string | null> {
        const mediaId = generateUUID();

        try {
            // Create the media entity
            const createResponse = await apiPost(context, "_action/sync", {
                createMedia: {
                    entity: "media",
                    action: "upsert",
                    payload: [
                        {
                            id: mediaId,
                            private: true, // Download files should be private
                            mediaFolderId: null,
                        },
                    ],
                },
            });

            if (!createResponse.ok) {
                logger.apiError("_action/sync (create download media)", createResponse.status, {});
                return null;
            }

            // Create voucher content from fixture template
            const voucherCode = `GIFT-${Date.now().toString(36).toUpperCase()}`;
            const voucherDate = new Date().toISOString().split("T")[0] || "";
            const voucherContent = GIFT_CARD_50.voucherTemplate
                .replace("{{CODE}}", voucherCode)
                .replace("{{DATE}}", voucherDate);

            await context.api.uploadMedia(
                mediaId,
                Buffer.from(voucherContent),
                "gift-card-voucher",
                "txt"
            );

            return mediaId;
        } catch (error) {
            logger.warn("Failed to create download media", { data: error });
            return null;
        }
    }

    /**
     * Create product download association
     */
    private async createProductDownload(
        context: PostProcessorContext,
        productId: string,
        mediaId: string
    ): Promise<string | null> {
        const downloadId = generateUUID();

        try {
            const response = await apiPost(context, "_action/sync", {
                createDownload: {
                    entity: "product_download",
                    action: "upsert",
                    payload: [
                        {
                            id: downloadId,
                            productId,
                            mediaId,
                            position: 1,
                        },
                    ],
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.apiError("_action/sync (create product download)", response.status, {
                    error: errorText,
                });
                return null;
            }

            return downloadId;
        } catch (error) {
            logger.warn("Failed to create product download", { data: error });
            return null;
        }
    }

    /**
     * Delete an entity by ID
     */
    private async deleteEntity(
        context: PostProcessorContext,
        entity: string,
        id: string
    ): Promise<boolean> {
        try {
            return await context.api.deleteEntity(entity, id);
        } catch (error) {
            logger.warn(`Failed to delete ${entity}/${id}`, { data: error });
            return false;
        }
    }

    // =========================================================================
    // Cache Operations
    // =========================================================================

    private getCacheFilePath(context: PostProcessorContext): string {
        const cacheDir = context.cache.getSalesChannelDir(context.salesChannelName);
        return path.join(cacheDir, DIGITAL_PRODUCT_CACHE_FILE);
    }

    private loadCache(context: PostProcessorContext): DigitalProductCache | null {
        const filePath = this.getCacheFilePath(context);
        if (!fs.existsSync(filePath)) {
            return null;
        }

        try {
            const content = fs.readFileSync(filePath, "utf-8");
            return JSON.parse(content) as DigitalProductCache;
        } catch {
            return null;
        }
    }

    private saveCache(context: PostProcessorContext, data: DigitalProductCache): void {
        const filePath = this.getCacheFilePath(context);
        const dir = path.dirname(filePath);

        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }

    private clearCache(context: PostProcessorContext): void {
        const filePath = this.getCacheFilePath(context);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
}

export const DigitalProductProcessor = new DigitalProductProcessorImpl();
