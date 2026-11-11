/**
 * Image Processor - Uploads pre-generated product/category images to Shopware
 *
 * All AI image generation happens during blueprint hydration (Phase 2).
 * This processor only reads cached images and uploads them to Shopware:
 * 1. Reads images from local cache (generated during hydration)
 * 2. Uploads images to Shopware media
 * 3. Sets cover image and gallery images
 */

import type { BlueprintCategory, BlueprintProduct, ProductMetadata } from "../types/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

import { productMediaTexts } from "../fixtures/index.js";
import { getAllSalesChannelProductIds, searchAllByEqualsAny } from "../shopware/api-helpers.js";
import {
    apiPost,
    ConcurrencyLimiter,
    detectImageFormat,
    generateUUID,
    logger,
} from "../utils/index.js";
import { CategoryImageProcessor } from "./category-image-processor.js";
import { uploadImageWithRetry } from "./image-utils.js";
import { errorMessage, syncWithRetry } from "./processor-utils.js";

/** Product with metadata and the number of its views that have a cached image */
interface ProductWithCachedImages {
    product: BlueprintProduct;
    metadata: ProductMetadata;
    imageCount: number;
}

/** Cached product image ready for upload, with pre-generated IDs */
interface ProductImageUpload {
    mediaId: string;
    productMediaId: string;
    view: string;
    base64Data: string;
}

/** Product image with resolved media ID; `isNew` when no media with its file name exists */
interface LinkedProductImage extends ProductImageUpload {
    isNew: boolean;
}

/** Result of uploading the images of one product */
interface ProductUploadOutcome {
    uploaded: boolean;
    processed: boolean;
}

/** Result of uploading one media file */
type MediaFileUploadResult = "uploaded" | "duplicate" | "error";

/**
 * Image Processor implementation
 */
class ImageProcessorImpl implements PostProcessor {
    readonly name = "images";
    readonly description = "Upload pre-generated product/category images to Shopware";
    readonly dependsOn: string[] = [];

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const startTime = Date.now();
        const products = this.collectProductsWithCachedImages(context);
        const categories = this.collectCategoriesWithCachedImages(context);

        if (products.length === 0 && categories.length === 0) {
            logger.info(`    No cached images to upload (run blueprint hydrate first)`, {
                cli: true,
            });
            return {
                name: this.name,
                processed: 0,
                skipped: context.blueprint.products.length,
                errors: [],
                durationMs: 0,
            };
        }

        logUploadPlan(products, categories.length);

        if (context.options.dryRun) {
            logDryRunPlan(products, categories);
            return {
                name: this.name,
                processed: products.length,
                skipped: 0,
                errors: [],
                durationMs: Date.now() - startTime,
            };
        }

        const errors: string[] = [];
        const tally = await this.uploadAllProductImages(context, products, errors);
        await uploadAllCategoryBanners(context, categories, errors);

        return {
            name: this.name,
            processed: tally.processed,
            skipped: tally.skipped,
            errors,
            durationMs: Date.now() - startTime,
        };
    }

    /**
     * Upload product images (parallel across products) and count the outcomes
     */
    private async uploadAllProductImages(
        context: PostProcessorContext,
        products: ProductWithCachedImages[],
        errors: string[]
    ): Promise<{ processed: number; skipped: number }> {
        logger.info(`    Uploading product images to Shopware...`, { cli: true });
        const uploadLimiter = new ConcurrencyLimiter(3);
        const outcomes = await uploadLimiter.all(
            products.map((entry) => () => this.uploadProductEntry(context, entry, errors))
        );

        const uploadedProducts = outcomes.filter((o) => o.uploaded).length;
        logger.info(`    ✓ Uploaded images for ${uploadedProducts} products`, { cli: true });

        const processed = outcomes.filter((o) => o.processed).length;
        return { processed, skipped: outcomes.length - processed };
    }

    /**
     * Upload the cached images of one product; failures are collected in `errors`
     */
    private async uploadProductEntry(
        context: PostProcessorContext,
        { product, metadata }: ProductWithCachedImages,
        errors: string[]
    ): Promise<ProductUploadOutcome> {
        try {
            const mediaToUpload = loadCachedProductImages(context, product.id, metadata);
            if (mediaToUpload.length === 0) {
                return { uploaded: false, processed: true };
            }
            await this.uploadProductImages(context, product.id, product.name, mediaToUpload);
            return { uploaded: true, processed: true };
        } catch (error) {
            errors.push(`Failed to upload images for ${product.name}: ${errorMessage(error)}`);
            return { uploaded: false, processed: false };
        }
    }

    private collectProductsWithCachedImages(
        context: PostProcessorContext
    ): ProductWithCachedImages[] {
        const result: ProductWithCachedImages[] = [];

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
        images: ProductImageUpload[]
    ): Promise<void> {
        const shortName = this.truncateName(productName);
        const sanitizedName = productName.replace(/[^a-zA-Z0-9]/g, "-");
        const linked = await findLinkedProductMedia(context, productId);
        if (linked.length > 0) {
            await reuploadMissingFiles(context, linked, images, sanitizedName, shortName);
            return;
        }

        const mediaFolderId = await this.getProductMediaFolderId(context);
        const mediaToLink = await this.resolveMediaToLink(context, sanitizedName, images);
        const newMedia = mediaToLink.filter((m) => m.isNew);

        const product = { id: productId, name: productName };
        await createProductMediaEntities(context, product, newMedia, mediaFolderId);

        const cover = mediaToLink[0];
        if (!cover) return;
        await linkProductMedia(context, product, mediaToLink, cover);

        const fileLimiter = new ConcurrencyLimiter(5);
        const fileResults = await fileLimiter.all(
            newMedia.map(
                (img) => () =>
                    uploadProductMediaFile(context, img, `${sanitizedName}-${img.view}`, shortName)
            )
        );
        logUploadSummary(shortName, fileResults, mediaToLink.length - newMedia.length);
    }

    /**
     * Reuse existing media with the same file name, otherwise mark the image as new
     */
    private async resolveMediaToLink(
        context: PostProcessorContext,
        sanitizedName: string,
        images: ProductImageUpload[]
    ): Promise<LinkedProductImage[]> {
        const result: LinkedProductImage[] = [];
        for (const img of images) {
            const fileName = `${sanitizedName}-${img.view}`;
            const existingMediaId = await this.findMediaByFileName(context, fileName);
            result.push({
                ...img,
                mediaId: existingMediaId ?? img.mediaId,
                isNew: !existingMediaId,
            });
        }
        return result;
    }

    private productMediaFolderId: string | null = null;

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
            errors.push(`Image cleanup failed: ${errorMessage(error)}`);
        }

        return { name: this.name, deleted, errors, durationMs: 0 };
    }
}

/** Image processor singleton */
export const ImageProcessor = new ImageProcessorImpl();

/**
 * Alt text and title for a product image, e.g. "Oak Desk (front view)".
 * Screen readers and image search use the alt text; the title shows as tooltip.
 */
export function buildProductMediaTexts(
    productName: string,
    view: string
): { alt: string; title: string } {
    return productMediaTexts(productName, view);
}

/** Log how many images and banners are about to be uploaded */
function logUploadPlan(products: ProductWithCachedImages[], categoryCount: number): void {
    const totalImages = products.reduce((sum, p) => sum + p.imageCount, 0) + categoryCount;
    logger.info(`    Uploading ${totalImages} cached images to Shopware`, { cli: true });
    logger.info(`      - ${products.length} products with images`, { cli: true });
    logger.info(`      - ${categoryCount} category banners`, { cli: true });
}

/** Log what a real run would upload */
function logDryRunPlan(products: ProductWithCachedImages[], categories: BlueprintCategory[]): void {
    for (const { product, imageCount } of products) {
        logger.info(`    [DRY RUN] ${product.name}: ${imageCount} images to upload`, {
            cli: true,
        });
    }
    for (const category of categories) {
        logger.info(`    [DRY RUN] Category ${category.name}: banner to upload`, { cli: true });
    }
}

/** Load every cached view image of a product and give each new media IDs */
function loadCachedProductImages(
    context: PostProcessorContext,
    productId: string,
    metadata: ProductMetadata
): ProductImageUpload[] {
    return metadata.imageDescriptions.flatMap((desc) => {
        const cachedImage = context.cache.images.loadImageWithView(
            context.salesChannelName,
            productId,
            desc.view,
            "product_media"
        );
        if (!cachedImage) return [];
        return [
            {
                mediaId: generateUUID(),
                productMediaId: generateUUID(),
                view: desc.view,
                base64Data: cachedImage,
            },
        ];
    });
}

/** Upload category banners (parallel); failures are collected in `errors` */
async function uploadAllCategoryBanners(
    context: PostProcessorContext,
    categories: BlueprintCategory[],
    errors: string[]
): Promise<void> {
    if (categories.length === 0) return;

    logger.info(`    Uploading category banners to Shopware...`, { cli: true });
    const categoryLimiter = new ConcurrencyLimiter(3);
    const categoryProcessor = new CategoryImageProcessor();
    const results = await categoryLimiter.all(
        categories.map(
            (category) => () => uploadCategoryBanner(context, categoryProcessor, category, errors)
        )
    );

    const uploadedCategories = results.filter(Boolean).length;
    logger.info(`    ✓ Uploaded banners for ${uploadedCategories} categories`, { cli: true });
}

/** Upload the cached banner of one category; returns true when it was linked */
async function uploadCategoryBanner(
    context: PostProcessorContext,
    categoryProcessor: CategoryImageProcessor,
    category: BlueprintCategory,
    errors: string[]
): Promise<boolean> {
    try {
        const cachedImage = context.cache.images.loadImageWithView(
            context.salesChannelName,
            category.id,
            "banner",
            "category_media"
        );
        if (!cachedImage) return false;
        return await categoryProcessor.uploadCategoryImage(
            context,
            category.id,
            category.name,
            cachedImage,
            true
        );
    } catch (error) {
        errors.push(`Failed to upload banner for ${category.name}: ${errorMessage(error)}`);
        return false;
    }
}

/** Media already linked to a product, with whether its file exists */
interface LinkedProductMedia {
    mediaId: string;
    position: number;
    hasFile: boolean;
}

interface ProductMediaSearchResponse {
    data?: Array<{
        media?: Array<{
            mediaId?: string;
            position?: number;
            media?: { hasFile?: boolean; path?: string | null; fileName?: string | null };
        }>;
    }>;
}

/**
 * Media linked to the product. A media entity can exist without a file when the
 * upload failed after it was created (e.g. Shopware ran out of disk space).
 */
async function findLinkedProductMedia(
    context: PostProcessorContext,
    productId: string
): Promise<LinkedProductMedia[]> {
    try {
        const response = await apiPost(context, "search/product", {
            ids: [productId],
            associations: { media: { associations: { media: {} } } },
        });
        if (!response.ok) return [];
        const data = (await response.json()) as ProductMediaSearchResponse;
        return (data.data?.[0]?.media ?? []).map((pm, index) => ({
            mediaId: pm.mediaId ?? "",
            position: pm.position ?? index,
            // Without the media association the file state is unknown: assume it exists
            hasFile: pm.media ? (pm.media.hasFile ?? Boolean(pm.media.path)) : true,
        }));
    } catch {
        // On error, assume no images (will try to upload)
        return [];
    }
}

/**
 * Upload the cached file for linked media that have none. Media are linked in view
 * order, so the position picks the cached image.
 */
async function reuploadMissingFiles(
    context: PostProcessorContext,
    linked: LinkedProductMedia[],
    images: ProductImageUpload[],
    sanitizedName: string,
    shortName: string
): Promise<void> {
    const missing = linked.flatMap((m) => {
        const image = images[m.position];
        if (m.hasFile || !m.mediaId || !image) return [];
        return [{ ...image, mediaId: m.mediaId, isNew: true }];
    });
    if (missing.length === 0) {
        logger.info(`      ✓ ${shortName}: reused existing images`, { cli: true });
        return;
    }
    const results = await Promise.all(
        missing.map((img) =>
            uploadProductMediaFile(context, img, `${sanitizedName}-${img.view}`, shortName)
        )
    );
    const uploaded = results.filter((r) => r !== "error").length;
    logger.info(`      ✓ ${shortName}: re-uploaded ${uploaded} missing image files`, {
        cli: true,
    });
}

/** Create media entities for images that have no existing media yet */
async function createProductMediaEntities(
    context: PostProcessorContext,
    product: { id: string; name: string },
    newMedia: LinkedProductImage[],
    mediaFolderId: string | null
): Promise<void> {
    if (newMedia.length === 0) return;

    const mediaPayload = newMedia.map((img) => ({
        id: img.mediaId,
        private: false,
        ...(mediaFolderId && { mediaFolderId }),
        ...buildProductMediaTexts(product.name, img.view),
    }));
    const mediaResponse = await syncWithRetry(context, "create media", {
        createMedia: { entity: "media", action: "upsert", payload: mediaPayload },
    });
    if (mediaResponse.ok) return;

    logger.apiError("_action/sync (create media)", mediaResponse.status, {
        productId: product.id,
        error: mediaResponse.errorText,
    });
    throw new Error(
        mediaResponse.errorText ?? `Failed to create media entities: ${mediaResponse.status}`
    );
}

/**
 * Link all media (new and existing) to the product in view order and set the cover.
 * On Shopware 6.7.10+ the cover also becomes the social sharing image.
 */
async function linkProductMedia(
    context: PostProcessorContext,
    product: { id: string; name: string },
    mediaToLink: LinkedProductImage[],
    cover: LinkedProductImage
): Promise<void> {
    const productMediaPayload = mediaToLink.map((img, index) => ({
        id: img.productMediaId,
        productId: product.id,
        mediaId: img.mediaId,
        position: index,
    }));
    const coverUpdate = {
        id: product.id,
        coverId: cover.productMediaId,
        ...(context.shopware.supports("productOpenGraph") && {
            openGraphMediaId: cover.mediaId,
        }),
    };

    const syncResponse = await syncWithRetry(context, "link product media", {
        createProductMedia: {
            entity: "product_media",
            action: "upsert",
            payload: productMediaPayload,
        },
        updateCover: { entity: "product", action: "upsert", payload: [coverUpdate] },
    });
    if (syncResponse.ok) return;

    logger.apiError("_action/sync (product_media)", syncResponse.status, {
        productId: product.id,
        productName: product.name,
        error: syncResponse.errorText,
    });
    throw new Error(
        syncResponse.errorText ?? `Failed to link media to product: ${syncResponse.status}`
    );
}

/** Upload one image file (with retry for transient failures); never throws */
async function uploadProductMediaFile(
    context: PostProcessorContext,
    img: LinkedProductImage,
    fileName: string,
    shortName: string
): Promise<MediaFileUploadResult> {
    const imageBuffer = Buffer.from(img.base64Data, "base64");
    const format = detectImageFormat(imageBuffer);
    try {
        const response = await uploadImageWithRetry(
            context,
            img.mediaId,
            fileName,
            imageBuffer,
            format
        );
        return await classifyUploadResponse(response, img, shortName);
    } catch (error) {
        const message = errorMessage(error);
        logger.error(`Failed to upload image after retries`, {
            data: { mediaId: img.mediaId, view: img.view, error: message },
        });
        logger.error(`      ✗ ${shortName} (${img.view}) upload failed: ${message}`, {
            cli: true,
        });
        return "error";
    }
}

/** Map an upload response to its result; a duplicated file name is not an error */
async function classifyUploadResponse(
    response: Response,
    img: LinkedProductImage,
    shortName: string
): Promise<MediaFileUploadResult> {
    if (response.ok) return "uploaded";

    const errorText = await response.text();
    if (errorText.includes("MEDIA_DUPLICATED_FILE_NAME")) return "duplicate";

    logger.apiError("_action/media/upload", response.status, {
        mediaId: img.mediaId,
        view: img.view,
        error: errorText,
    });
    logger.error(`      ✗ ${shortName} (${img.view}) upload failed: ${response.status}`, {
        cli: true,
    });
    return "error";
}

/** Log how many images of a product were uploaded and how many were reused */
function logUploadSummary(
    shortName: string,
    results: MediaFileUploadResult[],
    reusedExisting: number
): void {
    const uploadedCount = results.filter((r) => r === "uploaded").length;
    const reusedCount = reusedExisting + results.filter((r) => r === "duplicate").length;
    if (uploadedCount > 0 && reusedCount > 0) {
        logger.info(`      ✓ ${shortName}: ${uploadedCount} uploaded, ${reusedCount} reused`, {
            cli: true,
        });
        return;
    }
    if (uploadedCount > 0) {
        logger.info(`      ✓ ${shortName}: ${uploadedCount} uploaded`, { cli: true });
        return;
    }
    if (reusedCount > 0) {
        logger.info(`      ✓ ${shortName}: ${reusedCount} images reused`, { cli: true });
    }
}
