/**
 * Shopware API Helpers
 *
 * Provides convenience methods that wrap the official @shopware/api-client,
 * offering a simpler interface for common operations like searching, syncing,
 * and deleting entities.
 */

import type { AdminApiClient } from "./admin-client.js";

import {
    capitalizeString as capitalizeStringUtil,
    generateAccessKey as generateAccessKeyUtil,
} from "../utils/index.js";

/** Shopware filter structure */
export interface ShopwareFilter {
    type:
        | "equals"
        | "equalsAny"
        | "contains"
        | "multi"
        | "or"
        | "and"
        | "not"
        | "range"
        | "prefix"
        | "suffix";
    field?: string;
    value?: unknown;
    operator?: "or" | "and";
    queries?: ShopwareFilter[];
}

/** Sync operation for batch create/update/delete */
export interface SyncOperation {
    entity: string;
    action: "upsert" | "delete";
    payload: Array<Record<string, unknown>>;
}

/** Search response structure */
interface SearchResponse<T = Record<string, unknown>> {
    total: number;
    data: T[];
}

/** Token getter function type */
export type TokenGetter = () => Promise<string>;

/**
 * Shopware API Helpers class
 *
 * Provides convenience methods for common Shopware API operations.
 * Uses the official @shopware/api-client under the hood.
 */
export class ShopwareApiHelpers {
    private baseURL: string;
    private getAccessToken: TokenGetter;

    constructor(_client: AdminApiClient, baseURL: string, getAccessToken?: TokenGetter) {
        // Note: _client parameter reserved for future use with official client's invoke method
        void _client;
        this.baseURL = baseURL.replace(/\/$/, "");
        // Default token getter uses the client's internal state
        this.getAccessToken = getAccessToken ?? (async () => "");
    }

    /**
     * Set the token getter function
     */
    setTokenGetter(getter: TokenGetter): void {
        this.getAccessToken = getter;
    }

    /**
     * Capitalize first letter of string
     */
    capitalizeString(s: string): string {
        return capitalizeStringUtil(s);
    }

    /**
     * Search for entities with filters and associations
     *
     * @param entity - Entity name (e.g., "product", "category")
     * @param filters - Array of filter objects
     * @param options - Additional search options
     * @returns Array of matching entities
     */
    async searchEntities<T = Record<string, unknown>>(
        entity: string,
        filters: ShopwareFilter[] = [],
        options: {
            associations?: Record<string, unknown>;
            limit?: number;
            ids?: string[];
            includes?: Record<string, string[]>;
            sort?: Array<{ field: string; order: "ASC" | "DESC" }>;
        } = {}
    ): Promise<T[]> {
        const body: Record<string, unknown> = {
            filter: filters,
            limit: options.limit ?? 500,
        };

        if (options.associations) {
            body.associations = options.associations;
        }
        if (options.ids) {
            body.ids = options.ids;
        }
        if (options.includes) {
            body.includes = options.includes;
        }
        if (options.sort) {
            body.sort = options.sort;
        }

        const response = await this.post<SearchResponse<T>>(`search/${entity}`, body);
        return response.data ?? [];
    }

    /**
     * Find a single entity by ID
     */
    async getEntity<T = Record<string, unknown>>(
        entity: string,
        id: string,
        associations?: Record<string, unknown>
    ): Promise<T | null> {
        const results = await this.searchEntities<T>(entity, [], {
            ids: [id],
            associations,
            limit: 1,
        });
        return results[0] ?? null;
    }

    /**
     * Find entity by name
     *
     * @param entity - Entity name
     * @param name - Name to search for
     * @param additionalFilters - Additional filters to apply
     * @returns Entity ID if found, null otherwise
     */
    async findByName(
        entity: string,
        name: string,
        additionalFilters: ShopwareFilter[] = []
    ): Promise<string | null> {
        const filters: ShopwareFilter[] = [
            { type: "equals", field: "name", value: name },
            ...additionalFilters,
        ];

        const results = await this.searchEntities<{ id: string }>(entity, filters, { limit: 1 });
        return results[0]?.id ?? null;
    }

    /**
     * Batch sync entities (create/update/delete)
     *
     * @param operations - Array of sync operations
     */
    async syncEntities(operations: Record<string, SyncOperation>): Promise<void> {
        await this.post("_action/sync", operations);
    }

    /**
     * Create or update a single entity
     *
     * @param entity - Entity name
     * @param payload - Entity data (must include id for update)
     */
    async upsertEntity(entity: string, payload: Record<string, unknown>): Promise<void> {
        await this.syncEntities({
            [`upsert-${entity}`]: {
                entity: entity.replace(/-/g, "_"),
                action: "upsert",
                payload: [payload],
            },
        });
    }

    /**
     * Delete a single entity by ID
     *
     * @param entity - Entity name (e.g., "category", "product")
     * @param id - Entity ID
     * @returns true if deleted successfully
     */
    async deleteEntity(entity: string, id: string): Promise<boolean> {
        try {
            await this.delete(`${entity}/${id}`);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Batch delete entities by IDs
     *
     * @param entity - Entity name (use underscores, e.g., "product_media")
     * @param ids - Array of entity IDs
     */
    async deleteEntities(entity: string, ids: string[]): Promise<void> {
        if (ids.length === 0) return;

        const payload = ids.map((id) => ({ id }));

        await this.syncEntities({
            [`delete-${entity}`]: {
                entity,
                action: "delete",
                payload,
            },
        });
    }

    /**
     * Upload media file
     *
     * @param mediaId - ID of the media entity
     * @param file - File content as Buffer
     * @param fileName - Filename without extension
     * @param extension - File extension (e.g., "webp", "jpg")
     */
    async uploadMedia(
        mediaId: string,
        file: Buffer,
        fileName: string,
        extension: string
    ): Promise<void> {
        const endpoint = `_action/media/${mediaId}/upload?extension=${extension}&fileName=${encodeURIComponent(fileName)}`;

        const contentType =
            extension === "webp"
                ? "image/webp"
                : extension === "jpg" || extension === "jpeg"
                  ? "image/jpeg"
                  : extension === "png"
                    ? "image/png"
                    : "application/octet-stream";

        await this.postRaw(endpoint, file, { "Content-Type": contentType });
    }

    /**
     * Get currency ID by ISO code
     */
    async getCurrencyId(isoCode = "EUR"): Promise<string> {
        const results = await this.searchEntities<{ id: string }>(
            "currency",
            [{ type: "equals", field: "isoCode", value: isoCode }],
            { limit: 1 }
        );

        if (!results[0]) {
            throw new Error(`Currency "${isoCode}" not found`);
        }
        return results[0].id;
    }

    /**
     * Get standard tax ID
     */
    async getStandardTaxId(): Promise<string> {
        const results = await this.searchEntities<{ id: string }>("tax", [], { limit: 1 });

        if (!results[0]) {
            throw new Error("No tax rate found");
        }
        return results[0].id;
    }

    /**
     * Get sales channel by name
     */
    async getSalesChannelByName(name: string): Promise<{
        id: string;
        navigationCategoryId: string;
        currencyId?: string;
    } | null> {
        const results = await this.searchEntities<{
            id: string;
            navigationCategoryId: string;
            currencyId?: string;
        }>(
            "sales-channel",
            [{ type: "equals", field: "name", value: this.capitalizeString(name) }],
            {
                limit: 1,
            }
        );

        return results[0] ?? null;
    }

    /**
     * Get Product Media folder ID
     */
    async getProductMediaFolderId(): Promise<string | null> {
        // Try default folder configuration first
        const defaultFolders = await this.searchEntities<{ folder?: { id: string } }>(
            "media-default-folder",
            [{ type: "equals", field: "entity", value: "product" }],
            { associations: { folder: {} }, limit: 1 }
        );

        if (defaultFolders[0]?.folder?.id) {
            return defaultFolders[0].folder.id;
        }

        // Fallback: search by name
        const folders = await this.searchEntities<{ id: string }>(
            "media-folder",
            [{ type: "equals", field: "name", value: "Product Media" }],
            { limit: 1 }
        );

        return folders[0]?.id ?? null;
    }

    /**
     * Get Category Media folder ID
     */
    async getCategoryMediaFolderId(): Promise<string | null> {
        const defaultFolders = await this.searchEntities<{ folder?: { id: string } }>(
            "media-default-folder",
            [{ type: "equals", field: "entity", value: "category" }],
            { associations: { folder: {} }, limit: 1 }
        );

        if (defaultFolders[0]?.folder?.id) {
            return defaultFolders[0].folder.id;
        }

        const folders = await this.searchEntities<{ id: string }>(
            "media-folder",
            [{ type: "equals", field: "name", value: "Category Media" }],
            { limit: 1 }
        );

        return folders[0]?.id ?? null;
    }

    /**
     * Find CMS page by name
     */
    async findCmsPageByName(name: string): Promise<string | null> {
        return this.findByName("cms-page", name);
    }

    /**
     * Find category by name under a parent
     */
    async findCategoryByName(name: string, parentId: string): Promise<string | null> {
        return this.findByName("category", name, [
            { type: "equals", field: "parentId", value: parentId },
        ]);
    }

    /**
     * Find landing page by name
     */
    async findLandingPageByName(name: string): Promise<string | null> {
        return this.findByName("landing-page", name);
    }

    /**
     * Generate a random access key for a SalesChannel
     */
    generateAccessKey(): string {
        return generateAccessKeyUtil();
    }

    // =========================================================================
    // Low-level HTTP methods (for custom endpoints)
    // =========================================================================

    /**
     * Make a POST request to the API
     */
    async post<T = unknown>(endpoint: string, body?: unknown): Promise<T> {
        const authHeaders = await this.getAuthHeadersAsync();
        const response = await fetch(`${this.baseURL}/api/${endpoint}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                ...authHeaders,
            },
            body: body ? JSON.stringify(body) : undefined,
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`API POST ${endpoint} failed: ${response.status} - ${text}`);
        }

        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            return (await response.json()) as T;
        }
        return (await response.text()) as unknown as T;
    }

    /**
     * Make a POST request with raw body (for file uploads)
     */
    async postRaw(endpoint: string, body: Buffer, headers: Record<string, string>): Promise<void> {
        const authHeaders = await this.getAuthHeadersAsync();
        const response = await fetch(`${this.baseURL}/api/${endpoint}`, {
            method: "POST",
            headers: {
                ...headers,
                ...authHeaders,
            },
            body,
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`API POST ${endpoint} failed: ${response.status} - ${text}`);
        }
    }

    /**
     * Make a GET request to the API
     */
    async get<T = unknown>(endpoint: string): Promise<T> {
        const authHeaders = await this.getAuthHeadersAsync();
        const response = await fetch(`${this.baseURL}/api/${endpoint}`, {
            method: "GET",
            headers: {
                Accept: "application/json",
                ...authHeaders,
            },
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`API GET ${endpoint} failed: ${response.status} - ${text}`);
        }

        return (await response.json()) as T;
    }

    /**
     * Make a DELETE request to the API
     */
    async delete(endpoint: string): Promise<void> {
        const authHeaders = await this.getAuthHeadersAsync();
        const response = await fetch(`${this.baseURL}/api/${endpoint}`, {
            method: "DELETE",
            headers: authHeaders,
        });

        if (!response.ok && response.status !== 204) {
            const text = await response.text();
            throw new Error(`API DELETE ${endpoint} failed: ${response.status} - ${text}`);
        }
    }

    /**
     * Make a PATCH request to the API
     */
    async patch<T = unknown>(endpoint: string, body?: unknown): Promise<T> {
        const authHeaders = await this.getAuthHeadersAsync();
        const response = await fetch(`${this.baseURL}/api/${endpoint}`, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                ...authHeaders,
            },
            body: body ? JSON.stringify(body) : undefined,
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`API PATCH ${endpoint} failed: ${response.status} - ${text}`);
        }

        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            return (await response.json()) as T;
        }
        return (await response.text()) as unknown as T;
    }

    /**
     * Get authorization headers asynchronously
     */
    private async getAuthHeadersAsync(): Promise<Record<string, string>> {
        const token = await this.getAccessToken();
        if (token) {
            return { Authorization: `Bearer ${token}` };
        }
        return {};
    }
}

/**
 * Create API helpers instance
 *
 * @param client - Admin API client
 * @param baseURL - Base URL of Shopware instance
 * @param getAccessToken - Optional function to get fresh access token
 */
export function createApiHelpers(
    client: AdminApiClient,
    baseURL: string,
    getAccessToken?: TokenGetter
): ShopwareApiHelpers {
    return new ShopwareApiHelpers(client, baseURL, getAccessToken);
}
