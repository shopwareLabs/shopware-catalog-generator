/**
 * Image Processor - Generates and uploads product images
 *
 * Reads imageDescriptions from product metadata (cache) and:
 * 1. Generates images using the AI image provider
 * 2. Uploads images to Shopware
 * 3. Sets cover image and gallery images
 */

import { buildImagePrompt, ConcurrencyLimiter, executeWithRetry, logger } from "../utils/index.js";

import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

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
        }> = [];

        for (const product of products) {
            const metadata = cache.loadProductMetadata(context.salesChannelName, product.id);
            if (metadata && metadata.imageDescriptions.length > 0) {
                const cachedCount = metadata.imageDescriptions.filter((desc) =>
                    cache.hasImageWithView(context.salesChannelName, product.id, desc.view)
                ).length;
                const missingCount = metadata.imageDescriptions.length - cachedCount;

                if (missingCount > 0 || cachedCount > 0) {
                    productsNeedingImages.push({ product, metadata, missingCount, cachedCount });
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
        const totalCategoryImages = categoriesNeedingImages.length;
        const totalImages = totalProductImages + totalCategoryImages;

        if (totalImages === 0 && productsNeedingImages.length === 0) {
            console.log(`    No images to generate or upload`);
            return {
                name: this.name,
                processed: 0,
                skipped: products.length,
                errors,
                durationMs: 0,
            };
        }

        console.log(`    Image generation: ${totalImages} images to generate`);
        console.log(
            `      - ${totalProductImages} product images (${productsNeedingImages.length} products)`
        );
        console.log(`      - ${totalCategoryImages} category banners`);

        if (options.dryRun) {
            for (const { product, missingCount, cachedCount } of productsNeedingImages) {
                console.log(
                    `    [DRY RUN] ${product.name}: ${missingCount} to generate, ${cachedCount} cached`
                );
                processed++;
            }
            for (const category of categoriesNeedingImages) {
                console.log(`    [DRY RUN] Category ${category.name}: banner to generate`);
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
            console.log(
                `    Generating ${imageTasks.length} images (${maxConcurrency} parallel, ${imageProvider.name})...`
            );
            const taskStartTime = Date.now();

            const results = await limiter.all(
                imageTasks.map((task, index) => async () => {
                    const shortName = this.truncateName(task.name);
                    const taskNum = index + 1;
                    console.log(
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
            console.log(
                `    ✓ Generated ${successCount}/${imageTasks.length} images in ${elapsed}s`
            );
        }

        // Now upload product images to Shopware
        console.log(`    Uploading product images to Shopware...`);
        let uploadedProducts = 0;

        for (const { product, metadata } of productsNeedingImages) {
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
                            mediaId: this.generateUUID(),
                            productMediaId: this.generateUUID(),
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
                        mediaToUpload
                    );
                    uploadedProducts++;
                }

                processed++;
            } catch (error) {
                errors.push(
                    `Failed to upload images for ${product.name}: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }

        console.log(`    ✓ Uploaded images for ${uploadedProducts} products`);

        // Now upload category banners to Shopware
        if (categoriesWithImages.length > 0) {
            console.log(`    Uploading category banners to Shopware...`);
            let uploadedCategories = 0;

            for (const category of categoriesWithImages) {
                try {
                    const cachedImage = cache.loadImageWithView(
                        context.salesChannelName,
                        category.id,
                        "banner"
                    );

                    if (cachedImage) {
                        const uploaded = await this.uploadCategoryImage(
                            context,
                            category.id,
                            category.name,
                            cachedImage
                        );
                        if (uploaded) {
                            uploadedCategories++;
                        }
                    }
                } catch (error) {
                    errors.push(
                        `Failed to upload banner for ${category.name}: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }

            console.log(`    ✓ Uploaded banners for ${uploadedCategories} categories`);
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
        }>
    ): Promise<void> {
        // First check if product already has images in Shopware
        const hasExistingImages = await this.productHasImages(context, productId);
        if (hasExistingImages) {
            console.log(`      ⊘ Product already has images in Shopware, skipped`);
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

            const mediaResponse = await this.apiPost(context, "_action/sync", {
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
        const syncResponse = await this.apiPost(context, "_action/sync", {
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

        // Upload actual image files for NEW media only
        let uploadedCount = 0;
        let duplicateCount = 0;
        for (const img of newMedia) {
            const imageBuffer = Buffer.from(img.base64Data, "base64");
            const fileName = `${productName.replace(/[^a-zA-Z0-9]/g, "-")}-${img.view}`;

            // Detect image format from magic bytes
            const format = this.detectImageFormat(imageBuffer);

            const uploadResponse = await this.apiUpload(
                context,
                `_action/media/${img.mediaId}/upload?extension=${format.extension}&fileName=${encodeURIComponent(fileName)}`,
                imageBuffer,
                format.mimeType
            );

            if (!uploadResponse.ok) {
                const errorText = await uploadResponse.text();

                // Skip if file already exists (not an error)
                if (errorText.includes("MEDIA_DUPLICATED_FILE_NAME")) {
                    duplicateCount++;
                    continue;
                }

                logger.apiError("_action/media/upload", uploadResponse.status, {
                    mediaId: img.mediaId,
                    view: img.view,
                    error: errorText,
                });
                console.error(
                    `      ✗ ${shortName} (${img.view}) upload failed: ${uploadResponse.status}`
                );
            } else {
                uploadedCount++;
            }
        }

        // Log summary for this product
        const reusedMedia = mediaToLink.filter((m) => !m.isNew);
        const reusedCount = reusedMedia.length + duplicateCount;
        if (uploadedCount > 0 && reusedCount > 0) {
            console.log(`      ✓ ${shortName}: ${uploadedCount} uploaded, ${reusedCount} reused`);
        } else if (uploadedCount > 0) {
            console.log(`      ✓ ${shortName}: ${uploadedCount} uploaded`);
        } else if (reusedCount > 0) {
            console.log(`      ⊘ ${shortName}: ${reusedCount} images reused`);
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
            const response = await this.apiPost(context, "search/product", {
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
            const response = await this.apiPost(context, "search/media", {
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
            const response = await this.apiPost(context, "search/media-folder", {
                filter: [{ type: "equals", field: "name", value: "Product Media" }],
                limit: 1,
            });

            if (response.ok) {
                const data = (await response.json()) as { data?: Array<{ id: string }> };
                const firstFolder = data.data?.[0];
                if (firstFolder) {
                    this.productMediaFolderId = firstFolder.id;
                    console.log(`    Found Product Media folder`);
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
            const defaultFolderResponse = await this.apiPost(
                context,
                "search/media-default-folder",
                {
                    limit: 1,
                    filter: [{ type: "equals", field: "entity", value: "category" }],
                    associations: { folder: {} },
                }
            );

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
            const response = await this.apiPost(context, "search/media-folder", {
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

    // Cache for categories with images
    private categoriesWithImages: Set<string> = new Set();

    /**
     * Check if category already has an image in Shopware
     */
    private async categoryHasImage(
        context: PostProcessorContext,
        categoryId: string
    ): Promise<boolean> {
        if (this.categoriesWithImages.has(categoryId)) {
            return true;
        }

        try {
            interface CategoryResponse {
                data?: Array<{ id: string; mediaId?: string | null }>;
            }
            const response = await this.apiPost(context, "search/category", {
                ids: [categoryId],
                includes: { category: ["id", "mediaId"] },
            });

            if (response.ok) {
                const data = (await response.json()) as CategoryResponse;
                const category = data.data?.[0];
                if (category?.mediaId) {
                    this.categoriesWithImages.add(categoryId);
                    return true;
                }
            }
        } catch {
            // On error, assume no image
        }

        return false;
    }

    /**
     * Upload category banner image to Shopware
     */
    private async uploadCategoryImage(
        context: PostProcessorContext,
        categoryId: string,
        categoryName: string,
        base64Data: string
    ): Promise<boolean> {
        // Check if category already has an image
        const hasImage = await this.categoryHasImage(context, categoryId);
        if (hasImage) {
            console.log(`      ⊘ Category "${categoryName}" already has image, skipped`);
            return false;
        }

        const sanitizedName = categoryName.replace(/[^a-zA-Z0-9]/g, "-");
        const fileName = `${sanitizedName}-banner`;

        // Check if media with this filename already exists
        const existingMediaId = await this.findMediaByFileName(context, fileName);
        let mediaId: string;

        let isExistingMedia = false;
        if (existingMediaId) {
            // Reuse existing media
            mediaId = existingMediaId;
            isExistingMedia = true;
        } else {
            // Create new media entity
            mediaId = this.generateUUID();
            const mediaFolderId = await this.getCategoryMediaFolderId(context);

            const createMediaResponse = await this.apiPost(context, "_action/sync", {
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

            // Upload the image file
            const imageBuffer = Buffer.from(base64Data, "base64");
            const format = this.detectImageFormat(imageBuffer);

            const uploadResponse = await this.apiUpload(
                context,
                `_action/media/${mediaId}/upload?extension=${format.extension}&fileName=${encodeURIComponent(fileName)}`,
                imageBuffer,
                format.mimeType
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
        const updateResponse = await this.apiPost(context, "_action/sync", {
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
            console.log(`      ⊘ Linked existing banner for "${categoryName}"`);
        } else {
            console.log(`      ✓ Uploaded banner for "${categoryName}"`);
        }
        return true;
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

    private generateUUID(): string {
        const hex = "0123456789abcdef";
        let uuid = "";
        for (let i = 0; i < 32; i++) {
            uuid += hex[Math.floor(Math.random() * 16)];
        }
        return uuid;
    }

    /**
     * Truncate name for cleaner log output
     */
    private truncateName(name: string, maxLength = 30): string {
        return name.length > maxLength ? `${name.slice(0, maxLength)}...` : name;
    }

    /**
     * Make API POST request
     * Uses context.api if available, falls back to raw fetch for backwards compatibility
     */
    private async apiPost(
        context: PostProcessorContext,
        endpoint: string,
        body: unknown
    ): Promise<Response> {
        // Use context.api if available
        if (context.api) {
            const result = await context.api.post(endpoint, body);
            // Create a Response-like object for compatibility
            return new Response(JSON.stringify(result), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        // Fallback to raw fetch
        const accessToken = await context.getAccessToken();
        const url = `${context.shopwareUrl}/api/${endpoint}`;
        return fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify(body),
        });
    }

    /**
     * Upload file to API
     * Uses context.api.postRaw if available, falls back to raw fetch for backwards compatibility
     */
    private async apiUpload(
        context: PostProcessorContext,
        endpoint: string,
        buffer: Buffer,
        contentType: string
    ): Promise<Response> {
        // Use context.api.postRaw if available
        if (context.api) {
            try {
                await context.api.postRaw(endpoint, buffer, { "Content-Type": contentType });
                // Create a successful Response for compatibility
                return new Response(null, {
                    status: 204,
                    headers: { "Content-Type": contentType },
                });
            } catch (error) {
                // Create an error Response for compatibility
                const errorMessage = error instanceof Error ? error.message : String(error);
                return new Response(errorMessage, {
                    status: 500,
                    headers: { "Content-Type": "text/plain" },
                });
            }
        }

        // Fallback to raw fetch
        const accessToken = await context.getAccessToken();
        const url = `${context.shopwareUrl}/api/${endpoint}`;
        return fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": contentType,
                Authorization: `Bearer ${accessToken}`,
            },
            body: buffer,
        });
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
            console.log(`    [DRY RUN] Would delete images for products in SalesChannel`);
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
                console.log(`    No products found in SalesChannel`);
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            const productIds = products.map((p) => p.id);
            console.log(`    Found ${productIds.length} products in SalesChannel`);

            // Step 2: Find all product_media entries for these products
            const productMedia = await context.api.searchEntities<{ id: string; mediaId: string }>(
                "product-media",
                [{ type: "equalsAny" as "equals", field: "productId", value: productIds }],
                { limit: 500 }
            );

            if (productMedia.length > 0) {
                console.log(`    Found ${productMedia.length} product media entries`);

                // Collect media IDs before deleting product_media
                const mediaIds = productMedia.map((pm) => pm.mediaId);

                // Step 3: Delete product_media entries
                const productMediaIds = productMedia.map((pm) => pm.id);
                await context.api.deleteEntities("product_media", productMediaIds);
                deleted += productMediaIds.length;
                console.log(`    ✓ Deleted ${productMediaIds.length} product_media entries`);

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
                console.log(`    No product media found`);
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
                    console.log(
                        `    ✓ Cleared media from ${categoriesWithMedia.length} categories`
                    );
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
