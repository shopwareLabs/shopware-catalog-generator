/**
 * Types for the global property cache
 *
 * The property cache stores AI-generated property groups for reuse across
 * multiple products and sales channels.
 */

/**
 * A cached property group with its options
 */
export interface CachedPropertyGroup {
    /** Display name of the property group (e.g., "Finish", "Body Wood") */
    name: string;
    /** Kebab-case slug used as filename (e.g., "finish", "body-wood") */
    slug: string;
    /** Display type for Shopware frontend */
    displayType: "text" | "color";
    /** Available options for this property group */
    options: string[];
    /** Optional price modifiers per option (multiplier, e.g., 1.1 = +10%) */
    priceModifiers?: Record<string, number>;
    /** Optional hex codes for color options (for displayType: "color") */
    colorHexCodes?: Record<string, string>;
    /** ISO timestamp when this group was created */
    createdAt: string;
    /** Source of this property group */
    source: "fixture" | "ai-generated";
}

/**
 * Index file structure for the property cache
 */
export interface PropertyCacheIndex {
    /** ISO timestamp of last update */
    updatedAt: string;
    /** Number of cached property groups */
    count: number;
    /** List of cached group slugs */
    groups: string[];
}
