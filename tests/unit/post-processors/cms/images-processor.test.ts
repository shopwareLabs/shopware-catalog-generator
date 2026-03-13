import { describe, expect, mock, test } from "bun:test";

import type { PostProcessorContext } from "../../../../src/post-processors/index.js";

import { ImagesProcessor } from "../../../../src/post-processors/cms/images-processor.js";
import { createTestContext } from "../../../helpers/post-processor-context.js";
import { MockImageProvider } from "../../../mocks/image-provider.mock.js";

const CMS_IMAGE_KEYS = [
    ...Array.from({ length: 5 }, (_, i) => `img-slider-${i}`),
    ...Array.from({ length: 6 }, (_, i) => `img-gallery-${i}`),
];

interface FetchCall {
    url: string;
    method: string;
    body?: unknown;
}

function createContextWithFetch(
    options: {
        dryRun?: boolean;
        fetchResponses?: Map<string, { ok: boolean; data: unknown }>;
        imageProvider?: MockImageProvider;
        cachedImages?: Set<string>;
    } = {}
): {
    context: PostProcessorContext;
    fetchCalls: FetchCall[];
    mockCache: ReturnType<typeof createTestContext>["mockCache"];
} {
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

    const { context, mockCache } = createTestContext({
        dryRun: options.dryRun,
        imageProvider: options.imageProvider ?? new MockImageProvider(),
        cachedImages: options.cachedImages,
    });

    return { context, fetchCalls, mockCache };
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
            const { context, fetchCalls } = createContextWithFetch({ dryRun: true });

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

            const { context, mockCache } = createContextWithFetch({
                fetchResponses: responses,
                imageProvider,
                cachedImages: new Set(CMS_IMAGE_KEYS),
            });

            const result = await ImagesProcessor.process(context);

            expect(result.errors).toEqual([]);
            expect(result.processed).toBe(1);
            expect(imageProvider.callCount).toBe(0);
            expect(mockCache.images.loadImageForSalesChannelMock.mock.calls.length).toBe(11);
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

            const { context, mockCache } = createContextWithFetch({
                fetchResponses: responses,
                imageProvider,
                cachedImages: new Set(CMS_IMAGE_KEYS),
            });

            await ImagesProcessor.process(context);

            const loadCalls = mockCache.images.loadImageForSalesChannelMock.mock.calls;
            const loadedKeys = loadCalls.map((call: unknown[]) => call[1]);

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

            const { context } = createContextWithFetch({ fetchResponses: responses });
            context.imageProvider = undefined;

            const result = await ImagesProcessor.process(context);

            expect(result.processed).toBe(1);
            expect(result.errors).toEqual([]);
        });
    });
});
