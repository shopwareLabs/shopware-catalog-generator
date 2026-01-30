/**
 * String normalization and manipulation utilities
 */

/**
 * Normalize a string by trimming and collapsing whitespace
 *
 * @param str - The string to normalize
 * @returns Normalized string with single spaces
 */
export function normalizeString(str: string): string {
    return str.trim().replace(/\s+/g, " ");
}

/**
 * Strip HTML tags from a string
 *
 * @param html - String potentially containing HTML
 * @returns String with HTML tags removed
 */
export function stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, " ");
}

/**
 * Decode common HTML entities
 *
 * @param str - String with HTML entities
 * @returns String with entities decoded
 */
export function decodeHtmlEntities(str: string): string {
    return str
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'");
}

/**
 * Normalize a description by stripping HTML, decoding entities, and collapsing whitespace
 *
 * @param description - The description to normalize
 * @returns Clean, normalized description
 */
export function normalizeDescription(description: string): string {
    // Strip HTML tags
    let clean = stripHtml(description);
    // Decode HTML entities
    clean = decodeHtmlEntities(clean);
    // Collapse whitespace after entity decoding
    clean = clean.replace(/\s+/g, " ").trim();
    return clean;
}

/**
 * Capitalize the first letter of each word in a string
 *
 * @param str - The string to capitalize
 * @returns String with capitalized words
 */
export function capitalizeString(str: string): string {
    return str
        .split(" ")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(" ");
}

/**
 * Generate a placeholder description for a category
 *
 * @param categoryName - Name of the category
 * @returns Placeholder description
 */
export function generateCategoryPlaceholder(categoryName: string): string {
    return `Browse our ${categoryName} collection.`;
}

/**
 * Generate a placeholder description for a product
 *
 * @param productName - Name of the product
 * @param categoryName - Name of the category
 * @returns Placeholder description
 */
export function generateProductPlaceholder(productName: string, categoryName: string): string {
    return `High-quality ${productName} from our ${categoryName} collection.`;
}

/**
 * Generate a placeholder description for a property group
 *
 * @param groupName - Name of the property group
 * @returns Placeholder description
 */
export function generatePropertyGroupPlaceholder(groupName: string): string {
    return `${groupName} property options`;
}

/**
 * Convert a string to kebab-case
 *
 * @param str - The string to convert
 * @returns kebab-case string
 *
 * @example
 * toKebabCase("Body Wood") // "body-wood"
 * toKebabCase("Pickup Type") // "pickup-type"
 */
export function toKebabCase(str: string): string {
    return str
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}
