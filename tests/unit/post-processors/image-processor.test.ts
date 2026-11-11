import { describe, expect, test } from "bun:test";

import type { PostProcessorContext } from "../../../src/post-processors/index.js";

import {
    buildProductMediaTexts,
    ImageProcessor,
} from "../../../src/post-processors/image-processor.js";
import { ShopwareCapabilities } from "../../../src/shopware/version.js";
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

        test("re-uploads the file of linked media that have none", async () => {
            const views = [
                { view: "front" as const, prompt: "a" },
                { view: "lifestyle" as const, prompt: "b" },
            ];
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p-broken",
                        name: "Desk Lamp",
                        metadata: createMockProductMetadata({ imageDescriptions: views }),
                    }),
                ],
            });
            const { context, mockApi } = createTestContext({
                blueprint,
                metadataMap: new Map([["p-broken", { imageDescriptions: views }]]),
                cachedImages: new Set(["p-broken-front", "p-broken-lifestyle"]),
                dryRun: false,
                imageProvider: new MockImageProvider(),
            });
            mockApi.mockPostResponse("search/product", {
                data: [
                    {
                        id: "p-broken",
                        media: [
                            { mediaId: "m-ok", position: 0, media: { hasFile: true } },
                            { mediaId: "m-empty", position: 1, media: { hasFile: false } },
                        ],
                    },
                ],
            });

            const result = await ImageProcessor.process(context);

            expect(result.errors).toHaveLength(0);
            const uploads = mockApi.getCallsByEndpoint("_action/media/");
            expect(uploads.map((c) => c.endpoint)).toEqual([
                expect.stringContaining("_action/media/m-empty/upload"),
            ]);
            expect(uploads[0]?.endpoint).toContain("fileName=Desk-Lamp-lifestyle");
            expect(mockApi.getCallsByEndpoint("_action/sync")).toHaveLength(0);
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

describe("ImageProcessor - accessibility and social sharing", () => {
    type SyncBody = Record<string, { entity: string; payload: Array<Record<string, unknown>> }>;

    async function uploadOneProduct(version: string): Promise<SyncBody[]> {
        const blueprint = createTestBlueprint({
            products: [
                createTestProduct({
                    id: "p-a11y",
                    name: "Desk Lamp",
                    metadata: createMockProductMetadata({
                        imageDescriptions: [{ view: "front", prompt: "lamp" }],
                    }),
                }),
            ],
        });
        const { context, mockApi } = createTestContext({
            blueprint,
            metadataMap: new Map([
                ["p-a11y", { imageDescriptions: [{ view: "front" as const, prompt: "lamp" }] }],
            ]),
            cachedImages: new Set(["p-a11y-front"]),
            dryRun: false,
            imageProvider: new MockImageProvider(),
            shopware: ShopwareCapabilities.fromVersion(version),
        });
        mockApi.mockPostResponse("search/product", {
            data: [{ id: "p-a11y", media: [], coverId: null }],
        });
        mockApi.mockPostResponse("search/media", { data: [] });
        mockApi.mockPostResponse("search/media-folder", { data: [{ id: "folder-1" }] });
        mockApi.mockPostResponse("_action/sync", { success: true });

        await ImageProcessor.process(context);

        return mockApi.getCallsByEndpoint("_action/sync").map((c) => c.body as SyncBody);
    }

    test("new product media get alt text and title", async () => {
        const bodies = await uploadOneProduct("6.7.16.0");

        const media = bodies.find((b) => b.createMedia)?.createMedia?.payload[0];
        expect(media?.alt).toBe("Desk Lamp (front view)");
        expect(media?.title).toBe("Desk Lamp (front view)");
    });

    test("cover image doubles as social sharing image on 6.7.10+", async () => {
        const bodies = await uploadOneProduct("6.7.10.0");

        const media = bodies.find((b) => b.createMedia)?.createMedia?.payload[0];
        const cover = bodies.find((b) => b.updateCover)?.updateCover?.payload[0];
        expect(cover?.openGraphMediaId).toBe(media?.id as string);
    });

    test("no social sharing image before 6.7.10", async () => {
        const bodies = await uploadOneProduct("6.7.9.0");

        const cover = bodies.find((b) => b.updateCover)?.updateCover?.payload[0];
        expect(cover).toBeDefined();
        expect(cover?.openGraphMediaId).toBeUndefined();
    });

    test("product media are linked in view order with the first one as cover", async () => {
        const blueprint = createTestBlueprint({
            products: [
                createTestProduct({
                    id: "p-order",
                    name: "Oak Shelf",
                    metadata: createMockProductMetadata({
                        imageDescriptions: [
                            { view: "front", prompt: "a" },
                            { view: "side", prompt: "b" },
                        ],
                    }),
                }),
            ],
        });
        const { context, mockApi } = createTestContext({
            blueprint,
            metadataMap: new Map([
                [
                    "p-order",
                    {
                        imageDescriptions: [
                            { view: "front" as const, prompt: "a" },
                            { view: "side" as const, prompt: "b" },
                        ],
                    },
                ],
            ]),
            cachedImages: new Set(["p-order-front", "p-order-side"]),
            dryRun: false,
            shopware: ShopwareCapabilities.fromVersion("6.7.16.0"),
        });
        mockApi.mockPostResponse("search/product", {
            data: [{ id: "p-order", media: [], coverId: null }],
        });
        mockApi.mockPostResponse("search/media", { data: [] });
        mockApi.mockPostResponse("search/media-folder", { data: [{ id: "folder-1" }] });

        const result = await ImageProcessor.process(context);
        expect(result).toMatchObject({ processed: 1, skipped: 0, errors: [] });

        const bodies = mockApi.getCallsByEndpoint("_action/sync").map((c) => c.body as SyncBody);
        expect(bodies.length).toBe(2);
        const media = bodies[0]?.createMedia?.payload ?? [];
        expect(media.map((m) => m.title)).toEqual([
            "Oak Shelf (front view)",
            "Oak Shelf (side view)",
        ]);
        expect(media.every((m) => m.private === false && m.mediaFolderId === "folder-1")).toBe(
            true
        );

        const links = bodies[1]?.createProductMedia?.payload ?? [];
        expect(bodies[1]?.createProductMedia?.entity).toBe("product_media");
        expect(links.map((l) => l.position)).toEqual([0, 1]);
        expect(links.map((l) => l.mediaId)).toEqual(media.map((m) => m.id));
        expect(links.every((l) => l.productId === "p-order")).toBe(true);
        const cover = bodies[1]?.updateCover?.payload[0];
        expect(bodies[1]?.updateCover?.entity).toBe("product");
        expect(cover?.id).toBe("p-order");
        expect(cover?.coverId).toBe(links[0]?.id as string);

        const uploads = mockApi.getCallsByEndpoint("_action/media/").map((c) => c.endpoint);
        expect(uploads.length).toBe(2);
        expect(uploads.some((e) => e.includes("fileName=Oak-Shelf-front"))).toBe(true);
        expect(uploads.some((e) => e.includes("fileName=Oak-Shelf-side"))).toBe(true);
    });

    test("existing media with the same file name are linked without a new upload", async () => {
        const blueprint = createTestBlueprint({
            products: [
                createTestProduct({
                    id: "p-reuse",
                    name: "Reused Stool",
                    metadata: createMockProductMetadata({
                        imageDescriptions: [{ view: "front", prompt: "a" }],
                    }),
                }),
            ],
        });
        const { context, mockApi } = createTestContext({
            blueprint,
            metadataMap: new Map([
                ["p-reuse", { imageDescriptions: [{ view: "front" as const, prompt: "a" }] }],
            ]),
            cachedImages: new Set(["p-reuse-front"]),
            dryRun: false,
        });
        mockApi.mockPostResponse("search/product", {
            data: [{ id: "p-reuse", media: [], coverId: null }],
        });
        mockApi.mockPostResponse("search/media", { data: [{ id: "media-existing" }] });

        const result = await ImageProcessor.process(context);
        expect(result).toMatchObject({ processed: 1, errors: [] });

        const bodies = mockApi.getCallsByEndpoint("_action/sync").map((c) => c.body as SyncBody);
        expect(bodies.length).toBe(1);
        expect(bodies[0]?.createMedia).toBeUndefined();
        expect(bodies[0]?.createProductMedia?.payload[0]?.mediaId).toBe("media-existing");
        expect(mockApi.getCallsByEndpoint("_action/media/").length).toBe(0);
        const mediaSearch = JSON.stringify(mockApi.getCallsByEndpoint("search/media")[0]?.body);
        expect(mediaSearch).toContain('"value":"Reused-Stool-front"');
    });

    test("failed product and banner uploads are reported as errors", async () => {
        const blueprint = createTestBlueprint({
            products: [
                createTestProduct({
                    id: "p-fail",
                    name: "Broken Chair",
                    metadata: createMockProductMetadata({
                        imageDescriptions: [{ view: "front", prompt: "a" }],
                    }),
                }),
            ],
            categories: [
                {
                    id: "cat-fail",
                    name: "Broken Cat",
                    description: "d",
                    level: 1 as const,
                    hasImage: true,
                    imageDescription: "banner",
                    children: [],
                },
            ],
        });
        const { context, mockApi } = createTestContext({
            blueprint,
            metadataMap: new Map([
                ["p-fail", { imageDescriptions: [{ view: "front" as const, prompt: "a" }] }],
            ]),
            cachedImages: new Set(["p-fail-front", "cat-fail-banner"]),
            dryRun: false,
        });
        mockApi.mockPostResponse("search/product", {
            data: [{ id: "p-fail", media: [], coverId: null }],
        });
        mockApi.mockPostResponse("search/media", { data: [] });
        mockApi.mockPostResponse("search/category", { data: [{ id: "cat-fail", mediaId: null }] });
        mockApi.mockPostFailure("_action/sync", new Error("sync down"));

        const result = await ImageProcessor.process(context);

        expect(result.processed).toBe(0);
        expect(result.skipped).toBe(1);
        expect(result.errors).toEqual([
            "Failed to upload images for Broken Chair: sync down",
            "Failed to upload banner for Broken Cat: sync down",
        ]);
    });

    test("dry run counts products but not category banners", async () => {
        const blueprint = createTestBlueprint({
            products: [
                createTestProduct({
                    id: "p-dry",
                    name: "Dry Product",
                    metadata: createMockProductMetadata({
                        imageDescriptions: [{ view: "front", prompt: "a" }],
                    }),
                }),
            ],
            categories: [
                {
                    id: "cat-dry",
                    name: "Dry Cat",
                    description: "d",
                    level: 1 as const,
                    hasImage: true,
                    imageDescription: "banner",
                    children: [
                        {
                            id: "cat-dry-child",
                            name: "Dry Child",
                            description: "d",
                            level: 2 as const,
                            hasImage: true,
                            imageDescription: "banner",
                            children: [],
                        },
                    ],
                },
            ],
        });
        const { context, mockApi } = createTestContext({
            blueprint,
            metadataMap: new Map([
                ["p-dry", { imageDescriptions: [{ view: "front" as const, prompt: "a" }] }],
            ]),
            cachedImages: new Set(["p-dry-front", "cat-dry-child-banner"]),
            dryRun: true,
        });

        const result = await ImageProcessor.process(context);

        expect(result).toMatchObject({ processed: 1, skipped: 0, errors: [] });
        expect(mockApi.getCalls().length).toBe(0);
    });

    test("nested category banners are uploaded", async () => {
        const blueprint = createTestBlueprint({
            products: [],
            categories: [
                {
                    id: "cat-parent-nb",
                    name: "Parent",
                    description: "d",
                    level: 1 as const,
                    hasImage: false,
                    children: [
                        {
                            id: "cat-child-nb",
                            name: "Nested Banner",
                            description: "d",
                            level: 2 as const,
                            hasImage: true,
                            imageDescription: "banner",
                            children: [],
                        },
                    ],
                },
            ],
        });
        const { context, mockApi } = createTestContext({
            blueprint,
            metadataMap: new Map(),
            cachedImages: new Set(["cat-child-nb-banner"]),
            dryRun: false,
        });
        mockApi.mockPostResponse("search/category", { data: [] });
        mockApi.mockPostResponse("search/media", { data: [] });

        const result = await ImageProcessor.process(context);

        expect(result.errors).toEqual([]);
        const uploads = mockApi.getCallsByEndpoint("_action/media/").map((c) => c.endpoint);
        expect(uploads.length).toBe(1);
        expect(uploads[0]).toContain("fileName=Nested-Banner-banner");
    });

    test("buildProductMediaTexts names product and view", () => {
        expect(buildProductMediaTexts("Chair", "side")).toEqual({
            alt: "Chair (side view)",
            title: "Chair (side view)",
        });
    });
});
