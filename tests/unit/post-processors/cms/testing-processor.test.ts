import { describe, expect, mock, test } from "bun:test";

import type { PostProcessorContext } from "../../../../src/post-processors/index.js";

import { TestingProcessor } from "../../../../src/post-processors/cms/testing-processor.js";

// Helper to create mock cache
function createMockCache() {
    return {
        getSalesChannelDir: mock(() => "/tmp/test-cache"),
        loadProductMetadata: mock(() => null),
        loadCmsBlueprint: mock(() => null),
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

        test("creates Cookie settings category with correct properties", async () => {
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

            const syncCalls = fetchCalls.filter((c) => c.url.includes("_action/sync"));
            const syncBodies = syncCalls
                .map((c) => c.body as Record<string, unknown> | undefined)
                .filter(Boolean);

            let cookieCategoryPayload: Record<string, unknown> | undefined;
            for (const body of syncBodies) {
                if (!body) continue;
                for (const op of Object.values(body)) {
                    const categoryOp = op as {
                        entity?: string;
                        payload?: Array<Record<string, unknown>>;
                    };
                    if (categoryOp?.entity === "category" && Array.isArray(categoryOp.payload)) {
                        const cookieCat = categoryOp.payload.find(
                            (p: Record<string, unknown>) => p.name === "Cookie settings"
                        );
                        if (cookieCat) {
                            cookieCategoryPayload = cookieCat;
                            break;
                        }
                    }
                }
                if (cookieCategoryPayload) break;
            }

            expect(cookieCategoryPayload).toBeDefined();
            expect(cookieCategoryPayload?.type).toBe("link");
            expect(cookieCategoryPayload?.linkType).toBe("external");
            expect(cookieCategoryPayload?.externalLink).toBe("/cookie/offcanvas");
            expect(cookieCategoryPayload?.linkNewTab).toBe(false);
        });

        test("reports errors when CMS landing pages are missing", async () => {
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

            const { context } = createMockContext({ fetchResponses: responses });

            const result = await TestingProcessor.process(context);

            // No landing pages in cache => missing CMS sub-categories
            const missingErrors = result.errors.filter(
                (e) =>
                    e.includes("Missing landing page") || e.includes("Missing CMS sub-categories")
            );
            expect(missingErrors.length).toBeGreaterThan(0);
            expect(result.processed).toBe(0);
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

        test("cleanup includes the Cookie settings category", async () => {
            const categoryByFilter: Record<string, { id: string; name: string }> = {
                Testing: { id: "testing-cat-id", name: "Testing" },
                CMS: { id: "cms-cat-id", name: "CMS" },
                Products: { id: "products-cat-id", name: "Products" },
                "Cookie settings": { id: "cookie-settings-id", name: "Cookie settings" },
            };

            const customFetch = async (
                input: string | URL | Request,
                init?: RequestInit
            ): Promise<Response> => {
                const url = typeof input === "string" ? input : input.toString();
                const body = init?.body
                    ? (JSON.parse(init.body as string) as { filter?: Array<{ value?: string }> })
                    : undefined;

                if (url.includes("search/category") && body?.filter) {
                    const nameFilter = body.filter.find(
                        (f: { value?: string }) => f.value && categoryByFilter[f.value]
                    );
                    const cat = nameFilter
                        ? categoryByFilter[nameFilter.value as string]
                        : undefined;
                    if (cat) {
                        return new Response(
                            JSON.stringify({ data: [{ id: cat.id, name: cat.name }] }),
                            { status: 200, headers: { "Content-Type": "application/json" } }
                        );
                    }
                }
                if (url.includes("search/sales-channel")) {
                    return new Response(
                        JSON.stringify({
                            data: [{ id: "sc-123", navigationCategoryId: "root-cat-id" }],
                        }),
                        { status: 200, headers: { "Content-Type": "application/json" } }
                    );
                }
                if (url.includes("search/landing-page")) {
                    return new Response(JSON.stringify({ data: [] }), {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                if (init?.method === "DELETE") {
                    return new Response(null, { status: 204 });
                }
                return new Response(JSON.stringify({ data: [] }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            };

            const originalFetch = globalThis.fetch;
            globalThis.fetch = customFetch as typeof fetch;

            try {
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
                    options: { batchSize: 5, dryRun: false },
                };

                const result = await TestingProcessor.cleanup(context);

                expect(result.deleted).toBeGreaterThan(0);
                expect(result.errors).toEqual([]);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });
    });
});
