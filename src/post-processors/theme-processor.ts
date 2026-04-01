/**
 * Theme Processor - Customizes SalesChannel theme with brand colors, logo, favicon, and share icon
 *
 * Creates a child theme inheriting from the Storefront theme, uploads AI-generated
 * media (logo, favicon, share icon) to the "Theme Media" folder, applies brand colors
 * and media to the child theme config, then assigns it to the SalesChannel.
 */

import type { BrandColors } from "../types/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

import {
    apiPatch,
    apiPost,
    capitalizeString,
    generateUUID,
    getContrastTextColor,
    logger,
} from "../utils/index.js";
import { detectImageFormat, uploadImageWithRetry } from "./image-utils.js";

interface ThemeMediaIds {
    logo?: string;
    favicon?: string;
    share?: string;
}

interface SearchResult<T> {
    data?: T[];
    total?: number;
}

class ThemeProcessorImpl implements PostProcessor {
    readonly name = "theme";
    readonly description =
        "Customize SalesChannel theme with brand colors, logo, favicon, and share icon";
    readonly dependsOn: string[] = [];

    private themeMediaFolderId: string | null | undefined = undefined;
    private mediaFileNameCache = new Map<string, string>();

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        this.resetCaches();
        const startTime = Date.now();
        const errors: string[] = [];

        if (context.options.dryRun) {
            logger.info(`  [DRY RUN] Would customize theme for ${context.salesChannelName}`, {
                cli: true,
            });
            return { name: this.name, processed: 0, skipped: 1, errors: [], durationMs: 0 };
        }

        const storefrontThemeId = await this.getStorefrontThemeId(context);
        if (!storefrontThemeId) {
            return {
                name: this.name,
                processed: 0,
                skipped: 1,
                errors: ["No Storefront theme found"],
                durationMs: Date.now() - startTime,
            };
        }

        const childThemeId = await this.getOrCreateChildTheme(
            context,
            storefrontThemeId,
            context.salesChannelName
        );
        if (!childThemeId) {
            return {
                name: this.name,
                processed: 0,
                skipped: 0,
                errors: ["Failed to create child theme"],
                durationMs: Date.now() - startTime,
            };
        }

        const mediaIds = await this.uploadThemeMedia(context);

        const themeConfig = buildThemeConfig(context.blueprint.brandColors, mediaIds);

        if (Object.keys(themeConfig).length === 0) {
            logger.info("  ⊘ No brand colors or theme media to apply", { cli: true });
            return {
                name: this.name,
                processed: 0,
                skipped: 1,
                errors,
                durationMs: Date.now() - startTime,
            };
        }

        const configUpdated = await this.updateThemeConfig(context, childThemeId, themeConfig);
        if (!configUpdated) {
            errors.push("Failed to update theme config");
        }

        const assigned = await this.assignTheme(context, childThemeId, context.salesChannelId);
        if (!assigned) {
            errors.push("Failed to assign theme to SalesChannel");
        }

        const processed = configUpdated || assigned ? 1 : 0;
        logger.info(`  ✓ Theme customized for ${context.salesChannelName}`, { cli: true });

        return {
            name: this.name,
            processed,
            skipped: 0,
            errors,
            durationMs: Date.now() - startTime,
        };
    }

    async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        this.resetCaches();
        const startTime = Date.now();
        const errors: string[] = [];
        let deleted = 0;

        if (context.options.dryRun) {
            logger.info(`  [DRY RUN] Would clean up theme for ${context.salesChannelName}`, {
                cli: true,
            });
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        const themeName = buildThemeName(context.salesChannelName);
        const childThemeId = await this.findThemeByName(context, themeName);
        if (!childThemeId) {
            logger.info(`  ⊘ No child theme "${themeName}" found`, { cli: true });
            return { name: this.name, deleted: 0, errors: [], durationMs: Date.now() - startTime };
        }

        const storefrontThemeId = await this.getStorefrontThemeId(context);
        if (storefrontThemeId) {
            await this.assignTheme(context, storefrontThemeId, context.salesChannelId);
        }

        try {
            await apiPost(context, "_action/sync", {
                deleteTheme: {
                    entity: "theme",
                    action: "delete",
                    payload: [{ id: childThemeId }],
                },
            });
            deleted++;
            logger.info(`  ✓ Deleted child theme "${themeName}"`, { cli: true });
        } catch (error) {
            errors.push(
                `Failed to delete theme: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        const mediaDeleted = await this.deleteThemeMedia(context);
        deleted += mediaDeleted;

        return { name: this.name, deleted, errors, durationMs: Date.now() - startTime };
    }

    private resetCaches(): void {
        this.themeMediaFolderId = undefined;
        this.mediaFileNameCache.clear();
    }

    private async getStorefrontThemeId(context: PostProcessorContext): Promise<string | null> {
        try {
            const response = await apiPost(context, "search/theme", {
                limit: 10,
                filter: [{ type: "equals", field: "active", value: true }],
            });

            if (!response.ok) return null;

            const data = (await response.json()) as SearchResult<{
                id: string;
                technicalName?: string;
                name: string;
            }>;
            const themes = data.data ?? [];

            const storefront = themes.find(
                (t) => t.technicalName === "Storefront" || t.name === "Storefront"
            );
            return storefront?.id ?? themes[0]?.id ?? null;
        } catch {
            return null;
        }
    }

    private async getOrCreateChildTheme(
        context: PostProcessorContext,
        parentThemeId: string,
        salesChannelName: string
    ): Promise<string | null> {
        const themeName = buildThemeName(salesChannelName);

        const existing = await this.findThemeByName(context, themeName);
        if (existing) {
            logger.info(`  ⊘ Child theme "${themeName}" already exists`, { cli: true });
            return existing;
        }

        const themeId = generateUUID();
        try {
            await apiPost(context, "_action/sync", {
                createTheme: {
                    entity: "theme",
                    action: "upsert",
                    payload: [
                        {
                            id: themeId,
                            name: themeName,
                            author: "Catalog Generator",
                            active: true,
                            parentThemeId,
                        },
                    ],
                },
            });
            logger.info(`  ✓ Created child theme "${themeName}"`, { cli: true });
            return themeId;
        } catch (error) {
            logger.error(`Failed to create child theme: ${error}`, { cli: true });
            return null;
        }
    }

    private async findThemeByName(
        context: PostProcessorContext,
        name: string
    ): Promise<string | null> {
        try {
            const response = await apiPost(context, "search/theme", {
                limit: 1,
                filter: [{ type: "equals", field: "name", value: name }],
            });

            if (!response.ok) return null;
            const data = (await response.json()) as SearchResult<{ id: string }>;
            return data.data?.[0]?.id ?? null;
        } catch {
            return null;
        }
    }

    private async getThemeMediaFolderId(context: PostProcessorContext): Promise<string | null> {
        if (this.themeMediaFolderId !== undefined) {
            return this.themeMediaFolderId;
        }

        try {
            const defaultFolderResponse = await apiPost(context, "search/media-default-folder", {
                limit: 1,
                filter: [{ type: "equals", field: "entity", value: "theme" }],
                associations: { folder: {} },
            });

            if (defaultFolderResponse.ok) {
                const data = (await defaultFolderResponse.json()) as {
                    data?: Array<{ folder?: { id: string } }>;
                };
                const folder = data.data?.[0]?.folder;
                if (folder) {
                    this.themeMediaFolderId = folder.id;
                    return this.themeMediaFolderId;
                }
            }

            const response = await apiPost(context, "search/media-folder", {
                filter: [{ type: "equals", field: "name", value: "Theme Media" }],
                limit: 1,
            });

            if (response.ok) {
                const data = (await response.json()) as SearchResult<{ id: string }>;
                const firstFolder = data.data?.[0];
                if (firstFolder) {
                    this.themeMediaFolderId = firstFolder.id;
                    return this.themeMediaFolderId;
                }
            }
        } catch (error) {
            logger.warn("Could not find Theme Media folder", { data: error });
        }

        this.themeMediaFolderId = null;
        return null;
    }

    private async uploadThemeMedia(context: PostProcessorContext): Promise<ThemeMediaIds> {
        const folderId = await this.getThemeMediaFolderId(context);
        const mediaIds: ThemeMediaIds = {};

        const items: Array<{ cacheKey: string; field: keyof ThemeMediaIds }> = [
            { cacheKey: "store-logo", field: "logo" },
            { cacheKey: "store-favicon", field: "favicon" },
            { cacheKey: "store-share", field: "share" },
        ];

        for (const item of items) {
            const base64Data = context.cache.images.loadImageForSalesChannel(
                context.salesChannelName,
                item.cacheKey,
                "theme_media"
            );
            if (!base64Data) continue;

            const fileName = `${context.salesChannelName}-${item.field}`;

            const existingMediaId = await this.findMediaByFileName(context, fileName);
            if (existingMediaId) {
                mediaIds[item.field] = existingMediaId;
                continue;
            }

            const mediaId = generateUUID();
            try {
                await apiPost(context, "_action/sync", {
                    createMedia: {
                        entity: "media",
                        action: "upsert",
                        payload: [
                            {
                                id: mediaId,
                                private: false,
                                ...(folderId && { mediaFolderId: folderId }),
                            },
                        ],
                    },
                });

                const imageBuffer = Buffer.from(base64Data, "base64");
                const format = detectImageFormat(imageBuffer);
                await uploadImageWithRetry(context, mediaId, fileName, imageBuffer, format);
                mediaIds[item.field] = mediaId;
                logger.info(`  ✓ Uploaded theme ${item.field}`, { cli: true });
            } catch (error) {
                logger.warn(`  Failed to upload theme ${item.field}: ${error}`, { cli: true });
            }
        }

        return mediaIds;
    }

    private async findMediaByFileName(
        context: PostProcessorContext,
        fileName: string
    ): Promise<string | null> {
        if (this.mediaFileNameCache.has(fileName)) {
            return this.mediaFileNameCache.get(fileName) ?? null;
        }

        try {
            const response = await apiPost(context, "search/media", {
                limit: 1,
                filter: [{ type: "equals", field: "fileName", value: fileName }],
            });

            if (!response.ok) return null;
            const data = (await response.json()) as SearchResult<{ id: string }>;
            const mediaId = data.data?.[0]?.id ?? null;
            if (mediaId) {
                this.mediaFileNameCache.set(fileName, mediaId);
            }
            return mediaId;
        } catch {
            return null;
        }
    }

    private async updateThemeConfig(
        context: PostProcessorContext,
        themeId: string,
        config: Record<string, { value: string }>
    ): Promise<boolean> {
        try {
            await apiPatch(context, `_action/theme/${themeId}`, { config });
            return true;
        } catch (error) {
            logger.error(`Failed to update theme config: ${error}`, { cli: true });
            return false;
        }
    }

    private async assignTheme(
        context: PostProcessorContext,
        themeId: string,
        salesChannelId: string
    ): Promise<boolean> {
        try {
            await apiPost(context, `_action/theme/${themeId}/assign/${salesChannelId}`, {});
            return true;
        } catch (error) {
            logger.error(`Failed to assign theme: ${error}`, { cli: true });
            return false;
        }
    }

    private async deleteThemeMedia(context: PostProcessorContext): Promise<number> {
        let deleted = 0;
        const fields: Array<keyof ThemeMediaIds> = ["logo", "favicon", "share"];

        for (const field of fields) {
            const fileName = `${context.salesChannelName}-${field}`;
            const mediaId = await this.findMediaByFileName(context, fileName);
            if (!mediaId) continue;

            try {
                await apiPost(context, "_action/sync", {
                    deleteMedia: {
                        entity: "media",
                        action: "delete",
                        payload: [{ id: mediaId }],
                    },
                });
                deleted++;
            } catch {
                logger.warn(`  Could not delete theme media ${fileName}`);
            }
        }

        return deleted;
    }
}

function buildThemeName(salesChannelName: string): string {
    return `${capitalizeString(salesChannelName)} Theme`;
}

/**
 * Build Shopware theme configuration from brand colors and media IDs.
 *
 * Follows Material Design "On" color principles: buy-button-text is derived
 * from the primary color's luminance (white on dark, black on light).
 */
export function buildThemeConfig(
    brandColors?: BrandColors,
    mediaIds?: ThemeMediaIds
): Record<string, { value: string }> {
    const config: Record<string, { value: string }> = {};

    if (brandColors) {
        config["sw-color-brand-primary"] = { value: brandColors.primary };
        config["sw-color-brand-secondary"] = { value: brandColors.secondary };
        config["sw-color-buy-button"] = { value: brandColors.primary };
        config["sw-color-buy-button-text"] = { value: getContrastTextColor(brandColors.primary) };
        config["sw-color-price"] = { value: brandColors.primary };
    }

    if (mediaIds?.logo) {
        config["sw-logo-desktop"] = { value: mediaIds.logo };
        config["sw-logo-tablet"] = { value: mediaIds.logo };
        config["sw-logo-mobile"] = { value: mediaIds.logo };
    }
    if (mediaIds?.favicon) {
        config["sw-logo-favicon"] = { value: mediaIds.favicon };
    }
    if (mediaIds?.share) {
        config["sw-logo-share"] = { value: mediaIds.share };
    }

    return config;
}

export const ThemeProcessor = new ThemeProcessorImpl();
