import { describe, expect, mock, test } from "bun:test";

import type { PostProcessorContext } from "../../../../src/post-processors/index.js";

import { ImagesProcessor } from "../../../../src/post-processors/cms/images-processor.js";

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

describe("ImagesProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(ImagesProcessor.name).toBe("cms-images");
        });

        test("has description", () => {
            expect(ImagesProcessor.description).toBeDefined();
            expect(ImagesProcessor.description.length).toBeGreaterThan(0);
        });

        test("has no dependencies", () => {
            expect(ImagesProcessor.dependsOn).toEqual([]);
        });

        test("has page fixture with correct name", () => {
            expect(ImagesProcessor.pageFixture.name).toBe("Image Elements");
        });
    });

    describe("process", () => {
        test("dry run logs without API calls", async () => {
            const { context, fetchCalls } = createMockContext({ dryRun: true });

            const result = await ImagesProcessor.process(context);

            expect(result.name).toBe("cms-images");
            expect(result.processed).toBe(1);
            expect(result.skipped).toBe(0);
            expect(result.errors).toEqual([]);
            expect(fetchCalls.length).toBe(0);
        });

        test("fetches media from products", async () => {
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            // Product search response with media
            responses.set("search/product", {
                ok: true,
                data: {
                    data: [
                        {
                            id: "prod-1",
                            cover: { media: { id: "media-1" } },
                            media: [{ media: { id: "media-2" } }],
                        },
                    ],
                },
            });
            responses.set("search/cms-page", { ok: true, data: { data: [] } });
            responses.set("search/landing-page", { ok: true, data: { data: [] } });
            responses.set("_action/sync", { ok: true, data: {} });

            const { context, fetchCalls } = createMockContext({ fetchResponses: responses });

            const result = await ImagesProcessor.process(context);

            expect(result.errors).toEqual([]);
            expect(result.processed).toBe(1);

            // Should have searched for products
            const productSearchCalls = fetchCalls.filter((c) => c.url.includes("search/product"));
            expect(productSearchCalls.length).toBeGreaterThan(0);
        });

        test("falls back to media endpoint when few product media", async () => {
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            // Product search returns few media (< 5)
            responses.set("search/product", {
                ok: true,
                data: {
                    data: [{ id: "prod-1", cover: { media: { id: "media-1" } } }],
                },
            });
            // Media endpoint returns more
            responses.set("search/media", {
                ok: true,
                data: {
                    data: [
                        { id: "media-2" },
                        { id: "media-3" },
                        { id: "media-4" },
                        { id: "media-5" },
                    ],
                },
            });
            responses.set("search/cms-page", { ok: true, data: { data: [] } });
            responses.set("search/landing-page", { ok: true, data: { data: [] } });
            responses.set("_action/sync", { ok: true, data: {} });

            const { context, fetchCalls } = createMockContext({ fetchResponses: responses });

            await ImagesProcessor.process(context);

            // Should have searched both products and media
            const productSearchCalls = fetchCalls.filter((c) => c.url.includes("search/product"));
            const mediaSearchCalls = fetchCalls.filter((c) => c.url.includes("search/media"));

            expect(productSearchCalls.length).toBeGreaterThan(0);
            expect(mediaSearchCalls.length).toBeGreaterThan(0);
        });

        test("handles empty media gracefully", async () => {
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            // No media found
            responses.set("search/product", { ok: true, data: { data: [] } });
            responses.set("search/media", { ok: true, data: { data: [] } });
            responses.set("search/cms-page", { ok: true, data: { data: [] } });
            responses.set("search/landing-page", { ok: true, data: { data: [] } });
            responses.set("_action/sync", { ok: true, data: {} });

            const { context } = createMockContext({ fetchResponses: responses });

            const result = await ImagesProcessor.process(context);

            // Should still succeed
            expect(result.processed).toBe(1);
            expect(result.errors).toEqual([]);
        });
    });
});
