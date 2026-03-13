import { describe, expect, test } from "bun:test";

import type { PostProcessorContext } from "../../../src/post-processors/index.js";

import { CategoryImageProcessor } from "../../../src/post-processors/category-image-processor.js";
import { createTestBlueprint } from "../../helpers/blueprint-factory.js";
import { createTestContext } from "../../helpers/post-processor-context.js";

describe("CategoryImageProcessor", () => {
    test("skips upload when category already has image and cleanup disabled", async () => {
        const { context, mockApi } = createTestContext({
            salesChannelId: "sc-1",
            salesChannelName: "music",
            blueprint: createTestBlueprint({
                salesChannel: { name: "music", description: "Music store" },
            }),
        });

        mockApi.mockPostResponse("search/category", {
            data: [{ id: "cat-1", mediaId: "media-existing" }],
        });

        const processor = new CategoryImageProcessor();
        const uploaded = await processor.uploadCategoryImage(
            context,
            "cat-1",
            "Guitars",
            Buffer.from([0xff, 0xd8, 0xff]).toString("base64"),
            false
        );

        expect(uploaded).toBe(false);
        expect(mockApi.getCallsByEndpoint("_action/media/").length).toBe(0);
    });

    test("uploads and links new category media when none exists", async () => {
        const { context, mockApi } = createTestContext({
            salesChannelId: "sc-1",
            salesChannelName: "music",
            blueprint: createTestBlueprint({
                salesChannel: { name: "music", description: "Music store" },
            }),
        });

        mockApi.mockPostResponse("search/category", { data: [{ id: "cat-1", mediaId: null }] });
        mockApi.mockPostResponse("search/media", { data: [] });
        mockApi.mockPostResponse("search/media-default-folder", {
            data: [{ folder: { id: "folder-1" } }],
        });
        mockApi.mockPostResponse("_action/sync", { success: true });

        const processor = new CategoryImageProcessor();
        const uploaded = await processor.uploadCategoryImage(
            context,
            "cat-1",
            "Guitars",
            Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"),
            true
        );

        expect(uploaded).toBe(true);
        expect(mockApi.getCallsByEndpoint("_action/media/").length).toBeGreaterThan(0);
        expect(mockApi.getCallsByEndpoint("_action/sync").length).toBeGreaterThan(0);
    });

    test("cleanupCategoryImages clears media for categories under sales channel root", async () => {
        const { context, mockApi } = createTestContext({
            salesChannelId: "sc-1",
            salesChannelName: "music",
            blueprint: createTestBlueprint({
                salesChannel: { name: "music", description: "Music store" },
            }),
        });

        mockApi.mockSearchResponse("sales-channel", [
            { id: "sc-1", navigationCategoryId: "root-cat" },
        ]);
        mockApi.mockSearchResponse("category", [
            { id: "cat-1", mediaId: "media-1" },
            { id: "cat-2", mediaId: "media-2" },
            { id: "cat-3", mediaId: null },
        ]);

        const processor = new CategoryImageProcessor();
        const deleted = await processor.cleanupCategoryImages(context);

        expect(deleted).toBe(2);
        expect(mockApi.syncEntitiesMock).toHaveBeenCalled();
    });

    test("clearCategoryImage skips cleanup when api is unavailable", async () => {
        const { context: baseContext } = createTestContext({
            salesChannelId: "sc-1",
            salesChannelName: "music",
            blueprint: createTestBlueprint({
                salesChannel: { name: "music", description: "Music store" },
            }),
        });
        const { api: _api, ...rest } = baseContext;
        const contextWithoutApi = { ...rest } as PostProcessorContext;

        const processor = new CategoryImageProcessor();
        await processor.clearCategoryImage(contextWithoutApi, "cat-1", "Guitars", "media-1");
    });

    test("clearCategoryImage tolerates media delete errors", async () => {
        const { context, mockApi } = createTestContext({
            salesChannelId: "sc-1",
            salesChannelName: "music",
            blueprint: createTestBlueprint({
                salesChannel: { name: "music", description: "Music store" },
            }),
        });

        mockApi.deleteEntityMock.mockImplementation(() => {
            throw new Error("still referenced");
        });

        const processor = new CategoryImageProcessor();
        await processor.clearCategoryImage(context, "cat-1", "Guitars", "media-1");

        expect(mockApi.syncEntitiesMock).toHaveBeenCalled();
        expect(mockApi.deleteEntityMock).toHaveBeenCalled();
    });
});
