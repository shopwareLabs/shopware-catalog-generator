/**
 * Shared image utilities for product and category image processors
 */

import type { ShopwareRequestContext } from "../utils/shopware-request.js";

import { apiUpload, executeWithRetry } from "../utils/index.js";

/**
 * Detect image format from magic bytes
 */
export function detectImageFormat(buffer: Buffer): {
    extension: string;
    mimeType: string;
} {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return { extension: "jpg", mimeType: "image/jpeg" };
    }
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        return { extension: "png", mimeType: "image/png" };
    }
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
        return { extension: "gif", mimeType: "image/gif" };
    }
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
        if (
            buffer[8] === 0x57 &&
            buffer[9] === 0x45 &&
            buffer[10] === 0x42 &&
            buffer[11] === 0x50
        ) {
            return { extension: "webp", mimeType: "image/webp" };
        }
    }
    return { extension: "jpg", mimeType: "image/jpeg" };
}

/**
 * Upload image with retry logic for transient failures
 * Retries on rate limits, timeouts, and 5xx errors
 */
export async function uploadImageWithRetry(
    context: ShopwareRequestContext,
    mediaId: string,
    fileName: string,
    imageBuffer: Buffer,
    format: { extension: string; mimeType: string }
): Promise<Response> {
    const endpoint = `_action/media/${mediaId}/upload?extension=${format.extension}&fileName=${encodeURIComponent(fileName)}`;

    return executeWithRetry(
        async () => {
            const response = await apiUpload(context, endpoint, imageBuffer, format.mimeType);

            if (response.status >= 500 && response.status < 600) {
                const error = new Error(`Server error: ${response.status}`);
                Object.assign(error, { status: 429 });
                throw error;
            }

            return response;
        },
        { maxRetries: 3, baseDelay: 2000 }
    );
}
