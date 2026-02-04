import { describe, expect, mock, test } from "bun:test";

import type { PostProcessorContext } from "../../../src/post-processors/index.js";
import { ReviewProcessor } from "../../../src/post-processors/review-processor.js";
import type { HydratedBlueprint, ProductMetadata } from "../../../src/types/index.js";
import { createMockApiHelpers, type MockApiHelpers } from "../../mocks/index.js";

// Helper to create a minimal mock blueprint
function createMockBlueprint(
    products: Array<{
        id: string;
        name: string;
        reviewCount?: 0 | 1 | 2 | 3 | 5 | 8 | 10;
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
                imageCount: 1 as const,
                imageDescriptions: [],
                isVariant: false,
                properties: [],
                reviewCount: p.reviewCount ?? 0,
                hasSalesPrice: false,
            },
        })),
        propertyGroups: [],
        createdAt: new Date().toISOString(),
        hydratedAt: new Date().toISOString(),
    };
}

// Helper to create mock cache that returns product metadata
function createMockCache(metadataMap: Map<string, Partial<ProductMetadata>>) {
    return {
        loadProductMetadata: mock((_salesChannelName: string, productId: string) => {
            const meta = metadataMap.get(productId);
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
    };
}

// Helper to create mock context
function createMockContext(
    blueprint: HydratedBlueprint,
    metadataMap: Map<string, Partial<ProductMetadata>>,
    options: { dryRun?: boolean; mockApi?: MockApiHelpers } = {}
): PostProcessorContext {
    return {
        salesChannelId: "sc-123",
        salesChannelName: "test-store",
        blueprint,
        cache: createMockCache(metadataMap) as unknown as PostProcessorContext["cache"],
        shopwareUrl: "https://test.shopware.com",
        getAccessToken: async () => "test-token",
        api: options.mockApi as unknown as PostProcessorContext["api"],
        options: {
            batchSize: 5,
            dryRun: options.dryRun || false,
        },
    };
}

describe("ReviewProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(ReviewProcessor.name).toBe("reviews");
        });

        test("has description", () => {
            expect(ReviewProcessor.description).toBeDefined();
            expect(ReviewProcessor.description.length).toBeGreaterThan(0);
        });

        test("has no dependencies", () => {
            expect(ReviewProcessor.dependsOn).toEqual([]);
        });
    });

    describe("process", () => {
        test("skips products with zero reviews", async () => {
            const blueprint = createMockBlueprint([
                { id: "p1", name: "Product 1", reviewCount: 0 },
                { id: "p2", name: "Product 2", reviewCount: 0 },
            ]);

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { reviewCount: 0 }],
                ["p2", { reviewCount: 0 }],
            ]);

            const context = createMockContext(blueprint, metadataMap);
            const result = await ReviewProcessor.process(context);

            expect(result.skipped).toBe(2);
            expect(result.processed).toBe(0);
        });

        test("processes products with reviews in dry run mode", async () => {
            const blueprint = createMockBlueprint([
                { id: "p1", name: "Product 1", reviewCount: 3 },
                { id: "p2", name: "Product 2", reviewCount: 5 },
                { id: "p3", name: "Product 3", reviewCount: 0 },
            ]);

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { reviewCount: 3 }],
                ["p2", { reviewCount: 5 }],
                ["p3", { reviewCount: 0 }],
            ]);

            const context = createMockContext(blueprint, metadataMap, { dryRun: true });
            const result = await ReviewProcessor.process(context);

            expect(result.processed).toBe(2); // p1 and p2
            expect(result.skipped).toBe(1); // p3
            expect(result.errors).toHaveLength(0);
        });

        test("handles missing product metadata", async () => {
            const blueprint = createMockBlueprint([
                { id: "p1", name: "Product 1", reviewCount: 3 },
            ]);

            // No metadata for any product
            const metadataMap = new Map<string, Partial<ProductMetadata>>();

            const context = createMockContext(blueprint, metadataMap);
            const result = await ReviewProcessor.process(context);

            expect(result.skipped).toBe(1);
            expect(result.processed).toBe(0);
        });

        test("skips products that already have reviews in Shopware", async () => {
            const blueprint = createMockBlueprint([
                { id: "p1", name: "Product 1", reviewCount: 3 },
                { id: "p2", name: "Product 2", reviewCount: 5 },
            ]);

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { reviewCount: 3 }],
                ["p2", { reviewCount: 5 }],
            ]);

            const mockApi = createMockApiHelpers();

            // Mock product-review search - p1 has reviews, p2 doesn't
            // Note: The processor checks reviews one product at a time, but with MockApiHelpers
            // we return the same response. For this test, we simulate that the first
            // product (p1) has reviews by returning total > 0 for the first call.
            // Since MockApiHelpers returns the same response, we mock that p1 has reviews.
            mockApi.mockPostResponse("search/product-review", {
                total: 3,
                data: [{ id: "r1" }],
            });

            // Mock sync success
            mockApi.setDefaultPostResponse({ success: true });
            mockApi.mockSyncSuccess();

            const context = createMockContext(blueprint, metadataMap, { dryRun: false, mockApi });
            const result = await ReviewProcessor.process(context);

            // With MockApiHelpers returning same response for all calls,
            // both products appear to have reviews (total: 3), so both are skipped
            expect(result.skipped).toBe(2); // Both skipped due to mock returning existing reviews
            expect(result.processed).toBe(0);
        });

        test("creates reviews when product has no existing reviews", async () => {
            const blueprint = createMockBlueprint([
                { id: "p1", name: "Product 1", reviewCount: 3 },
            ]);

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { reviewCount: 3 }],
            ]);

            const mockApi = createMockApiHelpers();

            // Mock no existing reviews
            mockApi.mockPostResponse("search/product-review", {
                total: 0,
                data: [],
            });

            // Mock sync success
            mockApi.mockSyncSuccess();

            const context = createMockContext(blueprint, metadataMap, { mockApi });
            const result = await ReviewProcessor.process(context);

            expect(result.processed).toBe(1);
            expect(result.skipped).toBe(0);
            expect(result.errors).toHaveLength(0);

            // Verify sync was called with reviews
            expect(mockApi.syncEntitiesMock).toHaveBeenCalled();
        });

        test("handles API error when creating reviews", async () => {
            const blueprint = createMockBlueprint([
                { id: "p1", name: "Product 1", reviewCount: 2 },
            ]);

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { reviewCount: 2 }],
            ]);

            const mockApi = createMockApiHelpers();

            // Mock no existing reviews
            mockApi.mockPostResponse("search/product-review", {
                total: 0,
                data: [],
            });

            // Mock sync failure
            mockApi.syncEntities = mock(async () => {
                throw new Error("API error");
            });

            const context = createMockContext(blueprint, metadataMap, { mockApi });
            const result = await ReviewProcessor.process(context);

            expect(result.processed).toBe(1);
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain("Failed to create reviews");
        });

        test("handles various review counts", async () => {
            const blueprint = createMockBlueprint([
                { id: "p1", name: "Product 1", reviewCount: 1 },
                { id: "p2", name: "Product 2", reviewCount: 5 },
                { id: "p3", name: "Product 3", reviewCount: 10 },
            ]);

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { reviewCount: 1 }],
                ["p2", { reviewCount: 5 }],
                ["p3", { reviewCount: 10 }],
            ]);

            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/product-review", { total: 0, data: [] });
            mockApi.mockSyncSuccess();

            const context = createMockContext(blueprint, metadataMap, { mockApi });
            const result = await ReviewProcessor.process(context);

            expect(result.processed).toBe(3);
            expect(result.skipped).toBe(0);
        });
    });

    describe("cleanup", () => {
        test("returns early in dry run mode", async () => {
            const blueprint = createMockBlueprint([]);
            const metadataMap = new Map<string, Partial<ProductMetadata>>();
            const mockApi = createMockApiHelpers();

            const context = createMockContext(blueprint, metadataMap, {
                dryRun: true,
                mockApi,
            });

            const result = await ReviewProcessor.cleanup!(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("returns error when API helpers not available", async () => {
            const blueprint = createMockBlueprint([]);
            const metadataMap = new Map<string, Partial<ProductMetadata>>();

            // Create context without API
            const context: PostProcessorContext = {
                salesChannelId: "sc-123",
                salesChannelName: "test-store",
                blueprint,
                cache: createMockCache(metadataMap) as unknown as PostProcessorContext["cache"],
                shopwareUrl: "https://test.shopware.com",
                getAccessToken: async () => "test-token",
                // api is undefined
                options: { batchSize: 5, dryRun: false },
            };

            const result = await ReviewProcessor.cleanup!(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toContain("API helpers not available - cannot perform cleanup");
        });

        test("returns 0 deleted when no products found", async () => {
            const blueprint = createMockBlueprint([]);
            const metadataMap = new Map<string, Partial<ProductMetadata>>();
            const mockApi = createMockApiHelpers();

            // Mock empty product search
            mockApi.searchEntities = mock(async () => []);

            const context = createMockContext(blueprint, metadataMap, { mockApi });
            const result = await ReviewProcessor.cleanup!(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("returns 0 deleted when no reviews found", async () => {
            const blueprint = createMockBlueprint([]);
            const metadataMap = new Map<string, Partial<ProductMetadata>>();
            const mockApi = createMockApiHelpers();

            let callCount = 0;
            (mockApi as { searchEntities: unknown }).searchEntities = mock(async () => {
                callCount++;
                if (callCount === 1) {
                    // First call: products
                    return [{ id: "p1" }, { id: "p2" }];
                }
                // Second call: reviews
                return [];
            });

            const context = createMockContext(blueprint, metadataMap, { mockApi });
            const result = await ReviewProcessor.cleanup(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("deletes reviews successfully", async () => {
            const blueprint = createMockBlueprint([]);
            const metadataMap = new Map<string, Partial<ProductMetadata>>();
            const mockApi = createMockApiHelpers();

            let callCount = 0;
            (mockApi as { searchEntities: unknown }).searchEntities = mock(async () => {
                callCount++;
                if (callCount === 1) {
                    // First call: products
                    return [{ id: "p1" }, { id: "p2" }];
                }
                // Second call: reviews
                return [{ id: "r1" }, { id: "r2" }, { id: "r3" }];
            });

            mockApi.deleteEntities = mock(async () => {});

            const context = createMockContext(blueprint, metadataMap, { mockApi });
            const result = await ReviewProcessor.cleanup!(context);

            expect(result.deleted).toBe(3);
            expect(result.errors).toHaveLength(0);
            expect(mockApi.deleteEntities).toHaveBeenCalledWith("product_review", [
                "r1",
                "r2",
                "r3",
            ]);
        });

        test("handles cleanup error", async () => {
            const blueprint = createMockBlueprint([]);
            const metadataMap = new Map<string, Partial<ProductMetadata>>();
            const mockApi = createMockApiHelpers();

            mockApi.searchEntities = mock(async () => {
                throw new Error("Search failed");
            });

            const context = createMockContext(blueprint, metadataMap, { mockApi });
            const result = await ReviewProcessor.cleanup!(context);

            expect(result.deleted).toBe(0);
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain("Review cleanup failed");
        });
    });
});
