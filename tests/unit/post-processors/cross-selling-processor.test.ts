import { describe, expect, mock, test } from "bun:test";

import { CrossSellingProcessor } from "../../../src/post-processors/cross-selling-processor.js";
import { createTestBlueprint, createTestProduct } from "../../helpers/blueprint-factory.js";
import { createTestContext } from "../../helpers/post-processor-context.js";
import { createMockApiHelpers } from "../../mocks/index.js";

describe("CrossSellingProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(CrossSellingProcessor.name).toBe("cross-selling");
        });

        test("has description", () => {
            expect(CrossSellingProcessor.description).toBeDefined();
            expect(CrossSellingProcessor.description.length).toBeGreaterThan(0);
        });

        test("has no dependencies", () => {
            expect(CrossSellingProcessor.dependsOn).toEqual([]);
        });
    });

    describe("process", () => {
        test("returns early when no products in blueprint", async () => {
            const blueprint = createTestBlueprint({ products: [] });
            const { context } = createTestContext({ blueprint });

            const result = await CrossSellingProcessor.process(context);

            expect(result.processed).toBe(0);
            expect(result.skipped).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("dry run reports what would be created", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        primaryCategoryId: "cat-a",
                        categoryIds: ["cat-a"],
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        primaryCategoryId: "cat-a",
                        categoryIds: ["cat-a"],
                    }),
                    createTestProduct({
                        id: "p3",
                        name: "Product 3",
                        primaryCategoryId: "cat-b",
                        categoryIds: ["cat-b"],
                    }),
                    createTestProduct({
                        id: "p4",
                        name: "Product 4",
                        primaryCategoryId: "cat-b",
                        categoryIds: ["cat-b"],
                    }),
                ],
            });

            const { context } = createTestContext({ blueprint, dryRun: true });
            const result = await CrossSellingProcessor.process(context);

            expect(result.processed).toBe(4);
            expect(result.skipped).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("skips categories with only one product", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Lonely Product",
                        primaryCategoryId: "cat-solo",
                        categoryIds: ["cat-solo"],
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product A",
                        primaryCategoryId: "cat-pair",
                        categoryIds: ["cat-pair"],
                    }),
                    createTestProduct({
                        id: "p3",
                        name: "Product B",
                        primaryCategoryId: "cat-pair",
                        categoryIds: ["cat-pair"],
                    }),
                ],
            });

            const mockApi = createMockApiHelpers();
            mockApi.mockSyncSuccess();
            mockApi.mockSearchResponse("product-stream", []);
            mockApi.mockSearchResponse("product-cross-selling", []);

            const { context } = createTestContext({ blueprint, mockApi });
            const result = await CrossSellingProcessor.process(context);

            expect(result.skipped).toBe(1); // p1 in solo category
            expect(result.processed).toBe(2); // p2, p3 in pair category
        });

        test("creates product streams and cross-selling entries", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        primaryCategoryId: "cat-a",
                        categoryIds: ["cat-a"],
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        primaryCategoryId: "cat-a",
                        categoryIds: ["cat-a"],
                    }),
                    createTestProduct({
                        id: "p3",
                        name: "Product 3",
                        primaryCategoryId: "cat-a",
                        categoryIds: ["cat-a"],
                    }),
                ],
            });

            const mockApi = createMockApiHelpers();
            mockApi.mockSyncSuccess();
            mockApi.mockSearchResponse("product-stream", []);
            mockApi.mockSearchResponse("product-cross-selling", []);

            const { context } = createTestContext({ blueprint, mockApi });
            const result = await CrossSellingProcessor.process(context);

            expect(result.processed).toBe(3);
            expect(result.errors).toHaveLength(0);

            // Should have called sync twice: once for stream, once for cross-selling
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBe(2);
        });

        test("is idempotent - skips products that already have cross-selling", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        primaryCategoryId: "cat-a",
                        categoryIds: ["cat-a"],
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        primaryCategoryId: "cat-a",
                        categoryIds: ["cat-a"],
                    }),
                ],
            });

            const mockApi = createMockApiHelpers();
            mockApi.mockSyncSuccess();
            mockApi.mockSearchResponse("product-stream", [
                { id: "stream-1", name: "cross-sell-cat-a" },
            ]);
            mockApi.mockSearchResponse("product-cross-selling", [
                { id: "cs-1", productId: "p1" },
                { id: "cs-2", productId: "p2" },
            ]);

            const { context } = createTestContext({ blueprint, mockApi });
            const result = await CrossSellingProcessor.process(context);

            expect(result.skipped).toBe(2);
            expect(result.processed).toBe(0);
        });

        test("reuses existing stream but creates missing cross-selling entries", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        primaryCategoryId: "cat-a",
                        categoryIds: ["cat-a"],
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        primaryCategoryId: "cat-a",
                        categoryIds: ["cat-a"],
                    }),
                    createTestProduct({
                        id: "p3",
                        name: "Product 3",
                        primaryCategoryId: "cat-a",
                        categoryIds: ["cat-a"],
                    }),
                ],
            });

            const mockApi = createMockApiHelpers();
            mockApi.mockSyncSuccess();
            mockApi.mockSearchResponse("product-stream", [
                { id: "stream-1", name: "cross-sell-cat-a" },
            ]);
            mockApi.mockSearchResponse("product-cross-selling", [{ id: "cs-1", productId: "p1" }]);

            const { context } = createTestContext({ blueprint, mockApi });
            const result = await CrossSellingProcessor.process(context);

            expect(result.processed).toBe(2); // p2 and p3
            expect(result.skipped).toBe(1); // p1
            // Only cross-selling sync (no stream creation since it exists)
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBe(1);
        });

        test("handles API errors gracefully", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        primaryCategoryId: "cat-a",
                        categoryIds: ["cat-a"],
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        primaryCategoryId: "cat-a",
                        categoryIds: ["cat-a"],
                    }),
                ],
            });

            const mockApi = createMockApiHelpers();
            mockApi.mockSearchResponse("product-stream", []);
            mockApi.mockSearchResponse("product-cross-selling", []);
            mockApi.syncEntities = mock(async () => {
                throw new Error("Sync failed");
            });

            const { context } = createTestContext({ blueprint, mockApi });
            const result = await CrossSellingProcessor.process(context);

            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain("Failed for category");
        });

        test("handles multiple categories independently", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        primaryCategoryId: "cat-a",
                        categoryIds: ["cat-a"],
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        primaryCategoryId: "cat-a",
                        categoryIds: ["cat-a"],
                    }),
                    createTestProduct({
                        id: "p3",
                        name: "Product 3",
                        primaryCategoryId: "cat-b",
                        categoryIds: ["cat-b"],
                    }),
                    createTestProduct({
                        id: "p4",
                        name: "Product 4",
                        primaryCategoryId: "cat-b",
                        categoryIds: ["cat-b"],
                    }),
                    createTestProduct({
                        id: "p5",
                        name: "Product 5",
                        primaryCategoryId: "cat-b",
                        categoryIds: ["cat-b"],
                    }),
                ],
            });

            const mockApi = createMockApiHelpers();
            mockApi.mockSyncSuccess();
            mockApi.mockSearchResponse("product-stream", []);
            mockApi.mockSearchResponse("product-cross-selling", []);

            const { context } = createTestContext({ blueprint, mockApi });
            const result = await CrossSellingProcessor.process(context);

            expect(result.processed).toBe(5);
            expect(result.errors).toHaveLength(0);

            // 2 categories x 2 sync calls each (stream + cross-selling) = 4 sync calls
            // plus 1 search call for existing streams = 5 total calls
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBe(4);
        });
    });

    describe("cleanup", () => {
        test("returns early in dry run mode", async () => {
            const blueprint = createTestBlueprint({ products: [] });
            const { context } = createTestContext({ blueprint, dryRun: true });

            const result = await CrossSellingProcessor.cleanup!(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("returns 0 deleted when no products found", async () => {
            const blueprint = createTestBlueprint({ products: [] });
            const mockApi = createMockApiHelpers();
            mockApi.searchEntities = mock(async () => []);

            const { context } = createTestContext({ blueprint, mockApi });
            const result = await CrossSellingProcessor.cleanup!(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("deletes cross-selling entries and associated streams", async () => {
            const blueprint = createTestBlueprint({ products: [] });
            const mockApi = createMockApiHelpers();
            mockApi.mockSearchResponse("product", [{ id: "p1" }, { id: "p2" }]);
            mockApi.mockSearchResponse("product-cross-selling", [
                { id: "cs1", productStreamId: "stream-a" },
                { id: "cs2", productStreamId: "stream-a" },
                { id: "cs3", productStreamId: "stream-b" },
            ]);

            mockApi.deleteEntities = mock(async () => {});

            const { context } = createTestContext({ blueprint, mockApi });
            const result = await CrossSellingProcessor.cleanup!(context);

            // 3 cross-selling entries + 2 unique streams = 5
            expect(result.deleted).toBe(5);
            expect(result.errors).toHaveLength(0);
        });

        test("handles cleanup error", async () => {
            const blueprint = createTestBlueprint({ products: [] });
            const mockApi = createMockApiHelpers();

            mockApi.searchEntities = mock(async () => {
                throw new Error("Search failed");
            });

            const { context } = createTestContext({ blueprint, mockApi });
            const result = await CrossSellingProcessor.cleanup!(context);

            expect(result.deleted).toBe(0);
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain("Cross-selling cleanup failed");
        });
    });
});
