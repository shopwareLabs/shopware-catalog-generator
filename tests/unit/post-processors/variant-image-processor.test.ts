import { describe, expect, test } from "bun:test";

import type { SyncOperation } from "../../../src/shopware/api-helpers.js";
import type { VariantColor } from "../../../src/types/index.js";

import { COLOR_FAMILY_GROUP_ID, colorFamilyOptionId } from "../../../src/fixtures/index.js";
import {
    VariantImageProcessor,
    variantImageMediaId,
    variantProductMediaId,
} from "../../../src/post-processors/variant-image-processor.js";
import { createTestBlueprint, createTestProduct } from "../../helpers/blueprint-factory.js";
import { createTestContext } from "../../helpers/post-processor-context.js";
import { createMockApiHelpers, type MockApiHelpers } from "../../mocks/index.js";

const NAVY: VariantColor = { name: "Navy", hex: "#1f2a44", family: "blue" };
const BURGUNDY: VariantColor = { name: "Burgundy", hex: "#722f37", family: "red" };
const OLIVE: VariantColor = { name: "Olive", family: "green" };

const BLUEPRINT = createTestBlueprint({
    products: [
        createTestProduct({
            id: "p1",
            name: "Wool Coat",
            metadata: {
                isVariant: true,
                properties: [],
                imageDescriptions: [
                    { view: "front", prompt: "front" },
                    { view: "lifestyle", prompt: "lifestyle" },
                ],
                variantColors: [NAVY, BURGUNDY, OLIVE],
            },
        }),
    ],
});

/** Burgundy has both views, Olive only the front view */
const CACHED = new Set(["p1-front--burgundy", "p1-lifestyle--burgundy", "p1-front--olive"]);

const PARENT = {
    id: "p1",
    properties: [
        { id: "opt-size-m", groupId: "grp-size" },
        { id: colorFamilyOptionId("blue"), groupId: COLOR_FAMILY_GROUP_ID },
        { id: colorFamilyOptionId("red"), groupId: COLOR_FAMILY_GROUP_ID },
    ],
    media: [
        { mediaId: "parent-lifestyle", position: 1, media: { fileName: "Wool-Coat-lifestyle" } },
        { mediaId: "parent-front", position: 0, media: { fileName: "Wool-Coat-front" } },
    ],
    children: [
        { id: "c-navy", options: [{ id: "o1", name: "Navy" }] },
        {
            id: "c-burgundy",
            options: [
                { id: "o2", name: "Burgundy" },
                { id: "o3", name: "M" },
            ],
        },
        { id: "c-olive", options: [{ id: "o4", name: "olive" }] },
    ],
};

function syncBodies(mockApi: MockApiHelpers): Array<Record<string, SyncOperation>> {
    return mockApi
        .getCallsByEndpoint("_action/sync")
        .flatMap((call) => (call.body && typeof call.body === "object" ? [call.body] : []))
        .map((body) => Object.fromEntries(Object.entries(body)));
}

function operation(mockApi: MockApiHelpers, key: string): SyncOperation | undefined {
    return syncBodies(mockApi).find((body) => body[key])?.[key];
}

function setup(existingMedia: Array<{ id: string; fileName: string | null }> = []) {
    const mockApi = createMockApiHelpers();
    mockApi.mockSearchResponse("product", [PARENT]);
    mockApi.mockSearchResponse("media", existingMedia);
    return createTestContext({ blueprint: BLUEPRINT, cachedImages: CACHED, mockApi });
}

const uploads = (mockApi: MockApiHelpers) =>
    mockApi.getCalls().filter((c) => c.method === "postRaw");

describe("VariantImageProcessor", () => {
    test("runs after variants and parent images", () => {
        expect(VariantImageProcessor.name).toBe("variant-images");
        expect(VariantImageProcessor.dependsOn).toEqual(["variants", "images"]);
    });

    test("IDs are deterministic per product, view and variant", () => {
        expect(variantImageMediaId("p1", "front--olive")).toBe(
            variantImageMediaId("p1", "front--olive")
        );
        expect(variantImageMediaId("p1", "front--olive")).not.toBe(
            variantImageMediaId("p2", "front--olive")
        );
        expect(variantProductMediaId("c1", "front")).toMatch(/^[0-9a-f]{32}$/);
    });

    test("does nothing without cached colour images", async () => {
        const { context, mockApi } = createTestContext({ blueprint: BLUEPRINT });

        const result = await VariantImageProcessor.process(context);

        expect(result).toMatchObject({ processed: 0, skipped: 0, errors: [] });
        expect(mockApi.getCalls()).toHaveLength(0);
    });

    test("dry run only counts", async () => {
        const { context, mockApi } = createTestContext({
            blueprint: BLUEPRINT,
            cachedImages: CACHED,
            dryRun: true,
        });

        const result = await VariantImageProcessor.process(context);

        expect(result.processed).toBe(1);
        expect(mockApi.getCalls()).toHaveLength(0);
    });

    test("uploads colour images with shade alt texts", async () => {
        const { context, mockApi } = setup();

        const result = await VariantImageProcessor.process(context);

        expect(result.errors).toEqual([]);
        expect(uploads(mockApi)).toHaveLength(3);
        const media = operation(mockApi, "variantImageMedia");
        expect(media?.payload).toContainEqual({
            id: variantImageMediaId("p1", "front--burgundy"),
            private: false,
            mediaFolderId: "product-media-folder-mock",
            alt: "Wool Coat, Burgundy (front view)",
            title: "Wool Coat, Burgundy (front view)",
        });
    });

    test("sets the colour gallery and cover, falls back to the parent image per view", async () => {
        const { context, mockApi } = setup();

        const result = await VariantImageProcessor.process(context);

        expect(result.processed).toBe(1);
        const productMedia = operation(mockApi, "variantProductMedia")?.payload;
        expect(productMedia).toEqual([
            {
                id: variantProductMediaId("c-burgundy", "front"),
                productId: "c-burgundy",
                mediaId: variantImageMediaId("p1", "front--burgundy"),
                position: 0,
            },
            {
                id: variantProductMediaId("c-burgundy", "lifestyle"),
                productId: "c-burgundy",
                mediaId: variantImageMediaId("p1", "lifestyle--burgundy"),
                position: 1,
            },
            {
                id: variantProductMediaId("c-olive", "front"),
                productId: "c-olive",
                mediaId: variantImageMediaId("p1", "front--olive"),
                position: 0,
            },
            {
                id: variantProductMediaId("c-olive", "lifestyle"),
                productId: "c-olive",
                mediaId: "parent-lifestyle",
                position: 1,
            },
        ]);
    });

    test("gives each colour variant its own colour family, default colour keeps inheriting", async () => {
        const { context, mockApi } = setup();

        await VariantImageProcessor.process(context);

        const products = operation(mockApi, "variantCovers")?.payload;
        expect(products).toEqual([
            {
                id: "c-burgundy",
                coverId: variantProductMediaId("c-burgundy", "front"),
                properties: [{ id: "opt-size-m" }, { id: colorFamilyOptionId("red") }],
            },
            // Parent has no green family option: properties stay inherited
            { id: "c-olive", coverId: variantProductMediaId("c-olive", "front") },
        ]);
    });

    test("does not upload files again on a re-run", async () => {
        const { context, mockApi } = setup([
            { id: variantImageMediaId("p1", "front--burgundy"), fileName: "Wool-Coat-front" },
            { id: variantImageMediaId("p1", "front--olive"), fileName: null },
        ]);

        await VariantImageProcessor.process(context);

        expect(uploads(mockApi)).toHaveLength(2);
        expect(operation(mockApi, "variantProductMedia")?.payload).toHaveLength(4);
    });

    test("reports products missing in Shopware", async () => {
        const mockApi = createMockApiHelpers();
        mockApi.mockSearchResponse("product", []);
        const { context } = createTestContext({
            blueprint: BLUEPRINT,
            cachedImages: CACHED,
            mockApi,
        });

        const result = await VariantImageProcessor.process(context);

        expect(result.errors).toEqual(["Wool Coat: product not found in Shopware"]);
        expect(operation(mockApi, "variantProductMedia")).toBeUndefined();
    });

    test("cleanup deletes the variant galleries and colour images", async () => {
        const mockApi = createMockApiHelpers();
        mockApi.mockSearchResponse("product-media", [{ id: "pm-1" }, { id: "pm-2" }]);
        mockApi.mockSearchResponse("media", [{ id: "m-1" }]);
        const { context } = createTestContext({ blueprint: BLUEPRINT, mockApi });

        const result = await VariantImageProcessor.cleanup?.(context);

        expect(result).toMatchObject({ deleted: 3, errors: [] });
        expect(operation(mockApi, "delete-product_media")?.payload).toEqual([
            { id: "pm-1" },
            { id: "pm-2" },
        ]);
        expect(operation(mockApi, "delete-media")?.payload).toEqual([{ id: "m-1" }]);
    });
});
