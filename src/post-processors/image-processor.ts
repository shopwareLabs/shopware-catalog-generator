/**
 * Image Processor - Uploads pre-generated product/category images to Shopware
 *
 * All AI image generation happens during blueprint hydration (Phase 2).
 * This processor only reads cached images and uploads them to Shopware:
 * 1. Reads images from local cache (generated during hydration)
 * 2. Uploads images to Shopware media
 * 3. Sets cover image and gallery images
 */

import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

import { getAllSalesChannelProductIds, searchAllByEqualsAny } from "../shopware/api-helpers.js";
import { apiPost, ConcurrencyLimiter, generateUUID, logger } from "../utils/index.js";
import { CategoryImageProcessor } from "./category-image-processor.js";
import { detectImageFormat, uploadImageWithRetry } from "./image-utils.js";

/**
 * Image Processor implementation
 */
class ImageProcessorImpl implements PostProcessor {
    readonly name = "images";
    readonly description = "Upload pre-generated product/category images to Shopware";
    readonly dependsOn: string[] = [];

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { blueprint, cache, options } = context;

        let processed = 0;
        let skipped = 0;
        const errors: string[] = [];
        const startTime = Date.now();

        const productsWithCachedImages = this.collectProductsWithCachedImages(context);
        const categoriesWithCachedImages = this.collectCategoriesWithCachedImages(context);

        const totalProducts = productsWithCachedImages.length;
        const totalCategories = categoriesWithCachedImages.length;

        if (totalProducts === 0 && totalCategories === 0) {
            logger.info(`    No cached images to upload (run blueprint hydrate first)`, {
                cli: true,
            });
            return {
                name: this.name,
                processed: 0,
                skipped: blueprint.products.length,
                errors,
                durationMs: 0,
            };
        }

        const totalImages =
            productsWithCachedImages.reduce((sum, p) => sum + p.imageCount, 0) + totalCategories;
        logger.info(`    Uploading ${totalImages} cached images to Shopware`, { cli: true });
        logger.info(`      - ${totalProducts} products with images`, { cli: true });
        logger.info(`      - ${totalCategories} category banners`, { cli: true });

        if (options.dryRun) {
            for (const { product, imageCount } of productsWithCachedImages) {
                logger.info(`    [DRY RUN] ${product.name}: ${imageCount} images to upload`, {
                    cli: true,
                });
                processed++;
            }
            for (const category of categoriesWithCachedImages) {
                logger.info(`    [DRY RUN] Category ${category.name}: banner to upload`, {
                    cli: true,
                });
            }
            return {
                name: this.name,
                processed,
                skipped,
                errors,
                durationMs: Date.now() - startTime,
            };
        }

        // Upload product images (parallel across products)
        logger.info(`    Uploading product images to Shopware...`, { cli: true });
        let uploadedProducts = 0;
        const uploadLimiter = new ConcurrencyLimiter(3);

        const uploadResults = await uploadLimiter.all(
            productsWithCachedImages.map(({ product, metadata }) => async () => {
                try {
                    const mediaToUpload: Array<{
                        mediaId: string;
                        productMediaId: string;
                        view: string;
                        base64Data: string;
                    }> = [];

                    for (const desc of metadata.imageDescriptions) {
                        const cachedImage = cache.images.loadImageWithView(
                            context.salesChannelName,
                            product.id,
                            desc.view,
                            "product_media"
                        );
                        if (cachedImage) {
                            mediaToUpload.push({
                                mediaId: generateUUID(),
                                productMediaId: generateUUID(),
                                view: desc.view,
                                base64Data: cachedImage,
                            });
                        }
                    }

                    if (mediaToUpload.length > 0) {
                        await this.uploadProductImages(
                            context,
                            product.id,
                            product.name,
                            mediaToUpload
                        );
                        return { uploaded: true, processed: true };
                    }

                    return { uploaded: false, processed: true };
                } catch (error) {
                    errors.push(
                        `Failed to upload images for ${product.name}: ${error instanceof Error ? error.message : String(error)}`
                    );
                    return { uploaded: false, processed: false };
                }
            })
        );

        for (const result of uploadResults) {
            if (result.processed) processed++;
            else skipped++;
            if (result.uploaded) uploadedProducts++;
        }

        logger.info(`    ✓ Uploaded images for ${uploadedProducts} products`, { cli: true });

        // Upload category banners (parallel)
        if (categoriesWithCachedImages.length > 0) {
            logger.info(`    Uploading category banners to Shopware...`, { cli: true });
            const categoryLimiter = new ConcurrencyLimiter(3);
            const categoryProcessor = new CategoryImageProcessor();

            const categoryResults = await categoryLimiter.all(
                categoriesWithCachedImages.map((category) => async () => {
                    try {
                        const cachedImage = cache.images.loadImageWithView(
                            context.salesChannelName,
                            category.id,
                            "banner",
                            "category_media"
                        );

                        if (cachedImage) {
                            return await categoryProcessor.uploadCategoryImage(
                                context,
                                category.id,
                                category.name,
                                cachedImage,
                                true
                            );
                        }
                        return false;
                    } catch (error) {
                        errors.push(
                            `Failed to upload banner for ${category.name}: ${error instanceof Error ? error.message : String(error)}`
                        );
                        return false;
                    }
                })
            );

            const uploadedCategories = categoryResults.filter(Boolean).length;
            logger.info(`    ✓ Uploaded banners for ${uploadedCategories} categories`, {
                cli: true,
            });
        }

        return {
            name: this.name,
            processed,
            skipped,
            errors,
            durationMs: Date.now() - startTime,
        };
    }

    private collectProductsWithCachedImages(context: PostProcessorContext): Array<{
        product: PostProcessorContext["blueprint"]["products"][0];
        metadata: NonNullable<ReturnType<typeof context.cache.loadProductMetadata>>;
        imageCount: number;
    }> {
        const result: Array<{
            product: PostProcessorContext["blueprint"]["products"][0];
            metadata: NonNullable<ReturnType<typeof context.cache.loadProductMetadata>>;
            imageCount: number;
        }> = [];

        for (const product of context.blueprint.products) {
            const metadata = context.cache.loadProductMetadata(
                context.salesChannelName,
                product.id
            );
            if (!metadata || metadata.imageDescriptions.length === 0) continue;

            const imageCount = metadata.imageDescriptions.filter((desc) =>
                context.cache.images.hasImageWithView(
                    context.salesChannelName,
                    product.id,
                    desc.view,
                    "product_media"
                )
            ).length;

            if (imageCount > 0) {
                result.push({ product, metadata, imageCount });
            }
        }

        return result;
    }

    private collectCategoriesWithCachedImages(
        context: PostProcessorContext
    ): PostProcessorContext["blueprint"]["categories"] {
        return this.flattenCategories(context.blueprint.categories).filter(
            (c) =>
                c.hasImage &&
                c.imageDescription &&
                context.cache.images.hasImageWithView(
                    context.salesChannelName,
                    c.id,
                    "banner",
                    "category_media"
                )
        );
    }

    private flattenCategories(
        categories: PostProcessorContext["blueprint"]["categories"]
    ): PostProcessorContext["blueprint"]["categories"] {
        const result: PostProcessorContext["blueprint"]["categories"] = [];

        const traverse = (cats: typeof categories) => {
            for (const cat of cats) {
                result.push(cat);
                if (cat.children.length > 0) {
                    traverse(cat.children);
                }
            }
        };

        traverse(categories);
        return result;
    }

    /**
     * Upload product images to Shopware
     */
    private async uploadProductImages(
        context: PostProcessorContext,
        productId: string,
        productName: string,
        images: Array<{
            mediaId: string;
            productMediaId: string;
            view: string;
            base64Data: string;
        }>
    ): Promise<void> {
        const hasExistingImages = await this.productHasImages(context, productId);
        if (hasExistingImages) {
            logger.info(`      ✓ ${this.truncateName(productName)}: reused existing images`, {
                cli: true,
            });
            return;
        }

        // Get or create Product Media folder
        const mediaFolderId = await this.getProductMediaFolderId(context);

        // Process each image: check for existing media or create new
        const sanitizedName = productName.replace(/[^a-zA-Z0-9]/g, "-");
        const mediaToLink: Array<{
            mediaId: string;
            productMediaId: string;
            isNew: boolean;
            view: string;
            base64Data: string;
        }> = [];

        const shortName = this.truncateName(productName);

        for (const img of images) {
            const fileName = `${sanitizedName}-${img.view}`;
            const existingMediaId = await this.findMediaByFileName(context, fileName);

            if (existingMediaId) {
                // Reuse existing media (logged as summary at end)
                mediaToLink.push({
                    mediaId: existingMediaId,
                    productMediaId: img.productMediaId,
                    isNew: false,
                    view: img.view,
                    base64Data: img.base64Data,
                });
            } else {
                // Need to create new media
                mediaToLink.push({
                    mediaId: img.mediaId,
                    productMediaId: img.productMediaId,
                    isNew: true,
                    view: img.view,
                    base64Data: img.base64Data,
                });
            }
        }

        // Create only NEW media entities
        const newMedia = mediaToLink.filter((m) => m.isNew);
        if (newMedia.length > 0) {
            const mediaPayload = newMedia.map((img) => ({
                id: img.mediaId,
                private: false,
                ...(mediaFolderId && { mediaFolderId }),
            }));

            const mediaResponse = await apiPost(context, "_action/sync", {
                createMedia: {
                    entity: "media",
                    action: "upsert",
                    payload: mediaPayload,
                },
            });

            if (!mediaResponse.ok) {
                const errorText = await mediaResponse.text();
                logger.apiError("_action/sync (create media)", mediaResponse.status, {
                    productId,
                    error: errorText,
                });
                throw new Error(`Failed to create media entities: ${mediaResponse.status}`);
            }
        }

        // Create product_media relations for ALL media (new and existing)
        const productMediaPayload = mediaToLink.map((img, index) => ({
            id: img.productMediaId,
            productId,
            mediaId: img.mediaId,
            position: index,
        }));

        // Set cover image (first image)
        const firstMedia = mediaToLink[0];
        if (!firstMedia) {
            return; // No images to link
        }
        const coverUpdate = {
            id: productId,
            coverId: firstMedia.productMediaId,
        };

        // Sync product_media relations and cover
        const syncResponse = await apiPost(context, "_action/sync", {
            createProductMedia: {
                entity: "product_media",
                action: "upsert",
                payload: productMediaPayload,
            },
            updateCover: {
                entity: "product",
                action: "upsert",
                payload: [coverUpdate],
            },
        });

        if (!syncResponse.ok) {
            const errorText = await syncResponse.text();
            logger.apiError("_action/sync (product_media)", syncResponse.status, {
                productId,
                productName,
                error: errorText,
            });
            throw new Error(`Failed to link media to product: ${syncResponse.status}`);
        }

        // Upload actual image files for NEW media only (parallel, with retry for transient failures)
        let uploadedCount = 0;
        let duplicateCount = 0;
        const fileLimiter = new ConcurrencyLimiter(5);

        const fileResults = await fileLimiter.all(
            newMedia.map((img) => async () => {
                const imageBuffer = Buffer.from(img.base64Data, "base64");
                const fileName = `${sanitizedName}-${img.view}`;

                const format = detectImageFormat(imageBuffer);

                try {
                    const uploadResponse = await uploadImageWithRetry(
                        context,
                        img.mediaId,
                        fileName,
                        imageBuffer,
                        format
                    );

                    if (!uploadResponse.ok) {
                        const errorText = await uploadResponse.text();

                        // Skip if file already exists (not an error)
                        if (errorText.includes("MEDIA_DUPLICATED_FILE_NAME")) {
                            return "duplicate" as const;
                        }

                        logger.apiError("_action/media/upload", uploadResponse.status, {
                            mediaId: img.mediaId,
                            view: img.view,
                            error: errorText,
                        });
                        logger.error(
                            `      ✗ ${shortName} (${img.view}) upload failed: ${uploadResponse.status}`,
                            { cli: true }
                        );
                        return "error" as const;
                    }
                    return "uploaded" as const;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.error(`Failed to upload image after retries`, {
                        data: {
                            mediaId: img.mediaId,
                            view: img.view,
                            error: message,
                        },
                    });
                    logger.error(`      ✗ ${shortName} (${img.view}) upload failed: ${message}`, {
                        cli: true,
                    });
                    return "error" as const;
                }
            })
        );

        for (const result of fileResults) {
            if (result === "uploaded") uploadedCount++;
            if (result === "duplicate") duplicateCount++;
        }

        // Log summary for this product
        const reusedMedia = mediaToLink.filter((m) => !m.isNew);
        const reusedCount = reusedMedia.length + duplicateCount;
        if (uploadedCount > 0 && reusedCount > 0) {
            logger.info(`      ✓ ${shortName}: ${uploadedCount} uploaded, ${reusedCount} reused`, {
                cli: true,
            });
        } else if (uploadedCount > 0) {
            logger.info(`      ✓ ${shortName}: ${uploadedCount} uploaded`, { cli: true });
        } else if (reusedCount > 0) {
            logger.info(`      ✓ ${shortName}: ${reusedCount} images reused`, { cli: true });
        }
    }

    private productMediaFolderId: string | null = null;
    private productsWithImages: Set<string> = new Set();

    /**
     * Check if product already has images in Shopware
     */
    private async productHasImages(
        context: PostProcessorContext,
        productId: string
    ): Promise<boolean> {
        // Use cached result if available
        if (this.productsWithImages.has(productId)) {
            return true;
        }

        try {
            interface ProductMediaResponse {
                data?: Array<{
                    id: string;
                    coverId?: string | null;
                    media?: Array<{ id: string }>;
                }>;
            }
            const response = await apiPost(context, "search/product", {
                ids: [productId],
                associations: { media: {} },
            });

            if (response.ok) {
                const data = (await response.json()) as ProductMediaResponse;
                const product = data.data?.[0];
                if (product && ((product.media && product.media.length > 0) || product.coverId)) {
                    this.productsWithImages.add(productId);
                    return true;
                }
            }
        } catch {
            // On error, assume no images (will try to upload)
        }

        return false;
    }

    // Cache for media filename lookups
    private mediaFileNameCache: Map<string, string> = new Map();

    /**
     * Find existing media by filename
     */
    private async findMediaByFileName(
        context: PostProcessorContext,
        fileName: string
    ): Promise<string | null> {
        // Check cache first
        const cached = this.mediaFileNameCache.get(fileName);
        if (cached) {
            return cached;
        }

        try {
            interface MediaSearchResponse {
                data?: Array<{ id: string }>;
            }
            const response = await apiPost(context, "search/media", {
                filter: [{ type: "equals", field: "fileName", value: fileName }],
                limit: 1,
            });

            if (response.ok) {
                const data = (await response.json()) as MediaSearchResponse;
                const media = data.data?.[0];
                if (media) {
                    this.mediaFileNameCache.set(fileName, media.id);
                    return media.id;
                }
            }
        } catch {
            // On error, assume no existing media
        }

        return null;
    }

    /**
     * Get Product Media folder ID (cached)
     */
    private async getProductMediaFolderId(context: PostProcessorContext): Promise<string | null> {
        if (this.productMediaFolderId) {
            return this.productMediaFolderId;
        }

        try {
            const response = await apiPost(context, "search/media-folder", {
                filter: [{ type: "equals", field: "name", value: "Product Media" }],
                limit: 1,
            });

            if (response.ok) {
                const data = (await response.json()) as { data?: Array<{ id: string }> };
                const firstFolder = data.data?.[0];
                if (firstFolder) {
                    this.productMediaFolderId = firstFolder.id;
                    logger.info(`    Found Product Media folder`, { cli: true });
                    return this.productMediaFolderId;
                }
            }
        } catch (error) {
            logger.warn("Could not find Product Media folder", { data: error });
        }

        return null;
    }

    /**
     * Truncate name for cleaner log output
     */
    private truncateName(name: string, maxLength = 30): string {
        return name.length > maxLength ? `${name.slice(0, maxLength)}...` : name;
    }

    /**
     * Cleanup images for products in the SalesChannel
     *
     * 1. Get all products in the SalesChannel
     * 2. Find product_media entries for those products
     * 3. Delete product_media entries
     * 4. Delete orphaned media entities
     * 5. Clear category.mediaId for categories under SalesChannel root
     */
    async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        const errors: string[] = [];
        let deleted = 0;

        if (context.options.dryRun) {
            logger.info(`    [DRY RUN] Would delete images for products in SalesChannel`, {
                cli: true,
            });
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        if (!context.api) {
            errors.push("API helpers not available - cannot perform cleanup");
            return { name: this.name, deleted: 0, errors, durationMs: 0 };
        }

        try {
            // Step 1: Get all products in this SalesChannel
            const productIds = await getAllSalesChannelProductIds(context);

            if (productIds.length === 0) {
                logger.info(`    No products found in SalesChannel`, { cli: true });
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            logger.info(`    Found ${productIds.length} products in SalesChannel`, { cli: true });

            // Step 2: Find all product_media entries for these products
            const productMedia = await searchAllByEqualsAny<{ id: string; mediaId: string }>(
                context,
                "product-media",
                "productId",
                productIds,
                { includes: { product_media: ["id", "mediaId"] } }
            );

            if (productMedia.length > 0) {
                logger.info(`    Found ${productMedia.length} product media entries`, {
                    cli: true,
                });

                // Collect media IDs before deleting product_media
                const mediaIds = productMedia.map((pm) => pm.mediaId);

                // Step 3: Delete product_media entries
                const productMediaIds = productMedia.map((pm) => pm.id);
                await context.api.deleteEntities("product_media", productMediaIds);
                deleted += productMediaIds.length;
                logger.info(`    ✓ Deleted ${productMediaIds.length} product_media entries`, {
                    cli: true,
                });

                // Step 4: Delete the actual media entities (only if not used elsewhere)
                for (const mediaId of mediaIds) {
                    try {
                        await context.api.deleteEntity("media", mediaId);
                        deleted++;
                    } catch {
                        // Media might still be in use elsewhere, skip
                    }
                }
            } else {
                logger.info(`    No product media found`, { cli: true });
            }

            // Step 5: Clear category banners under SalesChannel root
            const categoryProcessor = new CategoryImageProcessor();
            await categoryProcessor.cleanupCategoryImages(context);
        } catch (error) {
            errors.push(
                `Image cleanup failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        return { name: this.name, deleted, errors, durationMs: 0 };
    }
}

/** Image processor singleton */
export const ImageProcessor = new ImageProcessorImpl();
