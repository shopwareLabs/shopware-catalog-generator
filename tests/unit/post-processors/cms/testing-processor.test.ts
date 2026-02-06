import { describe, expect, mock, test } from "bun:test";

import type { PostProcessorContext } from "../../../../src/post-processors/index.js";

import { TestingProcessor } from "../../../../src/post-processors/cms/testing-processor.js";

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

describe("TestingProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(TestingProcessor.name).toBe("cms-testing");
        });

        test("has description", () => {
            expect(TestingProcessor.description).toBeDefined();
            expect(TestingProcessor.description.length).toBeGreaterThan(0);
        });

        test("depends on all CMS element processors and digital-product", () => {
            expect(TestingProcessor.dependsOn).toContain("cms-text");
            expect(TestingProcessor.dependsOn).toContain("cms-images");
            expect(TestingProcessor.dependsOn).toContain("cms-video");
            expect(TestingProcessor.dependsOn).toContain("cms-text-images");
            expect(TestingProcessor.dependsOn).toContain("cms-commerce");
            expect(TestingProcessor.dependsOn).toContain("cms-form");
            expect(TestingProcessor.dependsOn).toContain("digital-product");
            expect(TestingProcessor.dependsOn.length).toBe(7);
        });

        test("has page fixture with correct name", () => {
            expect(TestingProcessor.pageFixture.name).toBe("Testing Overview");
        });
    });

    describe("process", () => {
        test("dry run logs without API calls", async () => {
            const { context, fetchCalls } = createMockContext({ dryRun: true });

            const result = await TestingProcessor.process(context);

            expect(result.name).toBe("cms-testing");
            expect(result.processed).toBe(1);
            expect(result.skipped).toBe(0);
            expect(result.errors).toEqual([]);
            expect(fetchCalls.length).toBe(0);
        });

        test("fetches root category from SalesChannel", async () => {
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            // Sales channel with navigation category
            responses.set("search/sales-channel", {
                ok: true,
                data: {
                    data: [{ id: "sc-123", navigationCategoryId: "root-cat-id" }],
                },
            });
            // Products for slider
            responses.set("search/product", { ok: true, data: { data: [] } });
            responses.set("search/cms-page", { ok: true, data: { data: [] } });
            responses.set("search/landing-page", { ok: true, data: { data: [] } });
            responses.set("search/category", { ok: true, data: { data: [] } });
            responses.set("_action/sync", { ok: true, data: {} });

            const { context, fetchCalls } = createMockContext({ fetchResponses: responses });

            await TestingProcessor.process(context);

            // Should have searched for sales channel to get root category
            const scSearchCalls = fetchCalls.filter((c) => c.url.includes("search/sales-channel"));
            expect(scSearchCalls.length).toBeGreaterThan(0);
        });

        test("fails gracefully when no root category", async () => {
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            // Sales channel without navigation category
            responses.set("search/sales-channel", {
                ok: true,
                data: { data: [{ id: "sc-123" }] },
            });

            const { context } = createMockContext({ fetchResponses: responses });

            const result = await TestingProcessor.process(context);

            expect(result.processed).toBe(0);
            expect(result.errors).toContain("Could not find root category for navigation");
        });

        test("creates Testing category hierarchy", async () => {
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            responses.set("search/sales-channel", {
                ok: true,
                data: { data: [{ id: "sc-123", navigationCategoryId: "root-cat-id" }] },
            });
            responses.set("search/product", { ok: true, data: { data: [] } });
            responses.set("search/cms-page", { ok: true, data: { data: [] } });
            responses.set("search/landing-page", { ok: true, data: { data: [] } });
            responses.set("search/category", { ok: true, data: { data: [] } });
            responses.set("_action/sync", { ok: true, data: {} });

            const { context, fetchCalls } = createMockContext({ fetchResponses: responses });

            await TestingProcessor.process(context);

            // Should have synced multiple times (CMS, landing page, categories)
            const syncCalls = fetchCalls.filter((c) => c.url.includes("_action/sync"));
            expect(syncCalls.length).toBeGreaterThan(0);

            // Should have created categories
            const categorySyncs = syncCalls.filter((c) => {
                const body = c.body as Record<string, unknown> | undefined;
                return body && Object.keys(body).some((k) => k.includes("Category"));
            });
            expect(categorySyncs.length).toBeGreaterThan(0);
        });
    });

    describe("cleanup", () => {
        test("dry run logs without deletions", async () => {
            const { context, fetchCalls } = createMockContext({ dryRun: true });

            const result = await TestingProcessor.cleanup(context);

            expect(result.name).toBe("cms-testing");
            expect(result.deleted).toBe(0);
            expect(result.errors).toEqual([]);
            expect(fetchCalls.length).toBe(0);
        });

        test("deletes categories in reverse order", async () => {
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            responses.set("search/sales-channel", {
                ok: true,
                data: { data: [{ id: "sc-123", navigationCategoryId: "root-cat-id" }] },
            });
            // Testing category exists
            responses.set("search/category", {
                ok: true,
                data: { data: [{ id: "testing-cat-id" }] },
            });
            responses.set("search/landing-page", { ok: true, data: { data: [] } });

            const { context, fetchCalls } = createMockContext({ fetchResponses: responses });

            await TestingProcessor.cleanup(context);

            // Should have made delete calls for categories
            const deleteCalls = fetchCalls.filter((c) => c.method === "DELETE");
            expect(deleteCalls.length).toBeGreaterThan(0);
        });
    });
});
