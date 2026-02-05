import { describe, expect, mock, test } from "bun:test";
import { CommerceProcessor } from "../../../../src/post-processors/cms/commerce-processor.js";
import type { PostProcessorContext } from "../../../../src/post-processors/index.js";

// Helper to create mock cache
function createMockCache() {
    return {
        getSalesChannelDir: mock(() => "/tmp/test-cache"),
        loadProductMetadata: mock(() => null),
    };
}

// Track fetch calls for verification
interface FetchCall {
    url: string;
    method: string;
    body?: unknown;
}

// Helper to create mock context with fetch tracking
function createMockContext(
    options: {
        dryRun?: boolean;
        fetchResponses?: Map<string, { ok: boolean; data: unknown }>;
    } = {}
): { context: PostProcessorContext; fetchCalls: FetchCall[] } {
    const fetchCalls: FetchCall[] = [];
    const responses = options.fetchResponses || new Map();

    // Mock global fetch
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method || "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;

        fetchCalls.push({ url, method, body });

        // Find matching response
        for (const [pattern, response] of responses.entries()) {
            if (url.includes(pattern)) {
                return {
                    ok: response.ok,
                    status: response.ok ? 200 : 500,
                    json: async () => response.data,
                    text: async () => JSON.stringify(response.data),
                } as Response;
            }
        }

        // Default success response
        return {
            ok: true,
            status: 200,
            json: async () => ({ data: [] }),
            text: async () => "{}",
        } as Response;
    }) as unknown as typeof fetch;

    const context: PostProcessorContext = {
        salesChannelId: "sc-123",
        salesChannelName: "test-store",
        blueprint: {
            version: "1.0",
            salesChannel: { name: "test-store", description: "Test store" },
            categories: [],
            products: [],
            propertyGroups: [],
            createdAt: new Date().toISOString(),
            hydratedAt: new Date().toISOString(),
        },
        cache: createMockCache() as unknown as PostProcessorContext["cache"],
        shopwareUrl: "https://test.shopware.com",
        getAccessToken: async () => "test-token",
        options: {
            batchSize: 5,
            dryRun: options.dryRun || false,
        },
    };

    return { context, fetchCalls };
}

describe("CommerceProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(CommerceProcessor.name).toBe("cms-commerce");
        });

        test("has description", () => {
            expect(CommerceProcessor.description).toBeDefined();
            expect(CommerceProcessor.description.length).toBeGreaterThan(0);
        });

        test("has no dependencies", () => {
            expect(CommerceProcessor.dependsOn).toEqual([]);
        });

        test("has page fixture with correct name", () => {
            expect(CommerceProcessor.pageFixture.name).toBe("Commerce Elements");
        });
    });

    describe("process", () => {
        test("dry run logs without API calls", async () => {
            const { context, fetchCalls } = createMockContext({ dryRun: true });

            const result = await CommerceProcessor.process(context);

            expect(result.name).toBe("cms-commerce");
            expect(result.processed).toBe(1);
            expect(result.skipped).toBe(0);
            expect(result.errors).toEqual([]);
            expect(fetchCalls.length).toBe(0);
        });

        test("fetches products with media from SalesChannel", async () => {
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            // Product search response with media
            responses.set("search/product", {
                ok: true,
                data: {
                    data: [
                        {
                            id: "prod-1",
                            cover: { mediaId: "media-1" },
                            media: [{ mediaId: "media-2" }],
                        },
                        {
                            id: "prod-2",
                            cover: { mediaId: "media-3" },
                        },
                    ],
                },
            });
            responses.set("search/cms-page", { ok: true, data: { data: [] } });
            responses.set("search/landing-page", { ok: true, data: { data: [] } });
            responses.set("_action/sync", { ok: true, data: {} });

            const { context, fetchCalls } = createMockContext({ fetchResponses: responses });

            const result = await CommerceProcessor.process(context);

            expect(result.errors).toEqual([]);
            expect(result.processed).toBe(1);

            // Should have searched for products
            const productSearchCalls = fetchCalls.filter((c) => c.url.includes("search/product"));
            expect(productSearchCalls.length).toBeGreaterThan(0);
        });

        test("populates product IDs in fixture", async () => {
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            responses.set("search/product", {
                ok: true,
                data: {
                    data: [
                        { id: "prod-1", cover: { mediaId: "media-1" } },
                        { id: "prod-2", cover: { mediaId: "media-2" } },
                        { id: "prod-3", cover: { mediaId: "media-3" } },
                    ],
                },
            });
            responses.set("search/cms-page", { ok: true, data: { data: [] } });
            responses.set("search/landing-page", { ok: true, data: { data: [] } });
            responses.set("_action/sync", { ok: true, data: {} });

            const { context, fetchCalls } = createMockContext({ fetchResponses: responses });

            await CommerceProcessor.process(context);

            // Check that sync was called with CMS page containing product data
            const syncCalls = fetchCalls.filter((c) => c.url.includes("_action/sync"));
            expect(syncCalls.length).toBeGreaterThan(0);

            // The first sync should be for CMS page creation
            const cmsSync = syncCalls[0];
            expect(cmsSync).toBeDefined();
            if (cmsSync?.body) {
                const body = cmsSync.body as Record<string, unknown>;
                expect(Object.keys(body)).toContain("createCmsPage");
            }
        });

        test("handles empty products gracefully", async () => {
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            // No products found
            responses.set("search/product", { ok: true, data: { data: [] } });
            responses.set("search/cms-page", { ok: true, data: { data: [] } });
            responses.set("search/landing-page", { ok: true, data: { data: [] } });
            responses.set("_action/sync", { ok: true, data: {} });

            const { context } = createMockContext({ fetchResponses: responses });

            const result = await CommerceProcessor.process(context);

            // Should still succeed, just with empty products
            expect(result.processed).toBe(1);
            expect(result.errors).toEqual([]);
        });
    });
});
