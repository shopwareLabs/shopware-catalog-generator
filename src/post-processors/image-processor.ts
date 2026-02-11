/**
 * Image Processor - Generates and uploads product images
 *
 * Reads imageDescriptions from product metadata (cache) and:
 * 1. Generates images using the AI image provider
 * 2. Uploads images to Shopware
 * 3. Sets cover image and gallery images
 */

import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

import {
    apiPost,
    apiUpload,
    buildImagePrompt,
    ConcurrencyLimiter,
    executeWithRetry,
    generateUUID,
    logger,
} from "../utils/index.js";

/**
 * Image Processor implementation
 */
class ImageProcessorImpl implements PostProcessor {
    readonly name = "images";
    readonly description = "Generate and upload product images";
    readonly dependsOn: string[] = []; // No dependencies

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { blueprint, cache, imageProvider, options } = context;

        if (!imageProvider) {
            return {
                name: this.name,
                processed: 0,
                skipped: blueprint.products.length,
                errors: ["No image provider configured"],
                durationMs: 0,
            };
        }

        let processed = 0;
        const skipped = 0;
        const errors: string[] = [];
        const startTime = Date.now();

        // Count products that need image processing
        const products = blueprint.products;
        const productsNeedingImages: Array<{
            product: (typeof products)[0];
            metadata: NonNullable<ReturnType<typeof cache.loadProductMetadata>>;
            missingCount: number;
            cachedCount: number;
            staleCount: number;
            shouldCleanup: boolean;
        }> = [];

        for (const product of products) {
            const metadata = cache.loadProductMetadata(context.salesChannelName, product.id);
            if (metadata && metadata.imageDescriptions.length > 0) {
                let cachedCount = 0;
                let missingCount = 0;
                let staleCount = 0;

                for (const desc of metadata.imageDescriptions) {
                    const hasImage = cache.hasImageWithView(
                        context.salesChannelName,
                        product.id,
                        desc.view
                    );

                    if (!hasImage) {
                        missingCount++;
                    } else {
                        // Check if cached image is stale (prompt mismatch)
                        const basePrompt = metadata.baseImagePrompt || product.name;
                        const isStale = cache.isImageStale(
                            context.salesChannelName,
                            product.id,
                            desc.view,
                            basePrompt
                        );

                        if (isStale) {
                            // Delete stale image so it gets regenerated
                            cache.deleteImageWithView(
                                context.salesChannelName,
                                product.id,
                                desc.view
                            );
                            staleCount++;
                            missingCount++;
                        } else {
                            cachedCount++;
                        }
                    }
                }

                if (missingCount > 0 || cachedCount > 0) {
                    productsNeedingImages.push({
                        product,
                        metadata,
                        missingCount,
                        cachedCount,
                        staleCount,
                        shouldCleanup: missingCount > 0 || staleCount > 0,
                    });
                }
            }
        }

        // Count category banners needing generation
        const categoriesWithImages = this.flattenCategories(blueprint.categories).filter(
            (c) => c.hasImage && c.imageDescription
        );
        const categoriesNeedingImages = categoriesWithImages.filter(
            (c) => !cache.hasImageWithView(context.salesChannelName, c.id, "banner")
        );

        const totalProductImages = productsNeedingImages.reduce(
            (sum, p) => sum + p.missingCount,
            0
        );
        const totalStaleImages = productsNeedingImages.reduce((sum, p) => sum + p.staleCount, 0);
        const totalCategoryImages = categoriesNeedingImages.length;
        const totalImages = totalProductImages + totalCategoryImages;

        if (totalImages === 0 && productsNeedingImages.length === 0) {
            logger.cli(`    No images to generate or upload`);
            return {
                name: this.name,
                processed: 0,
                skipped: products.length,
                errors,
                durationMs: 0,
            };
        }

        logger.cli(`    Image generation: ${totalImages} images to generate`);
        logger.cli(
            `      - ${totalProductImages} product images (${productsNeedingImages.length} products)`
        );
        if (totalStaleImages > 0) {
            logger.cli(`      - ${totalStaleImages} stale images (product name changed)`);
        }
        logger.cli(`      - ${totalCategoryImages} category banners`);

        if (options.dryRun) {
            for (const {
                product,
                missingCount,
                cachedCount,
                staleCount,
            } of productsNeedingImages) {
                const staleInfo = staleCount > 0 ? ` (${staleCount} stale)` : "";
                logger.cli(
                    `    [DRY RUN] ${product.name}: ${missingCount} to generate${staleInfo}, ${cachedCount} cached`
                );
                processed++;
            }
            for (const category of categoriesNeedingImages) {
                logger.cli(`    [DRY RUN] Category ${category.name}: banner to generate`);
            }
            return {
                name: this.name,
                processed,
                skipped,
                errors,
                durationMs: Date.now() - startTime,
            };
        }

        // Create concurrency limiter based on provider capabilities
        const maxConcurrency = imageProvider.maxConcurrency || 2;
        const limiter = new ConcurrencyLimiter(maxConcurrency);

        // Collect all image generation tasks
        type ImageTask = {
            type: "product" | "category";
            id: string;
            name: string;
            view: string;
            prompt: string;
        };

        const imageTasks: ImageTask[] = [];

        // Add product image tasks
        for (const { product, metadata } of productsNeedingImages) {
            for (const desc of metadata.imageDescriptions) {
                if (!cache.hasImageWithView(context.salesChannelName, product.id, desc.view)) {
                    const prompt = metadata.baseImagePrompt
                        ? buildImagePrompt(metadata.baseImagePrompt, desc.view)
                        : desc.prompt;
                    imageTasks.push({
                        type: "product",
                        id: product.id,
                        name: product.name,
                        view: desc.view,
                        prompt,
                    });
                }
            }
        }

        // Add category banner tasks
        for (const category of categoriesNeedingImages) {
            imageTasks.push({
                type: "category",
                id: category.id,
                name: category.name,
                view: "banner",
                prompt: category.imageDescription || `Banner image for ${category.name} category`,
            });
        }

        // Process all images with concurrency limiting
        if (imageTasks.length > 0) {
            logger.cli(
                `    Generating ${imageTasks.length} images (${maxConcurrency} parallel, ${imageProvider.name})...`
            );
            const taskStartTime = Date.now();

            const results = await limiter.all(
                imageTasks.map((task, index) => async () => {
                    const shortName = this.truncateName(task.name);
                    const taskNum = index + 1;
                    logger.cli(
                        `      [${taskNum}/${imageTasks.length}] ${task.type === "category" ? "📁" : "📦"} ${shortName} (${task.view})`
                    );

                    try {
                        // Use retry logic for transient failures (rate limits, timeouts)
                        const imageData = await executeWithRetry(
                            async () => {
                                const result = await imageProvider.generateImage(task.prompt);
                                // Treat null as retriable failure
                                if (!result) {
                                    throw new Error("Image generation returned null");
                                }
                                return result;
                            },
                            {
                                maxRetries: 3,
                                baseDelay: 5000, // 5s, 10s, 20s backoff
                            }
                        );

                        cache.saveImageWithView(
                            context.salesChannelName,
                            task.id,
                            task.view,
                            imageData,
                            task.prompt,
                            imageProvider.name
                        );
                        return { success: true, task };
                    } catch (error) {
                        const errorMsg = error instanceof Error ? error.message : String(error);
                        errors.push(`${task.type} ${task.name} (${task.view}): ${errorMsg}`);
                        return { success: false, task, error: errorMsg };
                    }
                })
            );

            const successCount = results.filter((r) => r.success).length;
            const elapsed = ((Date.now() - taskStartTime) / 1000).toFixed(1);
            logger.cli(
                `    ✓ Generated ${successCount}/${imageTasks.length} images in ${elapsed}s`
            );
        }

        // Now upload product images to Shopware (parallel across products)
        logger.cli(`    Uploading product images to Shopware...`);
        let uploadedProducts = 0;
        const uploadLimiter = new ConcurrencyLimiter(3);

        const uploadResults = await uploadLimiter.all(
            productsNeedingImages.map(({ product, metadata, shouldCleanup }) => async () => {
                try {
                    // Collect all cached images for upload
                    const mediaToUpload: Array<{
                        mediaId: string;
                        productMediaId: string;
                        view: string;
                        base64Data: string;
                    }> = [];

                    for (const desc of metadata.imageDescriptions) {
                        const cachedImage = cache.loadImageWithView(
                            context.salesChannelName,
                            product.id,
                            desc.view
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

                    // Upload images to Shopware
                    if (mediaToUpload.length > 0) {
                        await this.uploadProductImages(
                            context,
                            product.id,
                            product.name,
                            mediaToUpload,
                            shouldCleanup
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
            if (result.uploaded) uploadedProducts++;
        }

        logger.cli(`    ✓ Uploaded images for ${uploadedProducts} products`);

        // Now upload category banners to Shopware (parallel)
        if (categoriesWithImages.length > 0) {
            logger.cli(`    Uploading category banners to Shopware...`);
            let uploadedCategories = 0;
            const categoriesToRebuild = new Set(categoriesNeedingImages.map((c) => c.id));
            const categoryLimiter = new ConcurrencyLimiter(3);

            const categoryResults = await categoryLimiter.all(
                categoriesWithImages.map((category) => async () => {
                    try {
                        const cachedImage = cache.loadImageWithView(
                            context.salesChannelName,
                            category.id,
                            "banner"
                        );

                        if (cachedImage) {
                            return await this.uploadCategoryImage(
                                context,
                                category.id,
                                category.name,
                                cachedImage,
                                categoriesToRebuild.has(category.id)
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

            uploadedCategories = categoryResults.filter(Boolean).length;
            logger.cli(`    ✓ Uploaded banners for ${uploadedCategories} categories`);
        }

        return {
            name: this.name,
            processed,
            skipped,
            errors,
            durationMs: Date.now() - startTime,
        };
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
        }>,
        shouldCleanup: boolean
    ): Promise<void> {
        // First check if product already has images in Shopware
        const hasExistingImages = await this.productHasImages(context, productId);
        if (hasExistingImages && shouldCleanup) {
            await this.cleanupProductImages(context, productId, productName);
        }
        if (hasExistingImages && !shouldCleanup) {
            logger.cli(`      ⊘ Product already has images in Shopware, skipped`);
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

                // Detect image format from magic bytes
                const format = this.detectImageFormat(imageBuffer);

                try {
                    const uploadResponse = await this.uploadImageWithRetry(
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
                        logger.cli(
                            `      ✗ ${shortName} (${img.view}) upload failed: ${uploadResponse.status}`,
                            "error"
                        );
                        return "error" as const;
                    }
                    return "uploaded" as const;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.error(`Failed to upload image after retries`, {
                        mediaId: img.mediaId,
                        view: img.view,
                        error: message,
                    });
                    logger.cli(
                        `      ✗ ${shortName} (${img.view}) upload failed: ${message}`,
                        "error"
                    );
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
            logger.cli(`      ✓ ${shortName}: ${uploadedCount} uploaded, ${reusedCount} reused`);
        } else if (uploadedCount > 0) {
            logger.cli(`      ✓ ${shortName}: ${uploadedCount} uploaded`);
        } else if (reusedCount > 0) {
            logger.cli(`      ⊘ ${shortName}: ${reusedCount} images reused`);
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
                    logger.cli(`    Found Product Media folder`);
                    return this.productMediaFolderId;
                }
            }
        } catch (error) {
            logger.warn("Could not find Product Media folder", { error });
        }

        return null;
    }

    // Cache for category media folder ID
    private categoryMediaFolderId: string | null = null;

    /**
     * Get Category Media folder ID (cached)
     */
    private async getCategoryMediaFolderId(context: PostProcessorContext): Promise<string | null> {
        if (this.categoryMediaFolderId) {
            return this.categoryMediaFolderId;
        }

        try {
            // First try to find the default folder for categories
            const defaultFolderResponse = await apiPost(context, "search/media-default-folder", {
                limit: 1,
                filter: [{ type: "equals", field: "entity", value: "category" }],
                associations: { folder: {} },
            });

            if (defaultFolderResponse.ok) {
                const data = (await defaultFolderResponse.json()) as {
                    data?: Array<{ folder?: { id: string } }>;
                };
                const folder = data.data?.[0]?.folder;
                if (folder) {
                    this.categoryMediaFolderId = folder.id;
                    return this.categoryMediaFolderId;
                }
            }

            // Fallback: search for folder by name
            const response = await apiPost(context, "search/media-folder", {
                filter: [{ type: "equals", field: "name", value: "Category Media" }],
                limit: 1,
            });

            if (response.ok) {
                const data = (await response.json()) as { data?: Array<{ id: string }> };
                const firstFolder = data.data?.[0];
                if (firstFolder) {
                    this.categoryMediaFolderId = firstFolder.id;
                    return this.categoryMediaFolderId;
                }
            }
        } catch (error) {
            logger.warn("Could not find Category Media folder", { error });
        }

        return null;
    }

    // Cache for category media IDs
    private categoryMediaIds: Map<string, string> = new Map();

    /**
     * Get category media ID (cached)
     */
    private async getCategoryMediaId(
        context: PostProcessorContext,
        categoryId: string
    ): Promise<string | null> {
        const cached = this.categoryMediaIds.get(categoryId);
        if (cached) {
            return cached;
        }

        try {
            interface CategoryResponse {
                data?: Array<{ id: string; mediaId?: string | null }>;
            }
            const response = await apiPost(context, "search/category", {
                ids: [categoryId],
                includes: { category: ["id", "mediaId"] },
            });

            if (response.ok) {
                const data = (await response.json()) as CategoryResponse;
                const category = data.data?.[0];
                if (category?.mediaId) {
                    this.categoryMediaIds.set(categoryId, category.mediaId);
                    return category.mediaId;
                }
            }
        } catch {
            // On error, assume no image
        }

        return null;
    }

    /**
     * Upload category banner image to Shopware
     */
    private async uploadCategoryImage(
        context: PostProcessorContext,
        categoryId: string,
        categoryName: string,
        base64Data: string,
        shouldCleanup: boolean
    ): Promise<boolean> {
        // Check if category already has an image and clear it if so
        const existingCategoryMediaId = await this.getCategoryMediaId(context, categoryId);
        if (existingCategoryMediaId && shouldCleanup) {
            await this.clearCategoryImage(
                context,
                categoryId,
                categoryName,
                existingCategoryMediaId
            );
        }
        if (existingCategoryMediaId && !shouldCleanup) {
            logger.cli(`      ⊘ Category "${categoryName}" already has image, skipped`);
            return false;
        }

        const sanitizedName = categoryName.replace(/[^a-zA-Z0-9]/g, "-");
        const fileName = `${sanitizedName}-banner`;

        // Check if media with this filename already exists
        const existingFileMediaId = await this.findMediaByFileName(context, fileName);
        let mediaId: string;

        let isExistingMedia = false;
        if (existingFileMediaId) {
            // Reuse existing media
            mediaId = existingFileMediaId;
            isExistingMedia = true;
        } else {
            // Create new media entity
            mediaId = generateUUID();
            const mediaFolderId = await this.getCategoryMediaFolderId(context);

            const createMediaResponse = await apiPost(context, "_action/sync", {
                createMedia: {
                    entity: "media",
                    action: "upsert",
                    payload: [
                        {
                            id: mediaId,
                            private: false,
                            ...(mediaFolderId && { mediaFolderId }),
                        },
                    ],
                },
            });

            if (!createMediaResponse.ok) {
                const errorText = await createMediaResponse.text();
                logger.apiError(
                    "_action/sync (create category media)",
                    createMediaResponse.status,
                    {
                        categoryId,
                        error: errorText,
                    }
                );
                throw new Error(`Failed to create media entity: ${createMediaResponse.status}`);
            }

            // Upload the image file (with retry for transient failures)
            const imageBuffer = Buffer.from(base64Data, "base64");
            const format = this.detectImageFormat(imageBuffer);

            const uploadResponse = await this.uploadImageWithRetry(
                context,
                mediaId,
                fileName,
                imageBuffer,
                format
            );

            if (!uploadResponse.ok) {
                const errorText = await uploadResponse.text();

                // Skip if file already exists
                if (!errorText.includes("MEDIA_DUPLICATED_FILE_NAME")) {
                    logger.apiError("_action/media/upload (category)", uploadResponse.status, {
                        categoryId,
                        error: errorText,
                    });
                    throw new Error(`Failed to upload category image: ${uploadResponse.status}`);
                }
            }
        }

        // Update category with the media ID
        const updateResponse = await apiPost(context, "_action/sync", {
            updateCategory: {
                entity: "category",
                action: "upsert",
                payload: [
                    {
                        id: categoryId,
                        mediaId,
                    },
                ],
            },
        });

        if (!updateResponse.ok) {
            const errorText = await updateResponse.text();
            logger.apiError("_action/sync (update category mediaId)", updateResponse.status, {
                categoryId,
                error: errorText,
            });
            throw new Error(`Failed to update category with image: ${updateResponse.status}`);
        }

        if (isExistingMedia) {
            logger.cli(`      ⊘ Linked existing banner for "${categoryName}"`);
        } else {
            logger.cli(`      ✓ Uploaded banner for "${categoryName}"`);
        }
        return true;
    }

    /**
     * Remove existing product images before re-upload
     */
    private async cleanupProductImages(
        context: PostProcessorContext,
        productId: string,
        productName: string
    ): Promise<void> {
        if (!context.api) {
            logger.cli(`      ⊘ ${this.truncateName(productName)}: cleanup skipped (no API)`);
            return;
        }

        const productMedia = await context.api.searchEntities<{ id: string; mediaId: string }>(
            "product-media",
            [{ type: "equals", field: "productId", value: productId }],
            { limit: 500 }
        );

        if (productMedia.length === 0) {
            return;
        }

        const productMediaIds = productMedia.map((pm) => pm.id);
        const mediaIds = productMedia.map((pm) => pm.mediaId);

        await context.api.deleteEntities("product_media", productMediaIds);

        for (const mediaId of mediaIds) {
            try {
                await context.api.deleteEntity("media", mediaId);
            } catch {
                // Media may still be in use elsewhere
            }
        }

        this.productsWithImages.delete(productId);
        logger.cli(
            `      ✓ ${this.truncateName(productName)}: cleaned up ${productMediaIds.length} images`
        );
    }

    /**
     * Remove existing category image before re-upload
     */
    private async clearCategoryImage(
        context: PostProcessorContext,
        categoryId: string,
        categoryName: string,
        mediaId: string
    ): Promise<void> {
        if (!context.api) {
            logger.cli(`      ⊘ Category "${categoryName}": cleanup skipped (no API)`);
            return;
        }

        await context.api.syncEntities({
            clearCategoryMedia: {
                entity: "category",
                action: "upsert",
                payload: [
                    {
                        id: categoryId,
                        mediaId: null,
                    },
                ],
            },
        });

        try {
            await context.api.deleteEntity("media", mediaId);
        } catch {
            // Media may still be in use elsewhere
        }

        this.categoryMediaIds.delete(categoryId);
        logger.cli(`      ✓ Cleared existing banner for "${categoryName}"`);
    }

    /**
     * Detect image format from magic bytes
     */
    private detectImageFormat(buffer: Buffer): { extension: string; mimeType: string } {
        // Check first bytes for magic numbers
        if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
            return { extension: "jpg", mimeType: "image/jpeg" };
        }
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
            return { extension: "png", mimeType: "image/png" };
        }
        if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
            return { extension: "gif", mimeType: "image/gif" };
        }
        if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
            // RIFF header - could be WEBP
            if (
                buffer[8] === 0x57 &&
                buffer[9] === 0x45 &&
                buffer[10] === 0x42 &&
                buffer[11] === 0x50
            ) {
                return { extension: "webp", mimeType: "image/webp" };
            }
        }
        // Default to JPEG (most common from Pollinations)
        return { extension: "jpg", mimeType: "image/jpeg" };
    }

    /**
     * Upload image with retry logic for transient failures
     * Retries on rate limits, timeouts, and 5xx errors
     */
    private async uploadImageWithRetry(
        context: PostProcessorContext,
        mediaId: string,
        fileName: string,
        imageBuffer: Buffer,
        format: { extension: string; mimeType: string }
    ): Promise<Response> {
        const endpoint = `_action/media/${mediaId}/upload?extension=${format.extension}&fileName=${encodeURIComponent(fileName)}`;

        return executeWithRetry(
            async () => {
                const response = await apiUpload(context, endpoint, imageBuffer, format.mimeType);

                // Retry on 5xx server errors
                if (response.status >= 500 && response.status < 600) {
                    const error = new Error(`Server error: ${response.status}`);
                    (error as unknown as { status: number }).status = 429; // Trick rate limit detection
                    throw error;
                }

                return response;
            },
            {
                maxRetries: 3,
                baseDelay: 2000, // 2s, 4s, 8s
            }
        );
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
            logger.cli(`    [DRY RUN] Would delete images for products in SalesChannel`);
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        if (!context.api) {
            errors.push("API helpers not available - cannot perform cleanup");
            return { name: this.name, deleted: 0, errors, durationMs: 0 };
        }

        try {
            // Step 1: Get all products in this SalesChannel
            const products = await context.api.searchEntities<{ id: string }>(
                "product",
                [
                    {
                        type: "equals",
                        field: "visibilities.salesChannelId",
                        value: context.salesChannelId,
                    },
                ],
                { limit: 500 }
            );

            if (products.length === 0) {
                logger.cli(`    No products found in SalesChannel`);
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            const productIds = products.map((p) => p.id);
            logger.cli(`    Found ${productIds.length} products in SalesChannel`);

            // Step 2: Find all product_media entries for these products
            const productMedia = await context.api.searchEntities<{ id: string; mediaId: string }>(
                "product-media",
                [{ type: "equalsAny" as "equals", field: "productId", value: productIds }],
                { limit: 500 }
            );

            if (productMedia.length > 0) {
                logger.cli(`    Found ${productMedia.length} product media entries`);

                // Collect media IDs before deleting product_media
                const mediaIds = productMedia.map((pm) => pm.mediaId);

                // Step 3: Delete product_media entries
                const productMediaIds = productMedia.map((pm) => pm.id);
                await context.api.deleteEntities("product_media", productMediaIds);
                deleted += productMediaIds.length;
                logger.cli(`    ✓ Deleted ${productMediaIds.length} product_media entries`);

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
                logger.cli(`    No product media found`);
            }

            // Step 5: Get SalesChannel to find root category
            const salesChannel = await context.api.getSalesChannelByName(context.salesChannelName);
            if (salesChannel) {
                // Find categories under the root and clear their mediaId
                const categories = await context.api.searchEntities<{
                    id: string;
                    mediaId?: string;
                }>(
                    "category",
                    [
                        {
                            type: "multi",
                            operator: "or",
                            queries: [
                                {
                                    type: "equals",
                                    field: "parentId",
                                    value: salesChannel.navigationCategoryId,
                                },
                                {
                                    type: "contains",
                                    field: "path",
                                    value: salesChannel.navigationCategoryId,
                                },
                            ],
                        },
                    ],
                    { limit: 500 }
                );

                const categoriesWithMedia = categories.filter((c) => c.mediaId);
                if (categoriesWithMedia.length > 0) {
                    const categoryUpdates = categoriesWithMedia.map((c) => ({
                        id: c.id,
                        mediaId: null,
                    }));
                    await context.api.syncEntities({
                        clearCategoryMedia: {
                            entity: "category",
                            action: "upsert",
                            payload: categoryUpdates,
                        },
                    });
                    logger.cli(`    ✓ Cleared media from ${categoriesWithMedia.length} categories`);
                }
            }
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
