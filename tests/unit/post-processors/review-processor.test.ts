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
    });
});
