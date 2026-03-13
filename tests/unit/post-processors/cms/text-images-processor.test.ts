import { describe, expect, mock, test } from "bun:test";

import type { PostProcessorContext } from "../../../../src/post-processors/index.js";

import { TextImagesProcessor } from "../../../../src/post-processors/cms/text-images-processor.js";
import { createTestBlueprint } from "../../../helpers/blueprint-factory.js";
import { createTestContext } from "../../../helpers/post-processor-context.js";

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
