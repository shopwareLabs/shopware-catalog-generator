import { describe, expect, mock, test } from "bun:test";

import type { PostProcessorContext } from "../../../src/post-processors/index.js";
import type {
    HydratedBlueprint,
    ImageDescription,
    ProductMetadata,
} from "../../../src/types/index.js";

import { ImageProcessor } from "../../../src/post-processors/image-processor.js";
import { createMockApiHelpers, type MockApiHelpers } from "../../mocks/index.js";

// Helper to create a minimal mock blueprint
function createMockBlueprint(
    products: Array<{
        id: string;
        name: string;
        imageDescriptions?: ImageDescription[];
    }>
): HydratedBlueprint {
    return {
        version: "1.0",
        salesChannel: { name: "test-store", description: "Test store" },
        categories: [],
        products: products.map((p) => ({
            id: p.id,
            name: p.name,
            description: "Test description",
            price: 29.99,
            stock: 10,
            primaryCategoryId: "cat1",
            categoryIds: ["cat1"],
            metadata: {
                imageCount: (p.imageDescriptions?.length || 1) as 1 | 2 | 3,
                imageDescriptions: p.imageDescriptions || [],
                isVariant: false,
                properties: [],
                reviewCount: 0 as const,
                hasSalesPrice: false,
            },
        })),
        propertyGroups: [],
        createdAt: new Date().toISOString(),
        hydratedAt: new Date().toISOString(),
    };
}

// Helper to create mock cache
function createMockCache(config: {
    metadataMap?: Map<string, Partial<ProductMetadata>>;
    cachedImages?: Set<string>; // Set of "productId-view" keys
    staleImages?: Set<string>; // Set of "productId-view" keys
}) {
    const cachedImages = new Set(config.cachedImages || []);
    const staleImages = config.staleImages || new Set<string>();

    const imageMethods = {
        hasImageWithView: mock(
            (_salesChannelName: string, productId: string, view: string, _mediaType?: string) => {
                return cachedImages.has(`${productId}-${view}`);
            }
        ),
        loadImageWithView: mock(
            (_salesChannelName: string, productId: string, view: string, _mediaType?: string) => {
                if (cachedImages.has(`${productId}-${view}`)) {
                    return Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
                }
                return null;
            }
        ),
        saveImageWithView: mock(
            (
                _salesChannelName: string,
                productId: string,
                view: string,
                _data: string,
                _prompt?: string,
                _imageModel?: string,
                _mediaType?: string
            ) => {
                cachedImages.add(`${productId}-${view}`);
            }
        ),
        deleteImageWithView: mock(
            (_salesChannelName: string, productId: string, view: string, _mediaType?: string) => {
                cachedImages.delete(`${productId}-${view}`);
            }
        ),
        isImageStale: mock(
            (
                _salesChannelName: string,
                productId: string,
                view: string,
                _currentBasePrompt: string,
                _mediaType?: string
            ) => {
                return staleImages.has(`${productId}-${view}`);
            }
        ),
    };

    return {
        loadProductMetadata: mock((_salesChannelName: string, productId: string) => {
            const meta = config.metadataMap?.get(productId);
            if (!meta) return null;
            return {
                imageCount: 1 as const,
                imageDescriptions: [],
                isVariant: false,
                properties: [],
                reviewCount: 0 as const,
                hasSalesPrice: false,
                ...meta,
            } as ProductMetadata;
        }),
        images: imageMethods,
    };
}

// Helper to create mock image provider
function createMockImageProvider() {
    return {
        name: "mock-provider",
        isSequential: false,
        maxConcurrency: 3,
        generateImage: mock(async (_prompt: string) => {
            // Return fake base64 image data
            return Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
        }),
    };
}

// Helper to create mock context
function createMockContext(
    blueprint: HydratedBlueprint,
    cacheConfig: Parameters<typeof createMockCache>[0],
    options: { dryRun?: boolean; includeImageProvider?: boolean; mockApi?: MockApiHelpers } = {}
): PostProcessorContext {
    return {
        salesChannelId: "sc-123",
        salesChannelName: "test-store",
        blueprint,
        cache: createMockCache(cacheConfig) as unknown as PostProcessorContext["cache"],
        imageProvider: options.includeImageProvider
            ? (createMockImageProvider() as unknown as PostProcessorContext["imageProvider"])
            : undefined,
        shopwareUrl: "https://test.shopware.com",
        getAccessToken: async () => "test-token",
        api: options.mockApi as unknown as PostProcessorContext["api"],
        options: {
            batchSize: 5,
            dryRun: options.dryRun || false,
        },
    };
}

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
            const blueprint = createMockBlueprint([{ id: "p1", name: "Product 1" }]);

            const context = createMockContext(blueprint, {});
            const result = await ImageProcessor.process(context);

            expect(result.name).toBe("images");
            expect(result.processed).toBe(0);
            expect(result.skipped).toBe(1);
            expect(result.errors).toHaveLength(0);
        });

        test("skips products without image descriptions", async () => {
            const blueprint = createMockBlueprint([
                { id: "p1", name: "Product 1", imageDescriptions: [] },
            ]);

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { imageDescriptions: [] }],
            ]);

            const context = createMockContext(
                blueprint,
                { metadataMap },
                { includeImageProvider: true }
            );
            const result = await ImageProcessor.process(context);

            expect(result.skipped).toBe(1);
            expect(result.processed).toBe(0);
        });

        test("skips products without cached images (images should be pre-generated)", async () => {
            const blueprint = createMockBlueprint([
                {
                    id: "p1",
                    name: "Product 1",
                    imageDescriptions: [{ view: "front", prompt: "test" }],
                },
            ]);

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { imageDescriptions: [{ view: "front" as const, prompt: "test" }] }],
            ]);

            const context = createMockContext(
                blueprint,
                { metadataMap, cachedImages: new Set() },
                { includeImageProvider: true }
            );
            const result = await ImageProcessor.process(context);

            expect(result.processed).toBe(0);
            expect(result.skipped).toBe(1);
        });

        test("processes products with cached images in dry run mode", async () => {
            const blueprint = createMockBlueprint([
                {
                    id: "p1",
                    name: "Product 1",
                    imageDescriptions: [{ view: "front", prompt: "test" }],
                },
            ]);

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { imageDescriptions: [{ view: "front" as const, prompt: "test" }] }],
            ]);

            const context = createMockContext(
                blueprint,
                { metadataMap, cachedImages: new Set(["p1-front"]) },
                { dryRun: true, includeImageProvider: true }
            );
            const result = await ImageProcessor.process(context);

            expect(result.processed).toBe(1);
            expect(result.skipped).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("handles multiple products with different states", async () => {
            const blueprint = createMockBlueprint([
                {
                    id: "p1",
                    name: "Product 1",
                    imageDescriptions: [{ view: "front", prompt: "test1" }],
                },
                { id: "p2", name: "Product 2", imageDescriptions: [] },
                {
                    id: "p3",
                    name: "Product 3",
                    imageDescriptions: [{ view: "side", prompt: "test3" }],
                },
            ]);

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { imageDescriptions: [{ view: "front" as const, prompt: "test1" }] }],
                ["p2", { imageDescriptions: [] }],
                ["p3", { imageDescriptions: [{ view: "side" as const, prompt: "test3" }] }],
            ]);

            const context = createMockContext(
                blueprint,
                { metadataMap, cachedImages: new Set(["p1-front", "p3-side"]) },
                { dryRun: true, includeImageProvider: true }
            );
            const result = await ImageProcessor.process(context);

            // p1 and p3 have images, p2 has no imageDescriptions (implicitly skipped - not counted)
            expect(result.processed).toBe(2);
            // skipped is only tracked for errors, p2 has no images so doesn't count
            expect(result.skipped).toBe(0);
        });

        test("skips products that already have images in Shopware", async () => {
            const blueprint = createMockBlueprint([
                {
                    id: "p1",
                    name: "Product 1",
                    imageDescriptions: [{ view: "front", prompt: "test1" }],
                },
                {
                    id: "p2",
                    name: "Product 2",
                    imageDescriptions: [{ view: "front", prompt: "test2" }],
                },
            ]);

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { imageDescriptions: [{ view: "front" as const, prompt: "test1" }] }],
                ["p2", { imageDescriptions: [{ view: "front" as const, prompt: "test2" }] }],
            ]);

            const mockApi = createMockApiHelpers();

            // Products already have images in Shopware
            mockApi.mockPostResponse("search/product", {
                data: [
                    { id: "p1", media: [{ id: "media-1" }], coverId: "cover-1" },
                    { id: "p2", media: [{ id: "media-2" }], coverId: "cover-2" },
                ],
            });

            // Both products have cached images
            const context = createMockContext(
                blueprint,
                {
                    metadataMap,
                    cachedImages: new Set(["p1-front", "p2-front"]),
                },
                { dryRun: false, includeImageProvider: true, mockApi }
            );
            const result = await ImageProcessor.process(context);

            // Verify the API was called to check for existing images
            const productSearchCalls = mockApi.getCallsByEndpoint("search/product");
            expect(productSearchCalls.length).toBeGreaterThan(0);

            // Both products are processed (attempted upload but skipped due to existing images)
            expect(result.processed).toBe(2);
            expect(result.errors).toHaveLength(0);

            // No cleanup or re-upload - processor just skips when images exist
            expect(mockApi.deleteEntitiesMock).not.toHaveBeenCalled();
        });

        test("uploads new media for products without existing Shopware images", async () => {
            const blueprint = createMockBlueprint([
                {
                    id: "p-upload-new",
                    name: "Product 1",
                    imageDescriptions: [{ view: "front", prompt: "test1" }],
                },
            ]);

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p-upload-new", { imageDescriptions: [{ view: "front" as const, prompt: "test1" }] }],
            ]);

            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/product", {
                data: [{ id: "p-upload-new", media: [], coverId: null }],
            });
            mockApi.mockPostResponse("search/media", { data: [] });
            mockApi.mockPostResponse("search/media-folder", { data: [{ id: "folder-1" }] });
            mockApi.mockPostResponse("_action/sync", { success: true });

            const context = createMockContext(
                blueprint,
                {
                    metadataMap,
                    cachedImages: new Set(["p-upload-new-front"]),
                },
                { dryRun: false, includeImageProvider: true, mockApi }
            );
            const result = await ImageProcessor.process(context);

            expect(result.processed).toBe(1);
            expect(result.errors).toHaveLength(0);
            expect(mockApi.getCallsByEndpoint("_action/media/").length).toBeGreaterThan(0);
        });

        test("uploads cached category banners when available", async () => {
            const blueprint = {
                ...createMockBlueprint([]),
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
            };

            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/category", {
                data: [{ id: "cat-banner-1", mediaId: null }],
            });
            mockApi.mockPostResponse("search/media", { data: [] });
            mockApi.mockPostResponse("search/media-default-folder", {
                data: [{ folder: { id: "folder-1" } }],
            });
            mockApi.mockPostResponse("_action/sync", { success: true });

            const context = createMockContext(
                blueprint,
                {
                    metadataMap: new Map(),
                    cachedImages: new Set(["cat-banner-1-banner"]),
                },
                { dryRun: false, includeImageProvider: true, mockApi }
            );

            const result = await ImageProcessor.process(context);
            expect(result.errors).toEqual([]);
            expect(mockApi.getCallsByEndpoint("_action/media/").length).toBeGreaterThan(0);
        });
    });

    describe("cleanup", () => {
        test("returns error when API helpers are missing", async () => {
            const context = createMockContext(createMockBlueprint([]), {}, { dryRun: false });
            context.api = undefined;

            const result = await ImageProcessor.cleanup(context);
            expect(result.deleted).toBe(0);
            expect(result.errors.length).toBeGreaterThan(0);
        });

        test("deletes product media entities for sales channel products", async () => {
            const mockApi = createMockApiHelpers();
            mockApi.mockSearchResponse("product", [{ id: "p1" }, { id: "p2" }]);
            mockApi.mockSearchResponse("product-media", [
                { id: "pm-1", mediaId: "m-1" },
                { id: "pm-2", mediaId: "m-2" },
            ]);
            mockApi.mockSearchResponse("sales-channel", [
                { id: "sc-1", navigationCategoryId: "root-cat" },
            ]);
            mockApi.mockSearchResponse("category", []);

            const context = createMockContext(createMockBlueprint([]), {}, { dryRun: false, mockApi });
            const result = await ImageProcessor.cleanup(context);

            expect(result.errors).toEqual([]);
            expect(result.deleted).toBeGreaterThanOrEqual(2);
            expect(mockApi.deleteEntitiesMock).toHaveBeenCalled();
            expect(mockApi.deleteEntityMock).toHaveBeenCalled();
        });
    });
});
