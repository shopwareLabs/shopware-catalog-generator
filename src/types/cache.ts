import type { CategoryNode } from "./shopware.js";

/**
 * Cache-related types
 */

/** Metadata for cached products */
export interface ProductCacheMetadata {
    category: string;
    generatedAt: string;
    count: number;
    textModel?: string;
}

/** Cached category tree for a SalesChannel */
export interface CategoryTreeCache {
    /** SalesChannel name */
    salesChannel: string;
    /** When the tree was generated */
    generatedAt: string;
    /** The category tree structure */
    tree: CategoryNode[];
    /** Total products across all categories */
    totalProducts: number;
    /** Text model used for generation */
    textModel?: string;
}

/** SalesChannel cache metadata */
export interface SalesChannelCacheMetadata {
    /** SalesChannel name */
    name: string;
    /** Description used for generation */
    description: string;
    /** When the cache was created */
    createdAt: string;
    /** UUID of the SalesChannel in Shopware (if created) */
    shopwareId?: string;
}

/** Metadata for cached images */
export interface ImageCacheMetadata {
    productId: string;
    productName: string;
    prompt: string;
    generatedAt: string;
    imageModel?: string;
}

/** Cache configuration options */
export interface CacheOptions {
    /** Enable/disable caching (default: true) */
    enabled: boolean;
    /** Cache directory (default: ./generated) */
    cacheDir: string;
    /** Use cached products if available (default: true) */
    useCache: boolean;
    /** Save new generations to cache (default: true) */
    saveToCache: boolean;
}

/** Default cache options */
export const DEFAULT_CACHE_OPTIONS: CacheOptions = {
    enabled: true,
    cacheDir: "./generated",
    useCache: true,
    saveToCache: true,
};
