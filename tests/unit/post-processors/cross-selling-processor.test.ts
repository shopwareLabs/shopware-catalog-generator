import { describe, expect, mock, test } from "bun:test";

import type { SyncOperation } from "../../../src/shopware/api-helpers.js";
import type { MockApiHelpers } from "../../mocks/index.js";

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

describe("CrossSellingProcessor (characterization)", () => {
    /** Products p1..pn in the given categories (one entry per product) */
    function blueprintWith(categories: string[]): ReturnType<typeof createTestBlueprint> {
        return createTestBlueprint({
            products: categories.map((cat, i) =>
                createTestProduct({
                    id: `p${i + 1}`,
                    name: `Product ${i + 1}`,
                    primaryCategoryId: cat,
                    categoryIds: [cat],
                })
            ),
        });
    }

    function syncBodies(mockApi: MockApiHelpers): Array<Record<string, SyncOperation>> {
        return mockApi
            .getCalls()
            .filter((c) => c.endpoint === "_action/sync")
            .map((c) => c.body as Record<string, SyncOperation>);
    }

    /** Make searchEntities throw for one entity */
    function failSearchFor(mockApi: MockApiHelpers, entity: string): void {
        const search = mockApi.searchEntities.bind(mockApi);
        mockApi.searchEntities = (async (name: string, filters, options) => {
            if (name === entity) throw new Error(`${entity} down`);
            return search(name, filters, options);
        }) as typeof mockApi.searchEntities;
    }

    function apiWithoutResults(): MockApiHelpers {
        const mockApi = createMockApiHelpers();
        mockApi.mockSyncSuccess();
        mockApi.mockSearchResponse("product-stream", []);
        mockApi.mockSearchResponse("product-cross-selling", []);
        return mockApi;
    }

    describe("process", () => {
        test("creates a category stream, then cross-selling that points to it", async () => {
            const mockApi = apiWithoutResults();
            const { context } = createTestContext({
                blueprint: blueprintWith(["cat-a", "cat-a"]),
                mockApi,
            });

            const result = await CrossSellingProcessor.process(context);

            expect(result).toEqual({
                name: "cross-selling",
                processed: 2,
                skipped: 0,
                errors: [],
                durationMs: 0,
            });
            const [streamSync, crossSync] = syncBodies(mockApi);
            expect(Object.keys(streamSync ?? {})).toEqual(["create-stream-cat-a"]);
            const streamOp = streamSync?.["create-stream-cat-a"];
            expect(streamOp?.entity).toBe("product_stream");
            expect(streamOp?.action).toBe("upsert");
            expect(streamOp?.payload).toEqual([
                {
                    id: expect.any(String),
                    name: "cross-sell-cat-a",
                    filters: [
                        {
                            id: expect.any(String),
                            type: "equals",
                            field: "categoriesRo.id",
                            value: "cat-a",
                            position: 0,
                        },
                    ],
                },
            ]);
            const streamPayload = streamOp?.payload[0] as { id: string; filters: { id: string }[] };
            expect(streamPayload.filters[0]?.id).not.toBe(streamPayload.id);

            const crossOp = crossSync?.["create-cross-selling-cat-a"];
            expect(crossOp?.entity).toBe("product_cross_selling");
            expect(crossOp?.action).toBe("upsert");
            expect(crossOp?.payload).toEqual(
                ["p1", "p2"].map((productId) => ({
                    id: expect.any(String),
                    productId,
                    name: "Similar Products",
                    type: "productStream",
                    productStreamId: streamPayload.id,
                    position: 1,
                    active: true,
                    limit: 10,
                    sortBy: "name",
                    sortDirection: "ASC",
                }))
            );
        });

        test("searches existing streams by prefix and cross-selling by blueprint products", async () => {
            const mockApi = apiWithoutResults();
            const { context } = createTestContext({
                blueprint: blueprintWith(["cat-a", "cat-a"]),
                mockApi,
            });

            await CrossSellingProcessor.process(context);

            const streamSearch = mockApi
                .getCalls()
                .find((c) => c.endpoint === "search/product-stream");
            expect(streamSearch?.body).toEqual({
                _filters: [{ type: "prefix", field: "name", value: "cross-sell" }],
                _options: { includes: { product_stream: ["id", "name"] }, limit: 500 },
            });
            const crossSearch = mockApi
                .getCalls()
                .find((c) => c.endpoint === "search/product-cross-selling");
            expect(crossSearch?.body).toMatchObject({
                _filters: [{ type: "equalsAny", field: "productId", value: ["p1", "p2"] }],
                _options: { includes: { product_cross_selling: ["id", "productId"] } },
            });
        });

        test("reuses the stream ID of an existing stream", async () => {
            const mockApi = apiWithoutResults();
            mockApi.mockSearchResponse("product-stream", [
                { id: "stream-x", name: "cross-sell-cat-a" },
                { id: "stream-y", name: "cross-sell-cat-other" },
            ]);
            const { context } = createTestContext({
                blueprint: blueprintWith(["cat-a", "cat-a"]),
                mockApi,
            });

            await CrossSellingProcessor.process(context);

            const bodies = syncBodies(mockApi);
            expect(bodies).toHaveLength(1);
            const payload = bodies[0]?.["create-cross-selling-cat-a"]?.payload as Array<{
                productStreamId: string;
            }>;
            expect(payload.map((p) => p.productStreamId)).toEqual(["stream-x", "stream-x"]);
        });

        test("makes no API calls for a blueprint without products", async () => {
            const mockApi = apiWithoutResults();
            const { context } = createTestContext({
                blueprint: createTestBlueprint({ products: [] }),
                mockApi,
            });

            await CrossSellingProcessor.process(context);

            expect(mockApi.getCalls()).toHaveLength(0);
        });

        test("syncs nothing when every product already has cross-selling", async () => {
            const mockApi = apiWithoutResults();
            mockApi.mockSearchResponse("product-stream", [
                { id: "stream-x", name: "cross-sell-cat-a" },
            ]);
            mockApi.mockSearchResponse("product-cross-selling", [
                { id: "cs-1", productId: "p1" },
                { id: "cs-2", productId: "p2" },
            ]);
            const { context } = createTestContext({
                blueprint: blueprintWith(["cat-a", "cat-a"]),
                mockApi,
            });

            const result = await CrossSellingProcessor.process(context);

            expect(result.skipped).toBe(2);
            expect(syncBodies(mockApi)).toHaveLength(0);
        });

        test("keeps going after a failing category and reports it", async () => {
            const mockApi = apiWithoutResults();
            const sync = mockApi.syncEntities.bind(mockApi);
            mockApi.syncEntities = async (operations) => {
                if ("create-stream-cat-a" in operations) throw new Error("Sync failed");
                return sync(operations);
            };
            const { context } = createTestContext({
                blueprint: blueprintWith(["cat-a", "cat-a", "cat-b", "cat-b", "cat-c"]),
                mockApi,
            });

            const result = await CrossSellingProcessor.process(context);

            expect(result).toEqual({
                name: "cross-selling",
                processed: 2,
                skipped: 1,
                errors: ["Failed for category cat-a: Sync failed"],
                durationMs: 0,
            });
        });

        test("stringifies non-Error failures", async () => {
            const mockApi = apiWithoutResults();
            mockApi.syncEntities = () => Promise.reject("plain");
            const { context } = createTestContext({
                blueprint: blueprintWith(["cat-a", "cat-a"]),
                mockApi,
            });

            const result = await CrossSellingProcessor.process(context);

            expect(result.errors).toEqual(["Failed for category cat-a: plain"]);
            expect(result.processed).toBe(0);
            expect(result.skipped).toBe(0);
        });

        test("treats failing lookups as nothing existing yet", async () => {
            const mockApi = apiWithoutResults();
            failSearchFor(mockApi, "product-stream");
            failSearchFor(mockApi, "product-cross-selling");
            const { context } = createTestContext({
                blueprint: blueprintWith(["cat-a", "cat-a"]),
                mockApi,
            });

            const result = await CrossSellingProcessor.process(context);

            expect(result.processed).toBe(2);
            expect(result.errors).toEqual([]);
            expect(syncBodies(mockApi)).toHaveLength(2);
        });

        test("dry run counts every product and skips all API calls", async () => {
            const mockApi = apiWithoutResults();
            const { context } = createTestContext({
                blueprint: blueprintWith(["cat-a", "cat-b", "cat-b"]),
                mockApi,
                dryRun: true,
            });

            const result = await CrossSellingProcessor.process(context);

            expect(result).toEqual({
                name: "cross-selling",
                processed: 3,
                skipped: 0,
                errors: [],
                durationMs: 0,
            });
            expect(mockApi.getCalls()).toHaveLength(0);
        });

        test("reports missing API helpers", async () => {
            const { context } = createTestContext({ blueprint: blueprintWith(["cat-a"]) });

            const result = await CrossSellingProcessor.process({
                ...context,
                api: undefined as unknown as typeof context.api,
            });

            expect(result).toEqual({
                name: "cross-selling",
                processed: 0,
                skipped: 0,
                errors: ["API helpers not available"],
                durationMs: 0,
            });
        });
    });

    describe("cleanup", () => {
        test("deletes cross-selling entries before their unique streams", async () => {
            const mockApi = createMockApiHelpers();
            mockApi.mockSearchResponse("product", [{ id: "p1" }, { id: "p2" }]);
            mockApi.mockSearchResponse("product-cross-selling", [
                { id: "cs1", productStreamId: "stream-a" },
                { id: "cs2" },
                { id: "cs3", productStreamId: "stream-a" },
                { id: "cs4", productStreamId: "stream-b" },
            ]);
            const { context } = createTestContext({ mockApi });

            const result = await CrossSellingProcessor.cleanup!(context);

            expect(result).toEqual({
                name: "cross-selling",
                deleted: 6,
                errors: [],
                durationMs: 0,
            });
            expect(syncBodies(mockApi)).toEqual([
                {
                    "delete-product_cross_selling": {
                        entity: "product_cross_selling",
                        action: "delete",
                        payload: [{ id: "cs1" }, { id: "cs2" }, { id: "cs3" }, { id: "cs4" }],
                    },
                },
                {
                    "delete-product_stream": {
                        entity: "product_stream",
                        action: "delete",
                        payload: [{ id: "stream-a" }, { id: "stream-b" }],
                    },
                },
            ]);
            const crossSearch = mockApi
                .getCalls()
                .find((c) => c.endpoint === "search/product-cross-selling");
            expect(crossSearch?.body).toMatchObject({
                _filters: [{ type: "equalsAny", field: "productId", value: ["p1", "p2"] }],
                _options: { includes: { product_cross_selling: ["id", "productStreamId"] } },
            });
        });

        test("skips the stream delete when no entry has a stream", async () => {
            const mockApi = createMockApiHelpers();
            mockApi.mockSearchResponse("product", [{ id: "p1" }]);
            mockApi.mockSearchResponse("product-cross-selling", [{ id: "cs1" }]);
            const { context } = createTestContext({ mockApi });

            const result = await CrossSellingProcessor.cleanup!(context);

            expect(result.deleted).toBe(1);
            expect(syncBodies(mockApi).map((b) => Object.keys(b))).toEqual([
                ["delete-product_cross_selling"],
            ]);
            expect(mockApi.deleteEntitiesMock).toHaveBeenCalledTimes(1);
        });

        test("deletes nothing when the products have no cross-selling", async () => {
            const mockApi = createMockApiHelpers();
            mockApi.mockSearchResponse("product", [{ id: "p1" }]);
            mockApi.mockSearchResponse("product-cross-selling", []);
            const { context } = createTestContext({ mockApi });

            const result = await CrossSellingProcessor.cleanup!(context);

            expect(result).toEqual({
                name: "cross-selling",
                deleted: 0,
                errors: [],
                durationMs: 0,
            });
            expect(syncBodies(mockApi)).toHaveLength(0);
            expect(mockApi.deleteEntitiesMock).not.toHaveBeenCalled();
        });

        test("filters products by the SalesChannel visibility", async () => {
            const mockApi = createMockApiHelpers();
            mockApi.mockSearchResponse("product", []);
            const { context } = createTestContext({ mockApi });

            await CrossSellingProcessor.cleanup!(context);

            const productSearch = mockApi.getCalls().find((c) => c.endpoint === "search/product");
            expect(productSearch?.body).toMatchObject({
                _filters: [
                    {
                        type: "equals",
                        field: "visibilities.salesChannelId",
                        value: context.salesChannelId,
                    },
                ],
            });
            expect(mockApi.getCalls().map((c) => c.endpoint)).toEqual(["search/product"]);
        });

        test("keeps the entries already deleted when the stream delete fails", async () => {
            const mockApi = createMockApiHelpers();
            mockApi.mockSearchResponse("product", [{ id: "p1" }]);
            mockApi.mockSearchResponse("product-cross-selling", [
                { id: "cs1", productStreamId: "stream-a" },
            ]);
            const sync = mockApi.syncEntities.bind(mockApi);
            mockApi.syncEntities = async (operations) => {
                if ("delete-product_stream" in operations) throw "stream locked";
                return sync(operations);
            };
            const { context } = createTestContext({ mockApi });

            const result = await CrossSellingProcessor.cleanup!(context);

            expect(result).toEqual({
                name: "cross-selling",
                deleted: 1,
                errors: ["Cross-selling cleanup failed: stream locked"],
                durationMs: 0,
            });
        });

        test("reports missing API helpers", async () => {
            const { context } = createTestContext();

            const result = await CrossSellingProcessor.cleanup!({
                ...context,
                api: undefined as unknown as typeof context.api,
            });

            expect(result).toEqual({
                name: "cross-selling",
                deleted: 0,
                errors: ["API helpers not available - cannot perform cleanup"],
                durationMs: 0,
            });
        });

        test("dry run makes no API calls", async () => {
            const mockApi = createMockApiHelpers();
            const { context } = createTestContext({ mockApi, dryRun: true });

            const result = await CrossSellingProcessor.cleanup!(context);

            expect(result).toEqual({
                name: "cross-selling",
                deleted: 0,
                errors: [],
                durationMs: 0,
            });
            expect(mockApi.getCalls()).toHaveLength(0);
        });
    });
});
