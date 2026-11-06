/**
 * UUID Generation Utilities
 *
 * Provides UUID generation functions for Shopware entities.
 */

import { createHash } from "node:crypto";

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

/** Shopware routes Store API keys by this prefix (`AccessKeyHelper::SALES_CHANNEL_IDENTIFIER`) */
const SALES_CHANNEL_KEY_PREFIX = "SWSC";
/** Shopware's keys are base64 of 16 random characters without padding, uppercased: 22 characters */
const SALES_CHANNEL_KEY_RANDOM_LENGTH = 22;
const ACCESS_KEY_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Generate a Store API access key for a SalesChannel.
 *
 * Shopware rejects keys without the "SWSC" prefix (403 FRAMEWORK__API_INVALID_ACCESS_KEY).
 *
 * @returns A 26-character access key: "SWSC" plus 22 uppercase letters and digits
 *
 * @example
 * generateAccessKey() // "SWSCAB12CD34EF56GH78IJ90KL"
 */
export function generateAccessKey(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(SALES_CHANNEL_KEY_RANDOM_LENGTH));
    const random = Array.from(bytes, (b) => ACCESS_KEY_CHARS.charAt(b % ACCESS_KEY_CHARS.length));
    return SALES_CHANNEL_KEY_PREFIX + random.join("");
}

/**
 * Derive a stable 32-character Shopware ID from a string.
 *
 * Use for entities that must keep the same ID across runs (idempotent upserts).
 *
 * @example
 * deterministicUUID("review:<productId>:0") // same value on every call
 */
export function deterministicUUID(input: string): string {
    return createHash("sha256").update(input).digest("hex").slice(0, 32);
}
