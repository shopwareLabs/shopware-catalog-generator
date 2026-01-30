/**
 * Shopware API Request Utilities
 *
 * Provides shared functions for making Shopware API requests.
 * Used by post-processors to avoid code duplication.
 */

import type { ShopwareApiHelpers } from "../shopware/api-helpers.js";

/** Context required for making Shopware API requests */
export interface ShopwareRequestContext {
    /** Shopware API helpers (optional) */
    api?: ShopwareApiHelpers;
    /** Shopware API base URL */
    shopwareUrl: string;
    /** Function to get access token */
    getAccessToken: () => Promise<string>;
}

/**
 * Make a POST request to the Shopware API
 *
 * Uses context.api if available, falls back to raw fetch for backwards compatibility.
 *
 * @param context - Request context with API helpers or fallback info
 * @param endpoint - API endpoint (e.g., "search/product")
 * @param body - Request body
 * @returns Response object
 */
export async function apiPost(
    context: ShopwareRequestContext,
    endpoint: string,
    body: unknown
): Promise<Response> {
    // Use context.api if available
    if (context.api) {
        const result = await context.api.post(endpoint, body);
        // Create a Response-like object for compatibility
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }

    // Fallback to raw fetch
    const accessToken = await context.getAccessToken();
    const url = `${context.shopwareUrl}/api/${endpoint}`;
    return fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
    });
}

/**
 * Upload a file to the Shopware API
 *
 * Uses context.api.postRaw if available, falls back to raw fetch for backwards compatibility.
 *
 * @param context - Request context with API helpers or fallback info
 * @param endpoint - API endpoint for upload
 * @param buffer - File content as Buffer
 * @param contentType - MIME type of the file
 * @returns Response object
 */
export async function apiUpload(
    context: ShopwareRequestContext,
    endpoint: string,
    buffer: Buffer,
    contentType: string
): Promise<Response> {
    // Use context.api.postRaw if available
    if (context.api) {
        try {
            await context.api.postRaw(endpoint, buffer, { "Content-Type": contentType });
            // Create a successful Response for compatibility
            return new Response(null, {
                status: 204,
                headers: { "Content-Type": contentType },
            });
        } catch (error) {
            // Create an error Response for compatibility
            const errorMessage = error instanceof Error ? error.message : String(error);
            return new Response(errorMessage, {
                status: 500,
                headers: { "Content-Type": "text/plain" },
            });
        }
    }

    // Fallback to raw fetch
    const accessToken = await context.getAccessToken();
    const url = `${context.shopwareUrl}/api/${endpoint}`;
    return fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": contentType,
            Authorization: `Bearer ${accessToken}`,
        },
        body: buffer,
    });
}
