import { describe, expect, test } from "bun:test";

import type { PostProcessorContext } from "../../../src/post-processors/index.js";

import { ImageProcessor } from "../../../src/post-processors/image-processor.js";
import { createTestBlueprint, createTestProduct } from "../../helpers/blueprint-factory.js";
import { createTestContext } from "../../helpers/post-processor-context.js";
import { createMockProductMetadata, MockImageProvider } from "../../mocks/index.js";

describe("ImageProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(ImageProcessor.name).toBe("images");
        });

        test("has description", () => {
            expect(ImageProcessor.description).toBeDefined();
            expect(ImageProcessor.description.length).toBeGreaterThan(0);
        });

        test("has no dependencies", () => {
            expect(ImageProcessor.dependsOn).toEqual([]);
        });
    });

    describe("process", () => {
        test("reports nothing to upload when no cached images exist", async () => {
            const blueprint = createTestBlueprint({
                products: [createTestProduct({ id: "p1", name: "Product 1" })],
            });

            const { context } = createTestContext({ blueprint });
            const result = await ImageProcessor.process(context);

            expect(result.name).toBe("images");
            expect(result.processed).toBe(0);
            expect(result.skipped).toBe(1);
            expect(result.errors).toHaveLength(0);
        });

        test("skips products without image descriptions", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: createMockProductMetadata({ imageDescriptions: [] }),
                    }),
                ],
            });

            const metadataMap = new Map([["p1", { imageDescriptions: [] }]]);

            const { context } = createTestContext({
                blueprint,
                metadataMap,
                imageProvider: new MockImageProvider(),
            });
            const result = await ImageProcessor.process(context);

            expect(result.skipped).toBe(1);
            expect(result.processed).toBe(0);
        });

        test("skips products without cached images (images should be pre-generated)", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: createMockProductMetadata({
                            imageDescriptions: [{ view: "front", prompt: "test" }],
                        }),
                    }),
                ],
            });

            const metadataMap = new Map([
                ["p1", { imageDescriptions: [{ view: "front" as const, prompt: "test" }] }],
            ]);

            const { context } = createTestContext({
                blueprint,
                metadataMap,
                cachedImages: new Set(),
                imageProvider: new MockImageProvider(),
            });
            const result = await ImageProcessor.process(context);

            expect(result.processed).toBe(0);
            expect(result.skipped).toBe(1);
        });

        test("processes products with cached images in dry run mode", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: createMockProductMetadata({
                            imageDescriptions: [{ view: "front", prompt: "test" }],
                        }),
                    }),
                ],
            });

            const metadataMap = new Map([
                ["p1", { imageDescriptions: [{ view: "front" as const, prompt: "test" }] }],
            ]);

            const { context } = createTestContext({
                blueprint,
                metadataMap,
                cachedImages: new Set(["p1-front"]),
                dryRun: true,
                imageProvider: new MockImageProvider(),
            });
            const result = await ImageProcessor.process(context);

            expect(result.processed).toBe(1);
            expect(result.skipped).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("handles multiple products with different states", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: createMockProductMetadata({
                            imageDescriptions: [{ view: "front", prompt: "test1" }],
                        }),
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        metadata: createMockProductMetadata({ imageDescriptions: [] }),
                    }),
                    createTestProduct({
                        id: "p3",
                        name: "Product 3",
                        metadata: createMockProductMetadata({
                            imageDescriptions: [{ view: "side", prompt: "test3" }],
                        }),
                    }),
                ],
            });

            const metadataMap = new Map([
                ["p1", { imageDescriptions: [{ view: "front" as const, prompt: "test1" }] }],
                ["p2", { imageDescriptions: [] }],
                ["p3", { imageDescriptions: [{ view: "side" as const, prompt: "test3" }] }],
            ]);

            const { context } = createTestContext({
                blueprint,
                metadataMap,
                cachedImages: new Set(["p1-front", "p3-side"]),
                dryRun: true,
                imageProvider: new MockImageProvider(),
            });
            const result = await ImageProcessor.process(context);

            expect(result.processed).toBe(2);
            expect(result.skipped).toBe(0);
        });

        test("skips products that already have images in Shopware", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: createMockProductMetadata({
                            imageDescriptions: [{ view: "front", prompt: "test1" }],
                        }),
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        metadata: createMockProductMetadata({
                            imageDescriptions: [{ view: "front", prompt: "test2" }],
                        }),
                    }),
                ],
            });

            const metadataMap = new Map([
                ["p1", { imageDescriptions: [{ view: "front" as const, prompt: "test1" }] }],
                ["p2", { imageDescriptions: [{ view: "front" as const, prompt: "test2" }] }],
            ]);

            const { context, mockApi } = createTestContext({
                blueprint,
                metadataMap,
                cachedImages: new Set(["p1-front", "p2-front"]),
                dryRun: false,
                imageProvider: new MockImageProvider(),
            });

            mockApi.mockPostResponse("search/product", {
                data: [
                    { id: "p1", media: [{ id: "media-1" }], coverId: "cover-1" },
                    { id: "p2", media: [{ id: "media-2" }], coverId: "cover-2" },
                ],
            });

            const result = await ImageProcessor.process(context);

            const productSearchCalls = mockApi.getCallsByEndpoint("search/product");
            expect(productSearchCalls.length).toBeGreaterThan(0);

            expect(result.processed).toBe(2);
            expect(result.errors).toHaveLength(0);

            expect(mockApi.deleteEntitiesMock).not.toHaveBeenCalled();
        });

        test("uploads new media for products without existing Shopware images", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p-upload-new",
                        name: "Product 1",
                        metadata: createMockProductMetadata({
                            imageDescriptions: [{ view: "front", prompt: "test1" }],
                        }),
                    }),
                ],
            });

            const metadataMap = new Map([
                [
                    "p-upload-new",
                    { imageDescriptions: [{ view: "front" as const, prompt: "test1" }] },
                ],
            ]);

            const { context, mockApi } = createTestContext({
                blueprint,
                metadataMap,
                cachedImages: new Set(["p-upload-new-front"]),
                dryRun: false,
                imageProvider: new MockImageProvider(),
            });

            mockApi.mockPostResponse("search/product", {
                data: [{ id: "p-upload-new", media: [], coverId: null }],
            });
            mockApi.mockPostResponse("search/media", { data: [] });
            mockApi.mockPostResponse("search/media-folder", { data: [{ id: "folder-1" }] });
            mockApi.mockPostResponse("_action/sync", { success: true });

            const result = await ImageProcessor.process(context);

            expect(result.processed).toBe(1);
            expect(result.errors).toHaveLength(0);
            expect(mockApi.getCallsByEndpoint("_action/media/").length).toBeGreaterThan(0);
        });

        test("uploads cached category banners when available", async () => {
            const blueprint = createTestBlueprint({
                products: [],
                categories: [
                    {
                        id: "cat-banner-1",
                        name: "Featured",
                        description: "Featured products",
                        level: 1 as const,
                        hasImage: true,
                        imageDescription: "A featured category banner",
                        children: [],
                    },
                ],
            });

            const { context, mockApi } = createTestContext({
                blueprint,
                metadataMap: new Map(),
                cachedImages: new Set(["cat-banner-1-banner"]),
                dryRun: false,
                imageProvider: new MockImageProvider(),
            });

            mockApi.mockPostResponse("search/category", {
                data: [{ id: "cat-banner-1", mediaId: null }],
            });
            mockApi.mockPostResponse("search/media", { data: [] });
            mockApi.mockPostResponse("search/media-default-folder", {
                data: [{ folder: { id: "folder-1" } }],
            });
            mockApi.mockPostResponse("_action/sync", { success: true });

            const result = await ImageProcessor.process(context);
            expect(result.errors).toEqual([]);
            expect(mockApi.getCallsByEndpoint("_action/media/").length).toBeGreaterThan(0);
        });
    });

    describe("cleanup", () => {
        test("returns error when API helpers are missing", async () => {
            const { context: baseContext } = createTestContext({
                blueprint: createTestBlueprint(),
                dryRun: false,
            });
            const { api: _api, ...rest } = baseContext;
            const contextWithoutApi = { ...rest } as PostProcessorContext;

            const result = await ImageProcessor.cleanup(contextWithoutApi);
            expect(result.deleted).toBe(0);
            expect(result.errors.length).toBeGreaterThan(0);
        });

        test("deletes product media entities for sales channel products", async () => {
            const { context, mockApi } = createTestContext({
                blueprint: createTestBlueprint(),
                dryRun: false,
            });

            mockApi.mockSearchResponse("product", [{ id: "p1" }, { id: "p2" }]);
            mockApi.mockSearchResponse("product-media", [
                { id: "pm-1", mediaId: "m-1" },
                { id: "pm-2", mediaId: "m-2" },
            ]);
            mockApi.mockSearchResponse("sales-channel", [
                { id: "sc-1", navigationCategoryId: "root-cat" },
            ]);
            mockApi.mockSearchResponse("category", []);

            const result = await ImageProcessor.cleanup(context);

            expect(result.errors).toEqual([]);
            expect(result.deleted).toBeGreaterThanOrEqual(2);
            expect(mockApi.deleteEntitiesMock).toHaveBeenCalled();
            expect(mockApi.deleteEntityMock).toHaveBeenCalled();
        });
    });
});
