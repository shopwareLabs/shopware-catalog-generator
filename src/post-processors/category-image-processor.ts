/**
 * Category Image Processor - Helper for category banner image generation and upload
 *
 * Not a post-processor; used by ImageProcessor to handle category banner images.
 */

import type { PostProcessorContext } from "./index.js";

import { apiPost, generateUUID, logger } from "../utils/index.js";
import { detectImageFormat, uploadImageWithRetry } from "./image-utils.js";

/**
 * Helper for category banner image upload and cleanup.
 * Not a post-processor; used by ImageProcessor.
 */
export class CategoryImageProcessor {
    private categoryMediaFolderId: string | null = null;
    private categoryMediaIds: Map<string, string> = new Map();
    private mediaFileNameCache: Map<string, string> = new Map();

    /**
     * Get Category Media folder ID (cached)
     */
    async getCategoryMediaFolderId(context: PostProcessorContext): Promise<string | null> {
        if (this.categoryMediaFolderId) {
            return this.categoryMediaFolderId;
        }

        try {
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
            logger.warn("Could not find Category Media folder", { data: error });
        }

        return null;
    }

    /**
     * Get category media ID (cached)
     */
    async getCategoryMediaId(
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
     * Find existing media by filename
     */
    async findMediaByFileName(
        context: PostProcessorContext,
        fileName: string
    ): Promise<string | null> {
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
     * Upload category banner image to Shopware
     */
    async uploadCategoryImage(
        context: PostProcessorContext,
        categoryId: string,
        categoryName: string,
        base64Data: string,
        shouldCleanup: boolean
    ): Promise<boolean> {
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
            logger.info(`      ⊘ Category "${categoryName}" already has image, skipped`, {
                cli: true,
            });
            return false;
        }

        const sanitizedName = categoryName.replace(/[^a-zA-Z0-9]/g, "-");
        const fileName = `${sanitizedName}-banner`;

        const existingFileMediaId = await this.findMediaByFileName(context, fileName);
        let mediaId: string;
        let isExistingMedia = false;

        if (existingFileMediaId) {
            mediaId = existingFileMediaId;
            isExistingMedia = true;
        } else {
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
                    { categoryId, error: errorText }
                );
                throw new Error(`Failed to create media entity: ${createMediaResponse.status}`);
            }

            const imageBuffer = Buffer.from(base64Data, "base64");
            const format = detectImageFormat(imageBuffer);

            const uploadResponse = await uploadImageWithRetry(
                context,
                mediaId,
                fileName,
                imageBuffer,
                format
            );

            if (!uploadResponse.ok) {
                const errorText = await uploadResponse.text();
                if (!errorText.includes("MEDIA_DUPLICATED_FILE_NAME")) {
                    logger.apiError("_action/media/upload (category)", uploadResponse.status, {
                        categoryId,
                        error: errorText,
                    });
                    throw new Error(`Failed to upload category image: ${uploadResponse.status}`);
                }
            }
        }

        const updateResponse = await apiPost(context, "_action/sync", {
            updateCategory: {
                entity: "category",
                action: "upsert",
                payload: [{ id: categoryId, mediaId }],
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
            logger.info(`      ⊘ Linked existing banner for "${categoryName}"`, {
                cli: true,
            });
        } else {
            logger.info(`      ✓ Uploaded banner for "${categoryName}"`, { cli: true });
        }
        return true;
    }

    /**
     * Remove existing category image before re-upload
     */
    async clearCategoryImage(
        context: PostProcessorContext,
        categoryId: string,
        categoryName: string,
        mediaId: string
    ): Promise<void> {
        if (!context.api) {
            logger.info(`      ⊘ Category "${categoryName}": cleanup skipped (no API)`, {
                cli: true,
            });
            return;
        }

        await context.api.syncEntities({
            clearCategoryMedia: {
                entity: "category",
                action: "upsert",
                payload: [{ id: categoryId, mediaId: null }],
            },
        });

        try {
            await context.api.deleteEntity("media", mediaId);
        } catch {
            // Media may still be in use elsewhere
        }

        this.categoryMediaIds.delete(categoryId);
        logger.info(`      ✓ Cleared existing banner for "${categoryName}"`, { cli: true });
    }

    /**
     * Cleanup category images for SalesChannel categories
     * Clears mediaId from categories under the SalesChannel root
     */
    async cleanupCategoryImages(context: PostProcessorContext): Promise<number> {
        if (!context.api) return 0;

        const salesChannel = await context.api.getSalesChannelByName(context.salesChannelName);
        if (!salesChannel) return 0;

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
        if (categoriesWithMedia.length === 0) return 0;

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
        logger.info(`    ✓ Cleared media from ${categoriesWithMedia.length} categories`, {
            cli: true,
        });
        return categoriesWithMedia.length;
    }
}
