import { describe, expect, mock, test } from "bun:test";

import type { CmsPageFixture } from "../../../../src/fixtures/index.js";
import { BaseCmsProcessor } from "../../../../src/post-processors/cms/base-processor.js";
import type { PostProcessorContext } from "../../../../src/post-processors/index.js";

// Concrete implementation for testing the abstract base class
class TestCmsProcessor extends BaseCmsProcessor {
    readonly name = "test-cms";
    readonly description = "Test CMS processor";
    readonly pageFixture: CmsPageFixture = {
        name: "Test Page",
        type: "landingpage",
        sections: [
            {
                type: "default",
                sizingMode: "boxed",
                mobileBehavior: "wrap",
                blocks: [
                    {
                        type: "text",
                        position: 0,
                        sectionPosition: "main",
                        slots: [
                            {
                                type: "text",
                                slot: "content",
                                config: {
                                    content: { source: "static", value: "Test content" },
                                },
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

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
    const originalFetch = globalThis.fetch;
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

    // Cleanup function to restore fetch
    const cleanup = () => {
        globalThis.fetch = originalFetch;
    };

    // Return context and cleanup
    return { context: { ...context, _cleanup: cleanup } as PostProcessorContext, fetchCalls };
}

describe("BaseCmsProcessor", () => {
    describe("metadata", () => {
        test("abstract properties are defined", () => {
            const processor = new TestCmsProcessor();
            expect(processor.name).toBe("test-cms");
            expect(processor.description).toBe("Test CMS processor");
            expect(processor.pageFixture.name).toBe("Test Page");
            expect(processor.dependsOn).toEqual([]);
        });
    });

    describe("process", () => {
        test("dry run logs without API calls", async () => {
            const processor = new TestCmsProcessor();
            const { context, fetchCalls } = createMockContext({ dryRun: true });

            const result = await processor.process(context);

            expect(result.name).toBe("test-cms");
            expect(result.processed).toBe(1);
            expect(result.skipped).toBe(0);
            expect(result.errors).toEqual([]);
            expect(fetchCalls.length).toBe(0);
        });

        test("creates CMS page when not exists", async () => {
            const processor = new TestCmsProcessor();
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            // CMS page search returns empty
            responses.set("search/cms-page", { ok: true, data: { data: [] } });
            // Landing page search returns empty
            responses.set("search/landing-page", { ok: true, data: { data: [] } });
            // Sync succeeds
            responses.set("_action/sync", { ok: true, data: {} });

            const { context, fetchCalls } = createMockContext({ fetchResponses: responses });

            const result = await processor.process(context);

            expect(result.errors).toEqual([]);
            expect(result.processed).toBe(1);

            // Should have called sync for CMS page creation
            const syncCalls = fetchCalls.filter((c) => c.url.includes("_action/sync"));
            expect(syncCalls.length).toBeGreaterThan(0);
        });

        test("skips CMS page creation when exists", async () => {
            const processor = new TestCmsProcessor();
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            // CMS page already exists
            responses.set("search/cms-page", {
                ok: true,
                data: { data: [{ id: "existing-cms-page-id" }] },
            });
            // Landing page search returns empty
            responses.set("search/landing-page", { ok: true, data: { data: [] } });
            // Sync succeeds
            responses.set("_action/sync", { ok: true, data: {} });

            const { context, fetchCalls } = createMockContext({ fetchResponses: responses });

            const result = await processor.process(context);

            expect(result.errors).toEqual([]);
            expect(result.processed).toBe(1);

            // First sync should be for landing page, not CMS page
            const syncCalls = fetchCalls.filter((c) => c.url.includes("_action/sync"));
            expect(syncCalls.length).toBe(1);
        });

        test("creates landing page when not exists", async () => {
            const processor = new TestCmsProcessor();
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            responses.set("search/cms-page", {
                ok: true,
                data: { data: [{ id: "cms-page-id" }] },
            });
            responses.set("search/landing-page", { ok: true, data: { data: [] } });
            responses.set("_action/sync", { ok: true, data: {} });

            const { context, fetchCalls } = createMockContext({ fetchResponses: responses });

            const result = await processor.process(context);

            expect(result.errors).toEqual([]);
            expect(result.processed).toBe(1);

            // Should have created landing page via sync
            const syncCalls = fetchCalls.filter((c) => c.url.includes("_action/sync"));
            expect(syncCalls.length).toBe(1);

            const syncBody = syncCalls[0]?.body as Record<string, unknown>;
            expect(syncBody).toBeDefined();
            expect(Object.keys(syncBody)).toContain("createLandingPage");
        });
    });

    describe("ensureSalesChannelAssociated", () => {
        test("returns early when no landing page data", async () => {
            const processor = new TestCmsProcessor();
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            // Search returns empty (no landing page data)
            responses.set("search/landing-page", { ok: true, data: { data: [] } });

            const { context, fetchCalls } = createMockContext({ fetchResponses: responses });
            const errors: string[] = [];

            // Access protected method via type assertion
            await (
                processor as unknown as {
                    ensureSalesChannelAssociated: (
                        context: PostProcessorContext,
                        landingPageId: string,
                        pageName: string,
                        errors: string[]
                    ) => Promise<void>;
                }
            ).ensureSalesChannelAssociated(context, "lp-123", "Test Page", errors);

            expect(errors).toEqual([]);
            // Should only have searched, not synced
            const syncCalls = fetchCalls.filter((c) => c.url.includes("_action/sync"));
            expect(syncCalls.length).toBe(0);
        });

        test("returns early when already associated", async () => {
            const processor = new TestCmsProcessor();
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            // Landing page already has this sales channel
            responses.set("search/landing-page", {
                ok: true,
                data: {
                    data: [
                        {
                            id: "lp-123",
                            relationships: {
                                salesChannels: {
                                    data: [{ id: "sc-123" }],
                                },
                            },
                        },
                    ],
                },
            });

            const { context, fetchCalls } = createMockContext({ fetchResponses: responses });
            const errors: string[] = [];

            await (
                processor as unknown as {
                    ensureSalesChannelAssociated: (
                        context: PostProcessorContext,
                        landingPageId: string,
                        pageName: string,
                        errors: string[]
                    ) => Promise<void>;
                }
            ).ensureSalesChannelAssociated(context, "lp-123", "Test Page", errors);

            expect(errors).toEqual([]);
            // Should not have synced anything
            const syncCalls = fetchCalls.filter((c) => c.url.includes("_action/sync"));
            expect(syncCalls.length).toBe(0);
        });

        test("adds association when not present", async () => {
            const processor = new TestCmsProcessor();
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            // Landing page exists but has different sales channel
            responses.set("search/landing-page", {
                ok: true,
                data: {
                    data: [
                        {
                            id: "lp-123",
                            relationships: {
                                salesChannels: {
                                    data: [{ id: "other-sc" }],
                                },
                            },
                        },
                    ],
                },
            });
            responses.set("_action/sync", { ok: true, data: {} });

            const { context, fetchCalls } = createMockContext({ fetchResponses: responses });
            const errors: string[] = [];

            await (
                processor as unknown as {
                    ensureSalesChannelAssociated: (
                        context: PostProcessorContext,
                        landingPageId: string,
                        pageName: string,
                        errors: string[]
                    ) => Promise<void>;
                }
            ).ensureSalesChannelAssociated(context, "lp-123", "Test Page", errors);

            expect(errors).toEqual([]);
            // Should have synced to add association
            const syncCalls = fetchCalls.filter((c) => c.url.includes("_action/sync"));
            expect(syncCalls.length).toBe(1);
        });

        test("records error on failure", async () => {
            const processor = new TestCmsProcessor();
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            // Landing page exists but has different sales channel
            responses.set("search/landing-page", {
                ok: true,
                data: {
                    data: [
                        {
                            id: "lp-123",
                            relationships: {
                                salesChannels: {
                                    data: [{ id: "other-sc" }],
                                },
                            },
                        },
                    ],
                },
            });
            // Sync fails
            responses.set("_action/sync", { ok: false, data: { error: "Failed" } });

            const { context } = createMockContext({ fetchResponses: responses });
            const errors: string[] = [];

            await (
                processor as unknown as {
                    ensureSalesChannelAssociated: (
                        context: PostProcessorContext,
                        landingPageId: string,
                        pageName: string,
                        errors: string[]
                    ) => Promise<void>;
                }
            ).ensureSalesChannelAssociated(context, "lp-123", "Test Page", errors);

            expect(errors).toContain("Failed to add SalesChannel to existing Landing Page");
        });
    });

    describe("cleanup", () => {
        test("dry run logs without deletions", async () => {
            const processor = new TestCmsProcessor();
            const { context, fetchCalls } = createMockContext({ dryRun: true });

            const result = await processor.cleanup(context);

            expect(result.name).toBe("test-cms");
            expect(result.deleted).toBe(0);
            expect(result.errors).toEqual([]);
            expect(fetchCalls.length).toBe(0);
        });

        test("skips when landing page not found", async () => {
            const processor = new TestCmsProcessor();
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            responses.set("search/landing-page", { ok: true, data: { data: [] } });

            const { context, fetchCalls } = createMockContext({ fetchResponses: responses });

            const result = await processor.cleanup(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toEqual([]);
            // Should only search, not delete
            const deleteCalls = fetchCalls.filter((c) => c.method === "DELETE");
            expect(deleteCalls.length).toBe(0);
        });
    });
});
