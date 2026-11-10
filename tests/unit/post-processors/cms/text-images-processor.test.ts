import { describe, expect, mock, spyOn, test } from "bun:test";

import type {
    CmsBlockConfig,
    CmsPageFixture,
    CmsSlotConfig,
} from "../../../../src/fixtures/index.js";
import type { PostProcessorContext } from "../../../../src/post-processors/index.js";

import { TextImagesProcessor } from "../../../../src/post-processors/cms/text-images-processor.js";
import { logger } from "../../../../src/utils/index.js";
import { createTestBlueprint } from "../../../helpers/blueprint-factory.js";
import { createTestContext } from "../../../helpers/post-processor-context.js";
import { createMockApiHelpers } from "../../../mocks/index.js";

const TEXT_IMAGES_KEYS = [
    "ti-left",
    "ti-right",
    "ct-left",
    "ct-right",
    "bubble-left",
    "bubble-center",
    "bubble-right",
    "toi-bg",
];

function createContext(): {
    context: PostProcessorContext;
    mockCache: ReturnType<typeof createTestContext>["mockCache"];
} {
    const fetchResponses = new Map<string, { ok: boolean; data: unknown }>();
    fetchResponses.set("search/media-default-folder", {
        ok: true,
        data: { data: [{ id: "df-1", folder: { id: "folder-cms" } }] },
    });
    fetchResponses.set("search/media-folder", { ok: true, data: { data: [{ id: "folder-cms" }] } });
    fetchResponses.set("search/media", { ok: true, data: { data: [] } });
    fetchResponses.set("search/cms-page", { ok: true, data: { data: [] } });
    fetchResponses.set("search/landing-page", { ok: true, data: { data: [] } });
    fetchResponses.set("_action/sync", { ok: true, data: { success: true } });
    fetchResponses.set("_action/media/", { ok: true, data: {} });

    globalThis.fetch = mock(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        for (const [pattern, response] of fetchResponses.entries()) {
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
        salesChannelId: "sc-1",
        salesChannelName: "music",
        blueprint: createTestBlueprint({
            salesChannel: { name: "music", description: "Music store" },
        }),
        cachedImages: new Set(TEXT_IMAGES_KEYS),
    });

    return { context, mockCache };
}

describe("TextImagesProcessor", () => {
    test("process uploads cms images and creates page/landing page", async () => {
        const { context, mockCache } = createContext();

        const result = await TextImagesProcessor.process(context);
        expect(result.errors).toEqual([]);
        expect(result.processed).toBe(1);

        expect(mockCache.images.loadImageForSalesChannelMock.mock.calls.length).toBe(8);
    });

    test("populateMediaIds maps media ids into expected slots", () => {
        const fixture = TextImagesProcessor.pageFixture;
        const mapped = (
            TextImagesProcessor as unknown as { populateMediaIds: Function }
        ).populateMediaIds(fixture, {
            "ti-left": "m1",
            "ti-right": "m2",
            "ct-left": "m3",
            "ct-right": "m4",
            "bubble-left": "m5",
            "bubble-center": "m6",
            "bubble-right": "m7",
            "toi-bg": "m8",
        }) as typeof fixture;

        const blocks = mapped.sections[0]?.blocks ?? [];
        expect(
            blocks.find((b) => b.position === 1)?.slots.find((s) => s.slot === "left")?.config.media
                ?.value
        ).toBe("m1");
        expect(
            blocks.find((b) => b.position === 2)?.slots.find((s) => s.slot === "right")?.config
                .media?.value
        ).toBe("m2");
        expect(
            blocks.find((b) => b.position === 3)?.slots.find((s) => s.slot === "left")?.config.media
                ?.value
        ).toBe("m3");
        expect(
            blocks.find((b) => b.position === 3)?.slots.find((s) => s.slot === "right")?.config
                .media?.value
        ).toBe("m4");
        expect(
            blocks.find((b) => b.position === 4)?.slots.find((s) => s.slot === "left-image")?.config
                .media?.value
        ).toBe("m5");
        expect(
            blocks.find((b) => b.position === 4)?.slots.find((s) => s.slot === "center-image")
                ?.config.media?.value
        ).toBe("m6");
        expect(
            blocks.find((b) => b.position === 4)?.slots.find((s) => s.slot === "right-image")
                ?.config.media?.value
        ).toBe("m7");
        expect(blocks.find((b) => b.type === "text-on-image")?.backgroundMediaId).toBe("m8");
    });
});

// =============================================================================
// Characterization tests (media assignment and page flow)
// =============================================================================

type PopulateTextImages = (
    fixture: CmsPageFixture,
    imageMap: Record<string, string | null>
) => CmsPageFixture;

const populateTextImageMediaIds: PopulateTextImages = (fixture, imageMap) =>
    (
        TextImagesProcessor as unknown as { populateMediaIds: PopulateTextImages }
    ).populateMediaIds.call(TextImagesProcessor, fixture, imageMap);

function imageSlot(name: string, withMedia = true): CmsSlotConfig {
    return {
        type: "image",
        slot: name,
        config: withMedia ? { media: { source: "static", value: null } } : {},
    };
}

function block(type: string, position: number, slots: CmsSlotConfig[]): CmsBlockConfig {
    return { type, position, sectionPosition: "main", slots };
}

const ASSIGN_FIXTURE: CmsPageFixture = {
    name: "Text & Images",
    type: "landingpage",
    sections: [
        {
            type: "default",
            sizingMode: "boxed",
            mobileBehavior: "wrap",
            blocks: [
                block("image-text", 0, [imageSlot("left")]),
                block("image-text", 1, [
                    imageSlot("left"),
                    imageSlot("right"),
                    { type: "text", slot: "left", config: {} },
                ]),
                block("image-text", 2, [imageSlot("right"), imageSlot("left")]),
            ],
        },
        {
            type: "default",
            sizingMode: "boxed",
            mobileBehavior: "wrap",
            blocks: [
                block("center-text", 3, [imageSlot("left"), imageSlot("right", false)]),
                block("image-text-bubble", 4, [
                    imageSlot("left-image"),
                    imageSlot("center-image"),
                    imageSlot("right-image"),
                ]),
                block("text-on-image", 5, [imageSlot("left")]),
            ],
        },
    ],
};

const FULL_MAP: Record<string, string | null> = {
    "ti-left": "m1",
    "ti-right": "m2",
    "ct-left": "m3",
    "ct-right": "m4",
    "bubble-left": "m5",
    "bubble-center": "m6",
    "bubble-right": "m7",
    "toi-bg": "m8",
};

function mediaValues(fixture: CmsPageFixture): unknown[][] {
    return fixture.sections.flatMap((s) =>
        s.blocks.map((b) => b.slots.map((x) => (x.config.media ? x.config.media.value : "-")))
    );
}

function backgrounds(fixture: CmsPageFixture): Array<string | undefined> {
    return fixture.sections.flatMap((s) => s.blocks.map((b) => b.backgroundMediaId));
}

function withMedia(media: (key: string) => string | null): typeof TextImagesProcessor {
    const processor = Object.create(TextImagesProcessor) as typeof TextImagesProcessor;
    Object.assign(processor, {
        getOrCreateCmsMedia: async (_context: PostProcessorContext, key: string) => media(key),
    });
    return processor;
}

describe("TextImagesProcessor (characterization)", () => {
    describe("populateMediaIds", () => {
        test("assigns images by block position and slot name", () => {
            const result = populateTextImageMediaIds(ASSIGN_FIXTURE, FULL_MAP);

            expect(mediaValues(result)).toEqual([
                [null],
                ["m1", null, "-"],
                ["m2", null],
                ["m3", "-"],
                ["m5", "m6", "m7"],
                [null],
            ]);
            expect(backgrounds(result)).toEqual([
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                "m8",
            ]);
        });

        test("keeps slots and background when images are missing", () => {
            const result = populateTextImageMediaIds(ASSIGN_FIXTURE, {
                "ti-left": null,
                "bubble-center": "m6",
            });

            expect(mediaValues(result)).toEqual([
                [null],
                [null, null, "-"],
                [null, null],
                [null, "-"],
                [null, "m6", null],
                [null],
            ]);
            expect(backgrounds(result).every((id) => id === undefined)).toBe(true);
        });

        test("returns a copy and leaves the input fixture unchanged", () => {
            const result = populateTextImageMediaIds(ASSIGN_FIXTURE, FULL_MAP);

            expect(result).not.toBe(ASSIGN_FIXTURE);
            expect(mediaValues(ASSIGN_FIXTURE)[1]).toEqual([null, null, "-"]);
            expect(backgrounds(ASSIGN_FIXTURE)[5]).toBeUndefined();
        });
    });

    describe("process", () => {
        test("requests every image key once, in order", async () => {
            const keys: string[] = [];
            const { context } = createTestContext();

            const result = await withMedia((key) => {
                keys.push(key);
                return key;
            }).process(context);

            expect(result).toEqual({
                name: "cms-text-images",
                processed: 1,
                skipped: 0,
                errors: [],
                durationMs: 0,
            });
            expect(keys).toEqual(TEXT_IMAGES_KEYS);
        });

        test("logs the number of found images for a new layout", async () => {
            const info = spyOn(logger, "info");
            const { context } = createTestContext();

            await withMedia((key) => (key.startsWith("bubble") ? null : key)).process(context);

            const messages = info.mock.calls.map((call) => call[0]);
            info.mockRestore();
            expect(messages).toContain('    ✓ Created CMS layout "Text & Images" with 5 images');
        });

        test("logs a reused layout as already existing", async () => {
            const info = spyOn(logger, "info");
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/cms-page", { data: [{ id: "cms-existing" }] });
            const { context } = createTestContext({ mockApi });

            await withMedia((key) => key).process(context);

            const messages = info.mock.calls.map((call) => call[0]);
            info.mockRestore();
            expect(messages).toContain('    ⊘ CMS layout "Text & Images" already exists');
        });

        test("fails the page when an image lookup throws", async () => {
            const { context } = createTestContext();

            const result = await withMedia(() => {
                throw "no cache";
            }).process(context);

            expect(result.processed).toBe(0);
            expect(result.errors).toEqual(["CMS processing failed: no cache"]);
        });

        test("dry run logs the fixture name and makes no lookups", async () => {
            const info = spyOn(logger, "info");
            const keys: string[] = [];
            const { context } = createTestContext({ dryRun: true });

            const result = await withMedia((key) => {
                keys.push(key);
                return key;
            }).process(context);

            const messages = info.mock.calls.map((call) => call[0]);
            info.mockRestore();
            expect(result.processed).toBe(1);
            expect(keys).toEqual([]);
            expect(messages).toEqual([
                '    [DRY RUN] Would create CMS layout "Text & Images"',
                '    [DRY RUN] Would create Landing Page "Text & Images"',
            ]);
        });
    });
});
