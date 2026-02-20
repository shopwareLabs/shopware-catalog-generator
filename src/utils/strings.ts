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

/**
 * Build a store-scoped name used for store-specific CMS resources.
 */
export function toStoreScopedName(name: string, salesChannelName: string): string {
    return `${name} [${salesChannelName}]`;
}

/**
 * Convert a fixture/page name to a URL-safe slug used by landing pages.
 */
export function toFixtureUrlSlug(name: string): string {
    return name.toLowerCase().replace(/\s+/g, "-").replace(/&/g, "and");
}

/**
 * Create a short deterministic hash from a string using djb2 algorithm.
 * Useful for generating unique suffixes when strings must be truncated.
 *
 * @param input - The string to hash
 * @param length - Desired hash length (default: 5, max: 8)
 * @returns Alphanumeric hash string of the specified length
 *
 * @example
 * createShortHash("adjustable-100-135-cm-polyester-exterior-foam") // "a3x1k"
 * createShortHash("adjustable-100-135-cm-polyester-exterior-nylon") // "b7m2p"
 */
export function createShortHash(input: string, length: number = 5): string {
    const safeLength = Math.min(Math.max(1, length), 8);
    const chars = "0123456789abcdefghijklmnopqrstuvwxyz";

    // djb2 hash - simple, fast, good distribution
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
        hash = (hash * 33) ^ input.charCodeAt(i);
        hash = hash >>> 0; // Keep as unsigned 32-bit
    }

    // Convert to alphanumeric string
    let result = "";
    let remaining = hash;
    for (let i = 0; i < safeLength; i++) {
        result += chars[remaining % chars.length];
        remaining = Math.floor(remaining / chars.length);
        // Mix in extra bits for longer hashes
        if (remaining === 0) {
            remaining = (hash * (i + 2)) >>> 0;
        }
    }

    return result;
}
