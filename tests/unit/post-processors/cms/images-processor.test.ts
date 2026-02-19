import { describe, expect, mock, test } from "bun:test";

import type { PostProcessorContext } from "../../../../src/post-processors/index.js";

import { ImagesProcessor } from "../../../../src/post-processors/cms/images-processor.js";
import { MockImageProvider } from "../../../mocks/image-provider.mock.js";

const MOCK_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function createMockCache(options: { hasImages?: boolean } = {}) {
    const hasImages = options.hasImages ?? false;
    return {
        getSalesChannelDir: mock(() => "/tmp/test-cache"),
        loadProductMetadata: mock(() => null),
        loadCmsBlueprint: mock(() => null),
        images: {
            hasImageForSalesChannel: mock(() => hasImages),
            loadImageForSalesChannel: mock(() => (hasImages ? MOCK_BASE64 : null)),
            saveImageForSalesChannel: mock(() => {}),
        },
    };
}

interface FetchCall {
    url: string;
    method: string;
    body?: unknown;
}

function createMockContext(
    options: {
        dryRun?: boolean;
        fetchResponses?: Map<string, { ok: boolean; data: unknown }>;
        imageProvider?: MockImageProvider;
        hasImages?: boolean;
    } = {}
): { context: PostProcessorContext; fetchCalls: FetchCall[] } {
    const fetchCalls: FetchCall[] = [];
    const responses = options.fetchResponses || new Map();

    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method || "GET";
        let body: unknown;
        try {
            body = init?.body ? JSON.parse(init.body as string) : undefined;
        } catch {
            body = undefined;
        }

        fetchCalls.push({ url, method, body });

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
            salesChannel: { name: "test-store", description: "Test store for demo" },
            categories: [],
            products: [],
            propertyGroups: [],
            createdAt: new Date().toISOString(),
            hydratedAt: new Date().toISOString(),
        },
        cache: createMockCache({
            hasImages: options.hasImages,
        }) as unknown as PostProcessorContext["cache"],
        imageProvider: options.imageProvider ?? new MockImageProvider(),
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

        test("uploads pre-cached images for slider and gallery", async () => {
            const imageProvider = new MockImageProvider();
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            responses.set("search/media-default-folder", {
                ok: true,
                data: { data: [{ id: "df-1", folder: { id: "folder-cms" } }] },
            });
            responses.set("search/media", { ok: true, data: { data: [] } });
            responses.set("search/cms-page", { ok: true, data: { data: [] } });
            responses.set("search/landing-page", { ok: true, data: { data: [] } });
            responses.set("_action/sync", { ok: true, data: {} });
            responses.set("_action/media", { ok: true, data: {} });

            const { context } = createMockContext({
                fetchResponses: responses,
                imageProvider,
                hasImages: true,
            });

            const result = await ImagesProcessor.process(context);

            expect(result.errors).toEqual([]);
            expect(result.processed).toBe(1);
            // Images come from cache, not from the image provider
            expect(imageProvider.callCount).toBe(0);
            // Cache should have been read 11 times (5 slider + 6 gallery)
            const loadCalls = (
                context.cache.images.loadImageForSalesChannel as ReturnType<typeof mock>
            ).mock.calls;
            expect(loadCalls.length).toBe(11);
        });

        test("reads correct image keys from cache", async () => {
            const imageProvider = new MockImageProvider();
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            responses.set("search/media-default-folder", {
                ok: true,
                data: { data: [{ id: "df-1", folder: { id: "folder-cms" } }] },
            });
            responses.set("search/media", { ok: true, data: { data: [] } });
            responses.set("search/cms-page", { ok: true, data: { data: [] } });
            responses.set("search/landing-page", { ok: true, data: { data: [] } });
            responses.set("_action/sync", { ok: true, data: {} });
            responses.set("_action/media", { ok: true, data: {} });

            const { context } = createMockContext({
                fetchResponses: responses,
                imageProvider,
                hasImages: true,
            });

            await ImagesProcessor.process(context);

            const loadCalls = (
                context.cache.images.loadImageForSalesChannel as ReturnType<typeof mock>
            ).mock.calls;
            const loadedKeys = loadCalls.map((call: unknown[]) => call[1]);

            // 5 slider keys + 6 gallery keys
            for (let i = 0; i < 5; i++) {
                expect(loadedKeys).toContain(`img-slider-${i}`);
            }
            for (let i = 0; i < 6; i++) {
                expect(loadedKeys).toContain(`img-gallery-${i}`);
            }
        });

        test("handles no image provider gracefully", async () => {
            const responses = new Map<string, { ok: boolean; data: unknown }>();

            responses.set("search/media", { ok: true, data: { data: [] } });
            responses.set("search/cms-page", { ok: true, data: { data: [] } });
            responses.set("search/landing-page", { ok: true, data: { data: [] } });
            responses.set("_action/sync", { ok: true, data: {} });

            const { context } = createMockContext({ fetchResponses: responses });
            context.imageProvider = undefined;

            const result = await ImagesProcessor.process(context);

            expect(result.processed).toBe(1);
            expect(result.errors).toEqual([]);
        });
    });
});
