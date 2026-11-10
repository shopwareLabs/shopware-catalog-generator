/**
 * Shared image utilities for product and category image processors
 */

import type { ShopwareRequestContext } from "../utils/shopware-request.js";

import { apiUpload, executeWithRetry } from "../utils/index.js";

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
