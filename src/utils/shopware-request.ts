/**
 * Shopware API Request Utilities
 *
 * Provides shared functions for making Shopware API requests via the central api gateway.
 * Used by post-processors to avoid code duplication.
 */

import type { ShopwareApi } from "../shopware/api-helpers.js";

/** Context required for making Shopware API requests */
export interface ShopwareRequestContext {
    /** Shopware API helpers — the single gateway for all Shopware calls */
    api: ShopwareApi;
}

/**
 * Make a POST request to the Shopware API via the central api gateway.
 */
export async function apiPost(
    context: ShopwareRequestContext,
    endpoint: string,
    body: unknown
): Promise<Response> {
    const result = await context.api.post(endpoint, body);
    return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
}

/**
 * Make a PATCH request to the Shopware API via the central api gateway.
 */
export async function apiPatch(
    context: ShopwareRequestContext,
    endpoint: string,
    body: unknown
): Promise<Response> {
    const result = await context.api.patch(endpoint, body);
    return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
}

/**
 * Upload a file to the Shopware API via the central api gateway.
 */
export async function apiUpload(
    context: ShopwareRequestContext,
    endpoint: string,
    buffer: Buffer,
    contentType: string
): Promise<Response> {
    try {
        await context.api.postRaw(endpoint, buffer, { "Content-Type": contentType });
        return new Response(null, { status: 204 });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return new Response(errorMessage, { status: 500 });
    }
}
