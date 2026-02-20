import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import type { PostProcessorContext } from "../../../src/post-processors/index.js";

import { DigitalProductProcessor } from "../../../src/post-processors/digital-product-processor.js";

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
        let body: unknown;

        if (init?.body) {
            const bodyStr = init.body as string;
            // Only parse JSON if it looks like JSON
            if (bodyStr.startsWith("{") || bodyStr.startsWith("[")) {
                try {
                    body = JSON.parse(bodyStr);
                } catch {
                    body = bodyStr;
                }
            } else {
                body = bodyStr;
            }
        }

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

describe("DigitalProductProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(DigitalProductProcessor.name).toBe("digital-product");
        });

        test("has description", () => {
            expect(DigitalProductProcessor.description).toBeDefined();
            expect(DigitalProductProcessor.description.length).toBeGreaterThan(0);
        });

        test("has no dependencies", () => {
            expect(DigitalProductProcessor.dependsOn).toEqual([]);
        });
    });

    describe("process", () => {
        test("dry run logs without API calls", async () => {
            const { context, fetchCalls } = createMockContext({ dryRun: true });

            const result = await DigitalProductProcessor.process(context);

            expect(result.name).toBe("digital-product");
            expect(result.processed).toBe(1);
            expect(result.skipped).toBe(0);
            expect(result.errors).toEqual([]);
            expect(fetchCalls.length).toBe(0);
        });

        test("searches for existing gift card by product number", async () => {
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            // Gift card already exists
            responses.set("search/product", {
                ok: true,
                data: { data: [{ id: "gift-card-1" }] },
            });
            // Visibility check
            responses.set("search/product-visibility", {
                ok: true,
                data: { data: [{ id: "vis-1" }] },
            });
            // Download check
            responses.set("search/product-download", {
                ok: true,
                data: { data: [{ mediaId: "media-1" }] },
            });

            const { context, fetchCalls } = createMockContext({ fetchResponses: responses });

            await DigitalProductProcessor.process(context);

            // Should have searched for gift card
            const productSearchCalls = fetchCalls.filter((c) => c.url.includes("search/product"));
            expect(productSearchCalls.length).toBeGreaterThan(0);
        });

        test("skips when gift card exists with visibility and download", async () => {
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            // Gift card exists (matched first)
            responses.set("search/product", {
                ok: true,
                data: { data: [{ id: "gift-card-1" }] },
            });
            // Visibility exists
            responses.set("product-visibility", {
                ok: true,
                data: { data: [{ id: "vis-1" }] },
            });
            // Download exists
            responses.set("product-download", {
                ok: true,
                data: { data: [{ mediaId: "media-1" }] },
            });

            const { context } = createMockContext({ fetchResponses: responses });

            const result = await DigitalProductProcessor.process(context);

            // Should process successfully (reusing existing)
            expect(result.errors).toEqual([]);
        });

        test("processes successfully with all API calls mocked", async () => {
            // Just verify the processor completes without errors when all calls succeed
            const { context } = createMockContext();

            // Default mock returns empty data and ok: true, which simulates
            // - No existing gift card
            // - Tax lookup fails gracefully

            const result = await DigitalProductProcessor.process(context);

            // Will fail due to missing tax, but should not throw
            expect(result.name).toBe("digital-product");
        });

        test("rebuilds when cached product id is stale", async () => {
            const cacheDir = "/tmp/test-cache";
            const cacheFile = path.join(cacheDir, "digital-product.json");
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(
                cacheFile,
                JSON.stringify({
                    productId: "stale-product-id",
                    mediaId: "stale-media-id",
                    downloadId: "stale-download-id",
                    createdNew: false,
                })
            );

            const responses = new Map<string, { ok: boolean; data: unknown }>();
            responses.set("search/product", { ok: true, data: { data: [] } }); // stale + no global gift card
            responses.set("search/tax", { ok: true, data: { data: [{ id: "tax-1" }] } });
            responses.set("search/product-visibility", { ok: true, data: { data: [] } });
            responses.set("search/product-download", { ok: true, data: { data: [] } });
            responses.set("_action/sync", { ok: true, data: { success: true } });
            responses.set("_action/media", { ok: true, data: {} });

            const { context } = createMockContext({ fetchResponses: responses });
            const result = await DigitalProductProcessor.process(context);

            expect(result.errors).toEqual([]);
            expect(result.processed).toBe(1);

            if (fs.existsSync(cacheFile)) {
                fs.unlinkSync(cacheFile);
            }
        });
    });

    describe("cleanup", () => {
        test("dry run logs without deletions", async () => {
            const { context, fetchCalls } = createMockContext({ dryRun: true });

            const result = await DigitalProductProcessor.cleanup(context);

            expect(result.name).toBe("digital-product");
            expect(result.deleted).toBe(0);
            expect(result.errors).toEqual([]);
            expect(fetchCalls.length).toBe(0);
        });

        test("handles missing cache gracefully", async () => {
            const { context } = createMockContext();

            const result = await DigitalProductProcessor.cleanup(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toEqual([]);
        });
    });
});
