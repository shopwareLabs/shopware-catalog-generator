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

import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

import { GIFT_CARD_50 } from "../fixtures/digital-products.js";
import { apiPost, generateUUID, logger } from "../utils/index.js";

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
    readonly dependsOn: string[] = ["variants"]; // Run after variants are created

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { options } = context;
        const errors: string[] = [];
        const startTime = Date.now();

        if (options.dryRun) {
            logger.info(`    [DRY RUN] Would create gift card digital product`, { cli: true });
            return {
                name: this.name,
                processed: 1,
                skipped: 0,
                errors: [],
                durationMs: Date.now() - startTime,
            };
        }

        try {
            // Check if already processed for this SalesChannel
            const cached = this.loadCache(context);
            if (cached) {
                const cacheStillValid = await this.isCachedGiftCardValid(context, cached.productId);
                if (!cacheStillValid) {
                    logger.warn(
                        `    ⚠ Stale digital-product cache detected, rebuilding gift card state`,
                        { cli: true }
                    );
                    this.clearCache(context);
                } else {
                    logger.info(`    ⊘ Gift card already exists (${cached.productId})`, {
                        cli: true,
                    });
                    return {
                        name: this.name,
                        processed: 0,
                        skipped: 1,
                        errors: [],
                        durationMs: Date.now() - startTime,
                    };
                }
            }

            // Step 1: Check if gift card product already exists globally
            let productId = await this.findExistingGiftCard(context);
            let createdNew = false;

            if (!productId) {
                // Step 2: Get required IDs for product creation
                const taxId = await this.getDefaultTaxId(context);
                if (!taxId) {
                    errors.push("Could not find default tax rate");
                    return {
                        name: this.name,
                        processed: 0,
                        skipped: 0,
                        errors,
                        durationMs: Date.now() - startTime,
                    };
                }

                // Step 3: Create the gift card product
                productId = await this.createGiftCardProduct(context, taxId);
                if (!productId) {
                    errors.push("Failed to create gift card product");
                    return {
                        name: this.name,
                        processed: 0,
                        skipped: 0,
                        errors,
                        durationMs: Date.now() - startTime,
                    };
                }
                createdNew = true;
                logger.info(`    ✓ Created gift card product "${GIFT_CARD_50.name}"`, {
                    cli: true,
                });

                // Step 3b: Upload product cover image
                const coverUploaded = await this.uploadProductCoverImage(context, productId);
                if (coverUploaded) {
                    logger.info(`    ✓ Uploaded gift card cover image`, { cli: true });
                }
            } else {
                logger.info(`    ⊘ Gift card product already exists globally`, { cli: true });
            }

            // Step 4: Add visibility for this SalesChannel
            const visibilityAdded = await this.addSalesChannelVisibility(context, productId);
            if (!visibilityAdded) {
                logger.info(`    ⊘ Gift card already visible in SalesChannel`, { cli: true });
            } else {
                logger.info(`    ✓ Added gift card to SalesChannel`, { cli: true });
            }

            // Step 5: Create download media if not exists
            let mediaId = await this.findExistingDownloadMedia(context, productId);
            let downloadId: string | null = null;

            if (!mediaId) {
                mediaId = await this.createDownloadMedia(context);
                if (!mediaId) {
                    errors.push("Failed to create download media");
                    return {
                        name: this.name,
                        processed: 0,
                        skipped: 0,
                        errors,
                        durationMs: Date.now() - startTime,
                    };
                }

                // Step 6: Create download association
                downloadId = await this.createProductDownload(context, productId, mediaId);
                if (!downloadId) {
                    errors.push("Failed to create product download");
                    return {
                        name: this.name,
                        processed: 0,
                        skipped: 0,
                        errors,
                        durationMs: Date.now() - startTime,
                    };
                }
                logger.info(`    ✓ Created downloadable voucher`, { cli: true });
            } else {
                logger.info(`    ⊘ Download media already exists`, { cli: true });
            }

            // Save to cache for TestingProcessor
            this.saveCache(context, {
                productId,
                mediaId: mediaId || "",
                downloadId: downloadId || "",
                createdNew,
            });

            return {
                name: this.name,
                processed: 1,
                skipped: 0,
                errors: [],
                durationMs: Date.now() - startTime,
            };
        } catch (error) {
            errors.push(
                `Digital product creation failed: ${error instanceof Error ? error.message : String(error)}`
            );
            return {
                name: this.name,
                processed: 0,
                skipped: 0,
                errors,
                durationMs: Date.now() - startTime,
            };
        }
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
     * Create the gift card product using fixture data
     */
    private async createGiftCardProduct(
        context: PostProcessorContext,
        taxId: string
    ): Promise<string | null> {
        const productId = generateUUID();

        try {
            const response = await apiPost(context, "_action/sync", {
                createProduct: {
                    entity: "product",
                    action: "upsert",
                    payload: [
                        {
                            id: productId,
                            productNumber: GIFT_CARD_50.productNumber,
                            name: GIFT_CARD_50.name,
                            description: GIFT_CARD_50.description,
                            stock: 9999,
                            taxId,
                            price: [
                                {
                                    currencyId: "b7d2554b0ce847cd82f3ac9bd1c0dfca", // EUR
                                    gross: GIFT_CARD_50.price,
                                    net: GIFT_CARD_50.price, // Gift cards are typically tax-exempt
                                    linked: false,
                                },
                            ],
                            active: true,
                            shippingFree: true, // Digital product
                            isCloseout: false,
                            markAsTopseller: false,
                        },
                    ],
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
            const token = await context.getAccessToken();
            const uploadUrl = `${context.shopwareUrl}/api/_action/media/${mediaId}/upload?extension=png&fileName=gift-card-50-cover`;

            const uploadResponse = await fetch(uploadUrl, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "image/png",
                },
                body: imageBuffer,
            });

            if (!uploadResponse.ok) {
                logger.apiError("media upload (cover)", uploadResponse.status, {});
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

            const token = await context.getAccessToken();
            const uploadUrl = `${context.shopwareUrl}/api/_action/media/${mediaId}/upload?extension=txt&fileName=gift-card-voucher`;

            const uploadResponse = await fetch(uploadUrl, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "text/plain",
                },
                body: voucherContent,
            });

            if (!uploadResponse.ok) {
                logger.apiError("media upload", uploadResponse.status, {});
                return null;
            }

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
            const token = await context.getAccessToken();
            const response = await fetch(`${context.shopwareUrl}/api/${entity}/${id}`, {
                method: "DELETE",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
            });

            return response.ok || response.status === 404;
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
