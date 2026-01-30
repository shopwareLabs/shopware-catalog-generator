import { mock } from "bun:test";
import crypto from "node:crypto";

import type { ShopwareFilter, SyncOperation } from "../../src/shopware/api-helpers.js";

/**
 * API call record for verification in tests
 */
export interface ApiCall {
    method: "get" | "post" | "patch" | "delete" | "postRaw";
    endpoint: string;
    body?: unknown;
}

/**
 * Mock response configuration
 */
export interface MockResponse<T = unknown> {
    data: T;
    status?: number;
    ok?: boolean;
}

/**
 * Mock API Helpers for testing post-processors without mocking globalThis.fetch
 *
 * Usage:
 * ```typescript
 * const mockApi = new MockApiHelpers();
 * mockApi.mockSearchResponse("sales-channel", [{ id: "sc-123", name: "Test" }]);
 * mockApi.mockSyncSuccess();
 *
 * const context = createMockContext();
 * context.api = mockApi;
 *
 * await processor.process(context);
 *
 * expect(mockApi.getCalls()).toContainEqual(
 *   expect.objectContaining({ method: "post", endpoint: "_action/sync" })
 * );
 * ```
 */
export class MockApiHelpers {
    private calls: ApiCall[] = [];
    private searchResponses: Map<string, unknown[]> = new Map();
    private findByNameResponses: Map<string, string | null> = new Map();
    private postResponses: Map<string, unknown> = new Map();
    private getResponses: Map<string, unknown> = new Map();
    private defaultSearchResponse: unknown[] = [];
    private defaultPostResponse: unknown = {};
    private syncShouldSucceed = true;
    private syncError: Error | null = null;

    // Required properties from ShopwareApiHelpers for type compatibility
    private baseURL = "http://localhost";
    private tokenGetter: () => Promise<string> = async () => "mock-token";

    /** Get the base URL (for test verification) */
    getBaseURL(): string {
        return this.baseURL;
    }

    // Mocks for spying
    readonly searchEntitiesMock = mock(() => Promise.resolve([]));
    readonly syncEntitiesMock = mock(() => Promise.resolve());
    readonly upsertEntityMock = mock(() => Promise.resolve());
    readonly deleteEntityMock = mock(() => Promise.resolve(true));
    readonly deleteEntitiesMock = mock(() => Promise.resolve());
    readonly postMock = mock(() => Promise.resolve({}));
    readonly getMock = mock(() => Promise.resolve({}));
    readonly patchMock = mock(() => Promise.resolve({}));
    readonly deleteMock = mock(() => Promise.resolve());

    // =========================================================================
    // Configuration methods
    // =========================================================================

    /**
     * Mock search response for a specific entity type
     */
    mockSearchResponse<T>(entity: string, data: T[]): this {
        this.searchResponses.set(entity, data);
        return this;
    }

    /**
     * Mock findByName response
     */
    mockFindByName(entity: string, name: string, id: string | null): this {
        this.findByNameResponses.set(`${entity}:${name}`, id);
        return this;
    }

    /**
     * Mock POST response for a specific endpoint
     */
    mockPostResponse<T>(endpoint: string, data: T): this {
        this.postResponses.set(endpoint, data);
        return this;
    }

    /**
     * Mock GET response for a specific endpoint
     */
    mockGetResponse<T>(endpoint: string, data: T): this {
        this.getResponses.set(endpoint, data);
        return this;
    }

    /**
     * Configure sync to succeed (default)
     */
    mockSyncSuccess(): this {
        this.syncShouldSucceed = true;
        this.syncError = null;
        return this;
    }

    /**
     * Configure sync to fail with an error
     */
    mockSyncFailure(error: Error): this {
        this.syncShouldSucceed = false;
        this.syncError = error;
        return this;
    }

    /**
     * Set default search response when no specific mock is set
     */
    setDefaultSearchResponse<T>(data: T[]): this {
        this.defaultSearchResponse = data;
        return this;
    }

    /**
     * Set default POST response when no specific mock is set
     */
    setDefaultPostResponse<T>(data: T): this {
        this.defaultPostResponse = data;
        return this;
    }

    /**
     * Get all API calls made
     */
    getCalls(): ApiCall[] {
        return [...this.calls];
    }

    /**
     * Get calls filtered by method
     */
    getCallsByMethod(method: ApiCall["method"]): ApiCall[] {
        return this.calls.filter((c) => c.method === method);
    }

    /**
     * Get calls filtered by endpoint (partial match)
     */
    getCallsByEndpoint(endpointPattern: string): ApiCall[] {
        return this.calls.filter((c) => c.endpoint.includes(endpointPattern));
    }

    /**
     * Reset all mocks and call history
     */
    reset(): this {
        this.calls = [];
        this.searchResponses.clear();
        this.findByNameResponses.clear();
        this.postResponses.clear();
        this.getResponses.clear();
        this.syncShouldSucceed = true;
        this.syncError = null;
        return this;
    }

    // =========================================================================
    // ShopwareApiHelpers interface implementation
    // =========================================================================

    createUUID(): string {
        return crypto.randomUUID().replace(/-/g, "");
    }

    capitalizeString(s: string): string {
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    /**
     * Set the token getter function
     */
    setTokenGetter(getter: () => Promise<string>): void {
        this.tokenGetter = getter;
    }

    /**
     * Get the current access token (uses the tokenGetter)
     */
    async getAccessToken(): Promise<string> {
        return this.tokenGetter();
    }

    /**
     * Get authorization headers asynchronously
     */
    async getAuthHeadersAsync(): Promise<Record<string, string>> {
        const token = await this.getAccessToken();
        if (token) {
            return { Authorization: `Bearer ${token}` };
        }
        return {};
    }

    async searchEntities<T = Record<string, unknown>>(
        entity: string,
        _filters: ShopwareFilter[] = [],
        _options: {
            associations?: Record<string, unknown>;
            limit?: number;
            ids?: string[];
            includes?: Record<string, string[]>;
            sort?: Array<{ field: string; order: "ASC" | "DESC" }>;
        } = {}
    ): Promise<T[]> {
        this.calls.push({
            method: "post",
            endpoint: `search/${entity}`,
            body: { _filters, _options },
        });
        this.searchEntitiesMock();

        const response = this.searchResponses.get(entity);
        if (response !== undefined) {
            return response as T[];
        }
        return this.defaultSearchResponse as T[];
    }

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

    async findByName(
        entity: string,
        name: string,
        _additionalFilters: ShopwareFilter[] = []
    ): Promise<string | null> {
        this.calls.push({ method: "post", endpoint: `search/${entity}`, body: { name } });

        const key = `${entity}:${name}`;
        const response = this.findByNameResponses.get(key);
        if (response !== undefined) {
            return response;
        }

        // Check search responses for matching name
        const searchData = this.searchResponses.get(entity) as
            | Array<{ id: string; name: string }>
            | undefined;
        const match = searchData?.find((item) => item.name === name);
        return match?.id ?? null;
    }

    async syncEntities(_operations: Record<string, SyncOperation>): Promise<void> {
        this.calls.push({ method: "post", endpoint: "_action/sync", body: _operations });
        this.syncEntitiesMock();

        if (!this.syncShouldSucceed && this.syncError) {
            throw this.syncError;
        }
    }

    async upsertEntity(entity: string, payload: Record<string, unknown>): Promise<void> {
        this.upsertEntityMock();
        await this.syncEntities({
            [`upsert-${entity}`]: {
                entity: entity.replace(/-/g, "_"),
                action: "upsert",
                payload: [payload],
            },
        });
    }

    async deleteEntity(entity: string, id: string): Promise<boolean> {
        this.calls.push({ method: "delete", endpoint: `${entity}/${id}` });
        this.deleteEntityMock();
        return true;
    }

    async deleteEntities(entity: string, ids: string[]): Promise<void> {
        this.deleteEntitiesMock();
        if (ids.length === 0) return;
        await this.syncEntities({
            [`delete-${entity}`]: {
                entity,
                action: "delete",
                payload: ids.map((id) => ({ id })),
            },
        });
    }

    async uploadMedia(
        mediaId: string,
        _file: Buffer,
        fileName: string,
        extension: string
    ): Promise<void> {
        const endpoint = `_action/media/${mediaId}/upload?extension=${extension}&fileName=${encodeURIComponent(fileName)}`;
        this.calls.push({ method: "postRaw", endpoint, body: "[Buffer]" });
    }

    async getCurrencyId(isoCode = "EUR"): Promise<string> {
        this.calls.push({ method: "post", endpoint: "search/currency", body: { isoCode } });
        return "currency-id-mock";
    }

    async getStandardTaxId(): Promise<string> {
        this.calls.push({ method: "post", endpoint: "search/tax" });
        return "tax-id-mock";
    }

    async getSalesChannelByName(name: string): Promise<{
        id: string;
        navigationCategoryId: string;
        currencyId?: string;
    } | null> {
        const results = await this.searchEntities<{
            id: string;
            navigationCategoryId: string;
            currencyId?: string;
        }>("sales-channel", [
            { type: "equals", field: "name", value: this.capitalizeString(name) },
        ]);
        return results[0] ?? null;
    }

    async getProductMediaFolderId(): Promise<string | null> {
        this.calls.push({ method: "post", endpoint: "search/media-default-folder" });
        return "product-media-folder-mock";
    }

    async getCategoryMediaFolderId(): Promise<string | null> {
        this.calls.push({ method: "post", endpoint: "search/media-default-folder" });
        return "category-media-folder-mock";
    }

    async findCmsPageByName(name: string): Promise<string | null> {
        return this.findByName("cms-page", name);
    }

    async findCategoryByName(name: string, parentId: string): Promise<string | null> {
        return this.findByName("category", name, [
            { type: "equals", field: "parentId", value: parentId },
        ]);
    }

    async findLandingPageByName(name: string): Promise<string | null> {
        return this.findByName("landing-page", name);
    }

    generateAccessKey(): string {
        return "SWMOCKKEY1234567890123456789012";
    }

    // =========================================================================
    // Low-level HTTP methods
    // =========================================================================

    async post<T = unknown>(endpoint: string, body?: unknown): Promise<T> {
        this.calls.push({ method: "post", endpoint, body });
        this.postMock();

        const response = this.postResponses.get(endpoint);
        if (response !== undefined) {
            return response as T;
        }
        return this.defaultPostResponse as T;
    }

    async postRaw(
        endpoint: string,
        _body: Buffer,
        _headers: Record<string, string>
    ): Promise<void> {
        this.calls.push({ method: "postRaw", endpoint, body: "[Buffer]" });
    }

    async get<T = unknown>(endpoint: string): Promise<T> {
        this.calls.push({ method: "get", endpoint });
        this.getMock();

        const response = this.getResponses.get(endpoint);
        if (response !== undefined) {
            return response as T;
        }
        return {} as T;
    }

    async delete(endpoint: string): Promise<void> {
        this.calls.push({ method: "delete", endpoint });
        this.deleteMock();
    }

    async patch<T = unknown>(endpoint: string, body?: unknown): Promise<T> {
        this.calls.push({ method: "patch", endpoint, body });
        this.patchMock();
        return {} as T;
    }
}

/**
 * Create a pre-configured mock API helper for common test scenarios
 */
export function createMockApiHelpers(): MockApiHelpers {
    return new MockApiHelpers().mockSyncSuccess();
}
