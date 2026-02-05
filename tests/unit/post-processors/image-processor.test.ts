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
        hasImageWithView: mock((_salesChannelName: string, productId: string, view: string) => {
            return cachedImages.has(`${productId}-${view}`);
        }),
        loadImageWithView: mock((_salesChannelName: string, productId: string, view: string) => {
            if (cachedImages.has(`${productId}-${view}`)) {
                // Return a fake base64 image (JPEG magic bytes)
                return Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
            }
            return null;
        }),
        saveImageWithView: mock(
            (_salesChannelName: string, productId: string, view: string, _data: string) => {
                cachedImages.add(`${productId}-${view}`);
            }
        ),
        deleteImageWithView: mock((_salesChannelName: string, productId: string, view: string) => {
            cachedImages.delete(`${productId}-${view}`);
        }),
        isImageStale: mock((_salesChannelName: string, productId: string, view: string) => {
            return staleImages.has(`${productId}-${view}`);
        }),
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
        test("returns error when no image provider configured", async () => {
            const blueprint = createMockBlueprint([{ id: "p1", name: "Product 1" }]);

            const context = createMockContext(blueprint, {});
            const result = await ImageProcessor.process(context);

            expect(result.name).toBe("images");
            expect(result.processed).toBe(0);
            expect(result.skipped).toBe(1);
            expect(result.errors).toContain("No image provider configured");
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

        test("generates images for products without cached images", async () => {
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

            const mockApi = createMockApiHelpers();
            // Mock product search (no existing images)
            mockApi.mockPostResponse("search/product", { data: [] });
            // Mock media folder search
            mockApi.mockPostResponse("search/media-folder", { data: [{ id: "folder-1" }] });
            // Mock media search
            mockApi.mockPostResponse("search/media", { data: [] });
            // Mock sync success
            mockApi.setDefaultPostResponse({ success: true });
            mockApi.mockSyncSuccess();

            const context = createMockContext(
                blueprint,
                { metadataMap, cachedImages: new Set() },
                { includeImageProvider: true, mockApi }
            );
            const result = await ImageProcessor.process(context);

            // New behavior: processor generates missing images
            expect(result.processed).toBe(1);
            expect(result.skipped).toBe(0);
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

        test("cleans up existing images before re-upload", async () => {
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

            // Mock product search - ALL products have images
            // Note: MockApiHelpers returns the same response for all calls to the same endpoint,
            // so we mock that all products already have images to test the skip logic
            mockApi.mockPostResponse("search/product", {
                data: [
                    { id: "p1", media: [{ id: "media-1" }], coverId: "cover-1" },
                    { id: "p2", media: [{ id: "media-2" }], coverId: "cover-2" },
                ],
            });

            // Mock media folder search
            mockApi.mockPostResponse("search/media-folder", {
                data: [{ id: "folder-1" }],
            });
            mockApi.mockPostResponse("search/media-default-folder", {
                data: [{ id: "folder-1" }],
            });

            // Mock media search
            mockApi.mockPostResponse("search/media", { data: [] });

            // Mock sync and media upload
            mockApi.setDefaultPostResponse({ success: true });
            mockApi.mockSyncSuccess();
            mockApi.mockSearchResponse("product-media", [
                { id: "pm-1", mediaId: "media-1" },
                { id: "pm-2", mediaId: "media-2" },
            ]);

            // Both products have cached images
            const context = createMockContext(
                blueprint,
                {
                    metadataMap,
                    cachedImages: new Set(["p1-front", "p2-front"]),
                    staleImages: new Set(["p1-front", "p2-front"]),
                },
                { dryRun: false, includeImageProvider: true, mockApi }
            );
            const result = await ImageProcessor.process(context);

            // Verify the API was called to check for existing images
            const productSearchCalls = mockApi.getCallsByEndpoint("search/product");
            expect(productSearchCalls.length).toBeGreaterThan(0);

            // Both products are processed (attempted upload)
            expect(result.processed).toBe(2);
            expect(result.errors).toHaveLength(0);

            // Cleanup should remove existing product media before upload
            expect(mockApi.deleteEntitiesMock).toHaveBeenCalled();
        });
    });
});
