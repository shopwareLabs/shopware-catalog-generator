import fs from "node:fs";
import path from "node:path";

import type { CacheOptions, ImageCacheMetadata } from "./types/index.js";

import { DEFAULT_CACHE_OPTIONS } from "./types/index.js";

/** Media type subdirectories matching Shopware's admin media folder structure */
export type MediaType = "product_media" | "category_media" | "cms_media" | "property_images";

/** Default media type for backward compatibility (product images) */
const DEFAULT_MEDIA_TYPE: MediaType = "product_media";

/**
 * Image cache for storing generated product and category images
 */
export class ImageCache {
    private readonly cacheDir: string;
    private readonly options: Pick<CacheOptions, "enabled" | "useCache" | "saveToCache">;

    constructor(
        options: Partial<
            Pick<CacheOptions, "enabled" | "useCache" | "saveToCache" | "cacheDir">
        > = {}
    ) {
        const fullOptions = { ...DEFAULT_CACHE_OPTIONS, ...options };
        this.cacheDir = path.resolve(fullOptions.cacheDir);
        this.options = {
            enabled: fullOptions.enabled,
            useCache: fullOptions.useCache,
            saveToCache: fullOptions.saveToCache,
        };
    }

    /** Check if we should use cached data */
    get shouldUseCache(): boolean {
        return this.options.enabled && this.options.useCache;
    }

    /** Check if we should save to cache */
    get shouldSaveToCache(): boolean {
        return this.options.enabled && this.options.saveToCache;
    }

    /**
     * Get the base directory for a SalesChannel
     */
    getSalesChannelDir(salesChannel: string): string {
        return path.join(this.cacheDir, "sales-channels", this.sanitizeName(salesChannel));
    }

    /**
     * Get image directory for a SalesChannel
     */
    getSalesChannelImagesDir(salesChannel: string): string {
        return path.join(this.getSalesChannelDir(salesChannel), "images");
    }

    /**
     * Get images directory for a media type within a SalesChannel
     */
    getMediaTypeDir(salesChannel: string, mediaType: MediaType): string {
        return path.join(this.getSalesChannelImagesDir(salesChannel), mediaType);
    }

    /** Get product images directory */
    getProductImagesDir(salesChannel: string): string {
        return this.getMediaTypeDir(salesChannel, "product_media");
    }

    /** Get category images directory */
    getCategoryImagesDir(salesChannel: string): string {
        return this.getMediaTypeDir(salesChannel, "category_media");
    }

    /** Get CMS images directory */
    getCmsImagesDir(salesChannel: string): string {
        return this.getMediaTypeDir(salesChannel, "cms_media");
    }

    /** Get property images directory */
    getPropertyImagesDir(salesChannel: string): string {
        return this.getMediaTypeDir(salesChannel, "property_images");
    }

    /**
     * Get image path for an entity with view within a SalesChannel
     */
    getLocalImagePath(
        salesChannel: string,
        entityId: string,
        view: string,
        mediaType: MediaType = DEFAULT_MEDIA_TYPE
    ): string {
        return path.join(this.getMediaTypeDir(salesChannel, mediaType), `${entityId}-${view}.webp`);
    }

    /**
     * Save image for an entity with view type (e.g., "front", "lifestyle", "banner")
     */
    saveImageWithView(
        salesChannel: string,
        entityId: string,
        view: string,
        base64Data: string,
        prompt: string,
        imageModel?: string,
        mediaType: MediaType = DEFAULT_MEDIA_TYPE
    ): void {
        if (!this.shouldSaveToCache) return;

        const imagesDir = this.getMediaTypeDir(salesChannel, mediaType);
        this.ensureDir(imagesDir);

        const imagePath = path.join(imagesDir, `${entityId}-${view}.webp`);
        const metadataPath = path.join(imagesDir, `${entityId}-${view}.json`);

        try {
            const imageBuffer = Buffer.from(base64Data, "base64");
            fs.writeFileSync(imagePath, imageBuffer);

            const metadata: ImageCacheMetadata = {
                productId: entityId,
                productName: view,
                prompt,
                generatedAt: new Date().toISOString(),
                imageModel,
            };
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        } catch {
            // Silently fail
        }
    }

    /**
     * Check if an image with a specific view is cached
     */
    hasImageWithView(
        salesChannel: string,
        entityId: string,
        view: string,
        mediaType: MediaType = DEFAULT_MEDIA_TYPE
    ): boolean {
        if (!this.shouldUseCache) return false;
        const imagePath = path.join(
            this.getMediaTypeDir(salesChannel, mediaType),
            `${entityId}-${view}.webp`
        );
        return fs.existsSync(imagePath);
    }

    /**
     * Load image with a specific view
     */
    loadImageWithView(
        salesChannel: string,
        entityId: string,
        view: string,
        mediaType: MediaType = DEFAULT_MEDIA_TYPE
    ): string | null {
        if (!this.shouldUseCache) return null;

        const imagePath = path.join(
            this.getMediaTypeDir(salesChannel, mediaType),
            `${entityId}-${view}.webp`
        );

        if (!fs.existsSync(imagePath)) {
            return null;
        }

        try {
            const imageBuffer = fs.readFileSync(imagePath);
            return imageBuffer.toString("base64");
        } catch {
            return null;
        }
    }

    /**
     * Load image metadata for a specific view (contains the prompt used to generate)
     */
    loadImageMetadataWithView(
        salesChannel: string,
        entityId: string,
        view: string,
        mediaType: MediaType = DEFAULT_MEDIA_TYPE
    ): ImageCacheMetadata | null {
        if (!this.shouldUseCache) return null;

        const metadataPath = path.join(
            this.getMediaTypeDir(salesChannel, mediaType),
            `${entityId}-${view}.json`
        );

        if (!fs.existsSync(metadataPath)) return null;
        try {
            const data = fs.readFileSync(metadataPath, "utf-8");
            return JSON.parse(data) as ImageCacheMetadata;
        } catch {
            return null;
        }
    }

    /**
     * Check if cached image prompt matches current product prompt
     * Returns true if the image should be regenerated (prompt mismatch)
     */
    isImageStale(
        salesChannel: string,
        entityId: string,
        view: string,
        currentBasePrompt: string,
        mediaType: MediaType = DEFAULT_MEDIA_TYPE
    ): boolean {
        const metadata = this.loadImageMetadataWithView(salesChannel, entityId, view, mediaType);
        if (!metadata) return false;

        const cachedPrompt = metadata.prompt || "";
        const cachedBase = (cachedPrompt.split(",")[0] || "").trim();
        const currentBase = (currentBasePrompt.split(",")[0] || "").trim();

        return cachedBase.toLowerCase() !== currentBase.toLowerCase();
    }

    /**
     * Delete cached image and metadata for a specific view
     */
    deleteImageWithView(
        salesChannel: string,
        entityId: string,
        view: string,
        mediaType: MediaType = DEFAULT_MEDIA_TYPE
    ): void {
        const imagesDir = this.getMediaTypeDir(salesChannel, mediaType);
        const imagePath = path.join(imagesDir, `${entityId}-${view}.webp`);
        const metadataPath = path.join(imagesDir, `${entityId}-${view}.json`);

        try {
            if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
            if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);
        } catch {
            // Silently fail
        }
    }

    /**
     * Check if an image is cached for an entity within a SalesChannel (legacy single-image format)
     */
    hasImageForSalesChannel(
        salesChannel: string,
        entityId: string,
        mediaType: MediaType = DEFAULT_MEDIA_TYPE
    ): boolean {
        if (!this.shouldUseCache) return false;
        const imagePath = path.join(
            this.getMediaTypeDir(salesChannel, mediaType),
            `${entityId}.webp`
        );
        return fs.existsSync(imagePath);
    }

    /**
     * Load cached image for an entity within a SalesChannel (legacy single-image format)
     * @returns Base64-encoded image data, or null if not cached
     */
    loadImageForSalesChannel(
        salesChannel: string,
        entityId: string,
        mediaType: MediaType = DEFAULT_MEDIA_TYPE
    ): string | null {
        if (!this.shouldUseCache) return null;

        const imagePath = path.join(
            this.getMediaTypeDir(salesChannel, mediaType),
            `${entityId}.webp`
        );

        if (!fs.existsSync(imagePath)) {
            return null;
        }

        try {
            const imageBuffer = fs.readFileSync(imagePath);
            return imageBuffer.toString("base64");
        } catch {
            return null;
        }
    }

    /**
     * Save image to cache within a SalesChannel (legacy single-image format)
     */
    saveImageForSalesChannel(
        salesChannel: string,
        entityId: string,
        entityName: string,
        base64Data: string,
        prompt: string,
        imageModel?: string,
        mediaType: MediaType = DEFAULT_MEDIA_TYPE
    ): void {
        if (!this.shouldSaveToCache) return;

        const imagesDir = this.getMediaTypeDir(salesChannel, mediaType);
        this.ensureDir(imagesDir);

        const imagePath = path.join(imagesDir, `${entityId}.webp`);
        const metadataPath = path.join(imagesDir, `${entityId}.json`);

        try {
            const imageBuffer = Buffer.from(base64Data, "base64");
            fs.writeFileSync(imagePath, imageBuffer);

            const metadata: ImageCacheMetadata = {
                productId: entityId,
                productName: entityName,
                prompt,
                generatedAt: new Date().toISOString(),
                imageModel,
            };
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        } catch {
            // Silently fail - caching is not critical
        }
    }

    /**
     * Get the number of cached images for a SalesChannel (across all media type subdirectories)
     */
    getImageCountForSalesChannel(salesChannel: string): number {
        const imagesDir = this.getSalesChannelImagesDir(salesChannel);

        if (!fs.existsSync(imagesDir)) {
            return 0;
        }

        const subdirs = ["product_media", "category_media", "cms_media", "property_images"];
        let count = 0;
        for (const subdir of subdirs) {
            const subdirPath = path.join(imagesDir, subdir);
            if (fs.existsSync(subdirPath)) {
                const files = fs.readdirSync(subdirPath);
                count += files.filter((f) => f.endsWith(".webp")).length;
            }
        }
        return count;
    }

    private sanitizeName(name: string): string {
        return name
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9-]/g, "");
    }

    private ensureDir(dir: string): void {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}
