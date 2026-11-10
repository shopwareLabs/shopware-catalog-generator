import { describe, expect, mock, test } from "bun:test";

import type { CmsPageFixture, CmsSlotConfig } from "../../../../src/fixtures/index.js";
import type { PostProcessorContext } from "../../../../src/post-processors/index.js";
import type { MockApiHelpers } from "../../../mocks/index.js";

import { ImagesProcessor } from "../../../../src/post-processors/cms/images-processor.js";
import { createTestContext } from "../../../helpers/post-processor-context.js";
import { MockImageProvider } from "../../../mocks/image-provider.mock.js";
import { createMockApiHelpers } from "../../../mocks/index.js";

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

// =============================================================================
// Characterization tests (media population and page flow)
// =============================================================================

type PopulateImages = (fixture: CmsPageFixture, mediaIds: string[]) => CmsPageFixture;

const populateImageMediaIds: PopulateImages = (fixture, mediaIds) =>
    (ImagesProcessor as unknown as { populateMediaIds: PopulateImages }).populateMediaIds.call(
        ImagesProcessor,
        fixture,
        mediaIds
    );

function slot(type: string, config: CmsSlotConfig["config"]): CmsSlotConfig {
    return { type, slot: type, config };
}

const SLIDER_FIXTURE: CmsPageFixture = {
    name: "Image Elements",
    type: "landingpage",
    sections: [
        {
            type: "default",
            sizingMode: "boxed",
            mobileBehavior: "wrap",
            blocks: [
                {
                    type: "image-slider",
                    position: 0,
                    sectionPosition: "main",
                    slots: [
                        slot("image-slider", { sliderItems: { source: "static", value: [] } }),
                        slot("image-slider", {}),
                        slot("image", { media: { source: "static", value: "keep" } }),
                    ],
                },
            ],
        },
        {
            type: "default",
            sizingMode: "boxed",
            mobileBehavior: "wrap",
            blocks: [
                {
                    type: "image-gallery",
                    position: 0,
                    sectionPosition: "main",
                    slots: [
                        slot("image-gallery", { sliderItems: { source: "static", value: [] } }),
                        slot("image-gallery", {}),
                    ],
                },
            ],
        },
    ],
};

const ELEVEN_IDS = Array.from({ length: 11 }, (_, i) => `m${i}`);

function items(ids: string[]): Array<{ mediaId: string; url: null; newTab: boolean }> {
    return ids.map((mediaId) => ({ mediaId, url: null, newTab: false }));
}

function slotConfigs(fixture: CmsPageFixture): Array<CmsSlotConfig["config"]> {
    return fixture.sections.flatMap((s) => s.blocks.flatMap((b) => b.slots.map((x) => x.config)));
}

function withMedia(media: (key: string) => string | null): typeof ImagesProcessor {
    const processor = Object.create(ImagesProcessor) as typeof ImagesProcessor;
    Object.assign(processor, {
        getOrCreateCmsMedia: async (_context: PostProcessorContext, key: string) => media(key),
    });
    return processor;
}

function createdPage(mockApi: MockApiHelpers): CmsPageFixture | undefined {
    const body = mockApi
        .getCallsByEndpoint("_action/sync")
        .map((c) => c.body as Record<string, { payload: CmsPageFixture[] }>)
        .find((b) => b.createCmsPage);
    return body?.createCmsPage?.payload[0];
}

describe("ImagesProcessor (characterization)", () => {
    describe("populateMediaIds", () => {
        test("returns the fixture itself without media IDs", () => {
            expect(populateImageMediaIds(SLIDER_FIXTURE, [])).toBe(SLIDER_FIXTURE);
        });

        test("puts the first 5 IDs into sliders and the next 6 into galleries", () => {
            const result = populateImageMediaIds(SLIDER_FIXTURE, ELEVEN_IDS);

            expect(slotConfigs(result)).toEqual([
                { sliderItems: { source: "static", value: items(ELEVEN_IDS.slice(0, 5)) } },
                {},
                { media: { source: "static", value: "keep" } },
                { sliderItems: { source: "static", value: items(ELEVEN_IDS.slice(5, 11)) } },
                {},
            ]);
        });

        test("leaves the gallery empty when there are 5 IDs or fewer", () => {
            const result = populateImageMediaIds(SLIDER_FIXTURE, ["a", "b"]);

            const configs = slotConfigs(result);
            expect(configs[0]?.sliderItems?.value).toEqual(items(["a", "b"]));
            expect(configs[3]?.sliderItems?.value).toEqual([]);
        });

        test("does not change the input fixture", () => {
            populateImageMediaIds(SLIDER_FIXTURE, ELEVEN_IDS);

            expect(slotConfigs(SLIDER_FIXTURE)[0]?.sliderItems?.value).toEqual([]);
        });
    });

    describe("process", () => {
        test("requests slider then gallery images and uses the found ones", async () => {
            const keys: string[] = [];
            const processor = withMedia((key) => {
                keys.push(key);
                return key.endsWith("-1") ? null : `id-${key}`;
            });
            const { context, mockApi } = createTestContext();

            const result = await processor.process(context);

            expect(result).toEqual({
                name: "cms-images",
                processed: 1,
                skipped: 0,
                errors: [],
                durationMs: 0,
            });
            expect(keys).toEqual(CMS_IMAGE_KEYS);
            const configs = slotConfigs(createdPage(mockApi) as CmsPageFixture);
            const sliderItems = configs.flatMap((c) => c.sliderItems?.value ?? []);
            expect(sliderItems).toEqual(
                items([
                    "id-img-slider-0",
                    "id-img-slider-2",
                    "id-img-slider-3",
                    "id-img-slider-4",
                    "id-img-gallery-0",
                    "id-img-gallery-2",
                    "id-img-gallery-3",
                    "id-img-gallery-4",
                    "id-img-gallery-5",
                ])
            );
        });

        test("creates the page with empty image blocks when no image is cached", async () => {
            const { context, mockApi } = createTestContext();

            const result = await withMedia(() => null).process(context);

            expect(result.processed).toBe(1);
            const configs = slotConfigs(createdPage(mockApi) as CmsPageFixture);
            expect(configs.flatMap((c) => c.sliderItems?.value ?? [])).toEqual([]);
            expect(mockApi.getCallsByEndpoint("search/landing-page").length).toBe(1);
        });

        test("reuses an existing layout without creating it", async () => {
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/cms-page", { data: [{ id: "cms-existing" }] });
            const { context } = createTestContext({ mockApi });

            const result = await withMedia((key) => key).process(context);

            expect(result.errors).toEqual([]);
            expect(createdPage(mockApi)).toBeUndefined();
            const landingPage = mockApi
                .getCallsByEndpoint("_action/sync")
                .map((c) => c.body as Record<string, { payload: Array<{ cmsPageId: string }> }>)
                .find((b) => b.createLandingPage);
            expect(landingPage?.createLandingPage?.payload[0]?.cmsPageId).toBe("cms-existing");
        });

        test("fails the page when an image lookup throws", async () => {
            const { context, mockApi } = createTestContext();
            const processor = withMedia(() => {
                throw new Error("cache broken");
            });

            const result = await processor.process(context);

            expect(result.processed).toBe(0);
            expect(result.errors).toEqual(["CMS processing failed: cache broken"]);
            expect(mockApi.getCallsByEndpoint("search/cms-page").length).toBe(0);
        });

        test("dry run makes no image lookups", async () => {
            const keys: string[] = [];
            const { context } = createTestContext({ dryRun: true });

            const result = await withMedia((key) => {
                keys.push(key);
                return key;
            }).process(context);

            expect(result.processed).toBe(1);
            expect(keys).toEqual([]);
        });
    });
});
