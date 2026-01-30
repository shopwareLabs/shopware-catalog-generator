/**
 * UUID Generation Utilities
 *
 * Provides UUID generation functions for Shopware entities.
 */

/**
 * Generate a 32-character UUID for Shopware entities
 *
 * Uses crypto.randomUUID() for cryptographically secure randomness.
 *
 * @returns A 32-character hexadecimal string (UUID without dashes)
 *
 * @example
 * generateUUID() // "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
 */
export function generateUUID(): string {
    return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Generate a random access key for a SalesChannel
 *
 * @returns A 32-character access key starting with "SW"
 *
 * @example
 * generateAccessKey() // "SWAB12CD34EF56GH78IJ90KL12MN34"
 */
export function generateAccessKey(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let key = "SW";
    for (let i = 0; i < 30; i++) {
        key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return key;
}
