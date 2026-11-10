/**
 * Unit tests for shopware/cleanup module
 */

import { describe, expect, mock, test } from "bun:test";

import { ShopwareCleanup } from "../../../src/shopware/cleanup.js";

// =============================================================================
// Test Setup
// =============================================================================

/**
 * Create a mock AdminApiClient for testing.
 * Routes invoke() calls based on the operation string.
 */
function createMockAdminClient() {
    const searchResponses = new Map<string, unknown>();
    const deleteErrors = new Map<string, Error>();
    const calls: Array<{ operation: string; params?: Record<string, unknown> }> = [];

    const invoke = mock(
        async (operation: string, params?: Record<string, unknown>): Promise<unknown> => {
            calls.push({ operation, params });

            // Handle delete operations
            if (operation.includes(" delete /")) {
                const pathParams = (params as { pathParams?: { id?: string } })?.pathParams;
                if (pathParams?.id) {
                    const error = deleteErrors.get(pathParams.id);
                    if (error) throw error;
                }
                return undefined;
            }

            // Handle sync operations
            if (operation.includes("sync post")) {
                return {};
            }

            // Handle search operations - match by path segment
            // invoke() returns { data: responseBody }; for search, responseBody is { data: T[], total: N }
            for (const [key, value] of searchResponses) {
                if (operation.includes(`/search/${key}`) || operation.includes(`/${key}`)) {
                    return { data: value };
                }
            }

            // Default: empty search result (wrapped for invoke return shape)
            return { data: { data: [], total: 0 } };
        }
    );

    return {
        invoke,
        calls,
        getSessionData: () => ({ accessToken: "test-token", expirationTime: Date.now() + 3600000 }),

        // Helpers for setting up mock responses
        mockSearchResponse(entity: string, response: unknown) {
            searchResponses.set(entity, response);
        },

        mockDeleteError(entityId: string, error: Error) {
            deleteErrors.set(entityId, error);
        },

        getCallsByOperation(pattern: string) {
            return calls.filter((c) => c.operation.includes(pattern));
        },

        reset() {
            calls.length = 0;
            searchResponses.clear();
            deleteErrors.clear();
        },
    };
}

/**
 * Create a testable ShopwareCleanup instance with mocked internals
 */
function createTestableCleanup() {
    const mockClient = createMockAdminClient();

    // Create cleanup with the mock client
    const cleanup = new ShopwareCleanup(mockClient as never);

    // Override getProductMediaFolderId
    (
        cleanup as unknown as { getProductMediaFolderId: () => Promise<string | null> }
    ).getProductMediaFolderId = async () => "product-media-folder-id";

    return { cleanup, mockClient };
}

// =============================================================================
// Tests: getSalesChannelByName
// =============================================================================

describe("ShopwareCleanup", () => {
    describe("getSalesChannelByName", () => {
        test("finds SalesChannel with normalized name", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockSearchResponse("sales-channel", {
                data: [{ id: "sc-123", navigationCategoryId: "cat-root" }],
                total: 1,
            });

            const result = await cleanup.getSalesChannelByName("digital_invitations");

            expect(result).not.toBeNull();
            expect(result?.id).toBe("sc-123");
            expect(result?.navigationCategoryId).toBe("cat-root");
        });

        test("returns null when SalesChannel not found", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockSearchResponse("sales-channel", { data: [], total: 0 });

            const result = await cleanup.getSalesChannelByName("nonexistent");

            expect(result).toBeNull();
        });

        test("returns null when not authenticated", async () => {
            const cleanup = new ShopwareCleanup();

            const result = await cleanup.getSalesChannelByName("test");

            expect(result).toBeNull();
        });
    });

    // =========================================================================
    // Tests: deleteProductsInSalesChannel
    // =========================================================================

    describe("deleteProductsInSalesChannel", () => {
        test("deletes products with visibility in SalesChannel", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockSearchResponse("product", {
                data: [
                    { id: "prod-1", name: "Product 1" },
                    { id: "prod-2", name: "Product 2" },
                    { id: "prod-3", name: "Product 3" },
                ],
                total: 3,
            });

            const count = await cleanup.deleteProductsInSalesChannel("sc-123");

            expect(count).toBe(3);

            // Verify sync was called with delete payload
            const syncCalls = mockClient.getCallsByOperation("sync post");
            expect(syncCalls.length).toBe(1);

            const syncBody = (syncCalls[0]?.params as { body?: unknown[] })?.body;
            const deleteOp = syncBody?.[0] as {
                entity: string;
                action: string;
                payload: Array<{ id: string }>;
            };
            expect(deleteOp.entity).toBe("product");
            expect(deleteOp.action).toBe("delete");
            expect(deleteOp.payload).toHaveLength(3);
        });

        test("returns 0 when no products found", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockSearchResponse("product", { data: [], total: 0 });

            const count = await cleanup.deleteProductsInSalesChannel("sc-123");

            expect(count).toBe(0);

            // No sync call should be made
            const syncCalls = mockClient.getCallsByOperation("sync post");
            expect(syncCalls.length).toBe(0);
        });
    });

    describe("deleteProductsByIds", () => {
        test("searches the given IDs and deletes the ones that exist", async () => {
            const { cleanup, mockClient } = createTestableCleanup();
            mockClient.mockSearchResponse("product", {
                data: [{ id: "prod-1", name: "Product 1" }],
                total: 1,
            });

            const count = await cleanup.deleteProductsByIds(["prod-1", "prod-gone"]);

            expect(count).toBe(1);
            const search = mockClient.getCallsByOperation("/search/product")[0];
            const body = (search?.params as { body?: { filter?: unknown[] } })?.body;
            expect(body?.filter).toEqual([
                { type: "equalsAny", field: "id", value: ["prod-1", "prod-gone"] },
            ]);
            const syncBody = (mockClient.getCallsByOperation("sync post")[0]?.params as {
                body?: unknown[];
            })?.body;
            expect(syncBody?.[0]).toEqual({
                entity: "product",
                action: "delete",
                payload: [{ id: "prod-1" }],
            });
        });

        test("does not call Shopware without IDs", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            expect(await cleanup.deleteProductsByIds([])).toBe(0);
            expect(mockClient.calls).toHaveLength(0);
        });

        test("does not sync when none of the products exist", async () => {
            const { cleanup, mockClient } = createTestableCleanup();
            mockClient.mockSearchResponse("product", { data: [], total: 0 });

            expect(await cleanup.deleteProductsByIds(["prod-gone"])).toBe(0);
            expect(mockClient.getCallsByOperation("sync post")).toHaveLength(0);
        });
    });

    // =========================================================================
    // Tests: deleteCategoriesUnderRoot
    // =========================================================================

    describe("deleteCategoriesUnderRoot", () => {
        test("deletes all child categories", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockSearchResponse("category", {
                data: [
                    { id: "cat-1", name: "Category 1", parentId: "root" },
                    { id: "cat-2", name: "Category 2", parentId: "root" },
                    { id: "cat-3", name: "Category 3", parentId: "cat-1" },
                    { id: "cat-4", name: "Category 4", parentId: "cat-1" },
                    { id: "cat-5", name: "Category 5", parentId: "cat-2" },
                ],
                total: 5,
            });

            const count = await cleanup.deleteCategoriesUnderRoot("root");

            expect(count).toBe(5);

            const syncCalls = mockClient.getCallsByOperation("sync post");
            expect(syncCalls.length).toBe(1);
        });

        test("returns 0 when no child categories", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockSearchResponse("category", { data: [], total: 0 });

            const count = await cleanup.deleteCategoriesUnderRoot("root");

            expect(count).toBe(0);
        });
    });

    // =========================================================================
    // Tests: deleteOrphanedProductMedia (dry run)
    // =========================================================================

    describe("deleteOrphanedProductMedia", () => {
        test("dry run reports orphaned media without deleting", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockSearchResponse("media", {
                data: [
                    {
                        id: "media-1",
                        fileName: "product-image-1",
                        mediaFolderId: "folder-1",
                        productMedia: [],
                    },
                    {
                        id: "media-2",
                        fileName: "product-image-2",
                        mediaFolderId: "folder-1",
                        productMedia: [{ id: "pm-1" }],
                    },
                    {
                        id: "media-3",
                        fileName: "product-image-3",
                        mediaFolderId: null,
                        productMedia: [],
                    },
                ],
                total: 3,
            });

            const count = await cleanup.deleteOrphanedProductMedia(true);

            // Should report 2 orphaned (media-1 and media-3 have no productMedia)
            expect(count).toBe(2);

            // No delete calls should be made in dry run
            const deleteCalls = mockClient.getCallsByOperation("delete /");
            expect(deleteCalls.length).toBe(0);
        });

        test("actual run deletes orphaned media", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockSearchResponse("media", {
                data: [
                    {
                        id: "media-1",
                        fileName: "orphan-1",
                        mediaFolderId: "folder-1",
                        productMedia: [],
                    },
                    {
                        id: "media-2",
                        fileName: "orphan-2",
                        mediaFolderId: null,
                        productMedia: [],
                    },
                ],
                total: 2,
            });

            const count = await cleanup.deleteOrphanedProductMedia(false);

            expect(count).toBe(2);

            // Verify delete calls were made via invoke
            const deleteCalls = mockClient.getCallsByOperation("deleteMedia delete");
            expect(deleteCalls.length).toBe(2);
        });
    });

    // =========================================================================
    // Tests: cleanupSalesChannel
    // =========================================================================

    describe("cleanupSalesChannel", () => {
        test("cleans up products and categories for SalesChannel", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockSearchResponse("sales-channel", {
                data: [{ id: "sc-123", navigationCategoryId: "cat-root" }],
                total: 1,
            });
            mockClient.mockSearchResponse("product", {
                data: [
                    { id: "prod-1", name: "Product 1" },
                    { id: "prod-2", name: "Product 2" },
                ],
                total: 2,
            });
            mockClient.mockSearchResponse("category", {
                data: [
                    { id: "cat-1", name: "Cat 1", parentId: "cat-root" },
                    { id: "cat-2", name: "Cat 2", parentId: "cat-root" },
                    { id: "cat-3", name: "Cat 3", parentId: "cat-1" },
                ],
                total: 3,
            });

            const result = await cleanup.cleanupSalesChannel("test-store");

            expect(result.products).toBe(2);
            expect(result.categories).toBe(3);
            expect(result.salesChannelDeleted).toBe(false);
            expect(result.rootCategoryDeleted).toBe(false);
        });

        test("returns zeros when SalesChannel not found", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockSearchResponse("sales-channel", { data: [], total: 0 });

            const result = await cleanup.cleanupSalesChannel("nonexistent");

            expect(result.products).toBe(0);
            expect(result.categories).toBe(0);
            expect(result.propertyGroups).toBe(0);
        });

        test("deletes SalesChannel when option is set", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockSearchResponse("sales-channel", {
                data: [{ id: "sc-123", navigationCategoryId: "cat-root" }],
                total: 1,
            });
            mockClient.mockSearchResponse("product", { data: [], total: 0 });
            mockClient.mockSearchResponse("category", { data: [], total: 0 });

            const result = await cleanup.cleanupSalesChannel("test-store", {
                deleteSalesChannel: true,
            });

            expect(result.salesChannelDeleted).toBe(true);
            expect(result.rootCategoryDeleted).toBe(true);

            // Verify delete calls via invoke
            const deleteCalls = mockClient.getCallsByOperation(" delete /");
            expect(
                deleteCalls.some((c) => {
                    const pathParams = (c.params as { pathParams?: { id?: string } })?.pathParams;
                    return pathParams?.id === "sc-123";
                })
            ).toBe(true);
            expect(
                deleteCalls.some((c) => {
                    const pathParams = (c.params as { pathParams?: { id?: string } })?.pathParams;
                    return pathParams?.id === "cat-root";
                })
            ).toBe(true);
        });
    });

    // =========================================================================
    // Tests: deletePropertyGroups
    // =========================================================================

    describe("deletePropertyGroups", () => {
        test("deletes property groups by name", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockSearchResponse("property-group", {
                data: [{ id: "pg-1" }, { id: "pg-2" }],
                total: 2,
            });

            const count = await cleanup.deletePropertyGroups(["Color", "Size"]);

            // Called twice, 2 groups found each time = 4 total
            expect(count).toBe(4);
        });

        test("returns 0 when no property groups found", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockSearchResponse("property-group", { data: [], total: 0 });

            const count = await cleanup.deletePropertyGroups(["NonexistentGroup"]);

            expect(count).toBe(0);
        });
    });

    // =========================================================================
    // Tests: deleteSalesChannel
    // =========================================================================

    describe("deleteSalesChannel", () => {
        test("deletes SalesChannel by ID", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            const result = await cleanup.deleteSalesChannel("sc-123");

            expect(result).toBe(true);

            const deleteCalls = mockClient.getCallsByOperation("deleteSalesChannel delete");
            expect(deleteCalls.length).toBe(1);
            const pathParams = (deleteCalls[0]?.params as { pathParams?: { id?: string } })
                ?.pathParams;
            expect(pathParams?.id).toBe("sc-123");
        });

        test("returns false on delete error", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockDeleteError("sc-123", new Error("Cannot delete"));

            const result = await cleanup.deleteSalesChannel("sc-123");

            expect(result).toBe(false);
        });
    });

    // =========================================================================
    // Tests: Authentication guard
    // =========================================================================

    describe("authentication guard", () => {
        test("deleteProductsByCategory returns 0 when not authenticated", async () => {
            const cleanup = new ShopwareCleanup();
            const result = await cleanup.deleteProductsByCategory("test");
            expect(result).toBe(0);
        });

        test("deleteCategory returns false when not authenticated", async () => {
            const cleanup = new ShopwareCleanup();
            const result = await cleanup.deleteCategory("test");
            expect(result).toBe(false);
        });

        test("deletePropertyGroups returns 0 when not authenticated", async () => {
            const cleanup = new ShopwareCleanup();
            const result = await cleanup.deletePropertyGroups(["test"]);
            expect(result).toBe(0);
        });

        test("deleteAllPropertyGroups returns 0 when not authenticated", async () => {
            const cleanup = new ShopwareCleanup();
            const result = await cleanup.deleteAllPropertyGroups();
            expect(result).toBe(0);
        });

        test("deleteOrphanedProductMedia returns 0 when not authenticated", async () => {
            const cleanup = new ShopwareCleanup();
            const result = await cleanup.deleteOrphanedProductMedia();
            expect(result).toBe(0);
        });

        test("deleteProductsInSalesChannel returns 0 when not authenticated", async () => {
            const cleanup = new ShopwareCleanup();
            const result = await cleanup.deleteProductsInSalesChannel("sc-123");
            expect(result).toBe(0);
        });

        test("deleteCategoriesUnderRoot returns 0 when not authenticated", async () => {
            const cleanup = new ShopwareCleanup();
            const result = await cleanup.deleteCategoriesUnderRoot("root");
            expect(result).toBe(0);
        });

        test("deleteSalesChannel returns false when not authenticated", async () => {
            const cleanup = new ShopwareCleanup();
            const result = await cleanup.deleteSalesChannel("sc-123");
            expect(result).toBe(false);
        });

        test("deleteRootCategory returns false when not authenticated", async () => {
            const cleanup = new ShopwareCleanup();
            const result = await cleanup.deleteRootCategory("cat-123");
            expect(result).toBe(false);
        });

        test("deleteUnusedPropertyGroups returns 0 when not authenticated", async () => {
            const cleanup = new ShopwareCleanup();
            expect(await cleanup.deleteUnusedPropertyGroups()).toBe(0);
        });

        test("deleteUnusedPropertyOptions returns 0 when not authenticated", async () => {
            const cleanup = new ShopwareCleanup();
            expect(await cleanup.deleteUnusedPropertyOptions()).toBe(0);
        });
    });
});

// =============================================================================
// Helpers for the detailed tests below
// =============================================================================

type MockClient = ReturnType<typeof createMockAdminClient>;

interface SyncOperationBody {
    entity: string;
    action: string;
    payload: Array<{ id: string }>;
}

function syncOperations(mockClient: MockClient): SyncOperationBody[] {
    return mockClient
        .getCallsByOperation("sync post")
        .flatMap((c) => (c.params as { body: SyncOperationBody[] }).body);
}

function searchBody(mockClient: MockClient, pattern: string): Record<string, unknown> {
    const call = mockClient.getCallsByOperation(pattern)[0];
    return (call?.params as { body: Record<string, unknown> } | undefined)?.body ?? {};
}

function deletedPathIds(mockClient: MockClient): string[] {
    return mockClient
        .getCallsByOperation(" delete /")
        .map((c) => (c.params as { pathParams: { id: string } }).pathParams.id);
}

function makeMedia(count: number, prefix = "media"): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_, i) => ({
        id: `${prefix}-${i}`,
        fileName: `${prefix}-file-${i}`,
        mediaFolderId: null,
        productMedia: [],
    }));
}

describe("ShopwareCleanup orphaned media details", () => {
    test("searches the product media folder and media without folder", async () => {
        const { cleanup, mockClient } = createTestableCleanup();
        mockClient.mockSearchResponse("media", { data: [], total: 0 });

        await cleanup.deleteOrphanedProductMedia(true);

        const body = searchBody(mockClient, "searchMedia");
        expect(body.filter).toEqual([
            {
                type: "or",
                queries: [
                    { type: "equals", field: "mediaFolderId", value: "product-media-folder-id" },
                    { type: "equals", field: "mediaFolderId", value: null },
                ],
            },
        ]);
        expect(body.associations).toEqual({ productMedia: {} });
    });

    test("only searches media without folder when there is no product media folder", async () => {
        const { cleanup, mockClient } = createTestableCleanup();
        (
            cleanup as unknown as { getProductMediaFolderId: () => Promise<string | null> }
        ).getProductMediaFolderId = async () => null;
        mockClient.mockSearchResponse("media", { data: [], total: 0 });

        await cleanup.deleteOrphanedProductMedia(true);

        const body = searchBody(mockClient, "searchMedia");
        expect(body.filter).toEqual([
            { type: "or", queries: [{ type: "equals", field: "mediaFolderId", value: null }] },
        ]);
    });

    test("returns 0 without deleting when every media is linked to a product", async () => {
        const { cleanup, mockClient } = createTestableCleanup();
        mockClient.mockSearchResponse("media", {
            data: [{ id: "m-1", fileName: "a", mediaFolderId: null, productMedia: [{ id: "pm" }] }],
            total: 1,
        });

        expect(await cleanup.deleteOrphanedProductMedia(false)).toBe(0);
        expect(deletedPathIds(mockClient)).toEqual([]);
    });

    test("treats media without productMedia association as orphaned", async () => {
        const { cleanup, mockClient } = createTestableCleanup();
        mockClient.mockSearchResponse("media", {
            data: [{ id: "m-1", fileName: "a", mediaFolderId: "f" }],
            total: 1,
        });

        expect(await cleanup.deleteOrphanedProductMedia(false)).toBe(1);
        expect(deletedPathIds(mockClient)).toEqual(["m-1"]);
    });

    test("dry run with many orphans returns the full count", async () => {
        const { cleanup, mockClient } = createTestableCleanup();
        mockClient.mockSearchResponse("media", { data: makeMedia(25), total: 25 });

        expect(await cleanup.deleteOrphanedProductMedia(true)).toBe(25);
        expect(deletedPathIds(mockClient)).toEqual([]);
    });

    test("counts only successful deletes and keeps going after failures", async () => {
        const { cleanup, mockClient } = createTestableCleanup();
        mockClient.mockSearchResponse("media", { data: makeMedia(4), total: 4 });
        mockClient.mockDeleteError("media-0", new Error("Request failed with 409"));
        mockClient.mockDeleteError("media-1", new Error("media is in use"));
        mockClient.mockDeleteError("media-2", new Error("server exploded"));

        const deleted = await cleanup.deleteOrphanedProductMedia(false);

        expect(deleted).toBe(1);
        expect(deletedPathIds(mockClient)).toEqual(["media-0", "media-1", "media-2", "media-3"]);
    });

    test("handles non-Error rejections from delete", async () => {
        const { cleanup, mockClient } = createTestableCleanup();
        mockClient.mockSearchResponse("media", { data: makeMedia(1), total: 1 });
        mockClient.mockDeleteError("media-0", "plain string" as unknown as Error);

        expect(await cleanup.deleteOrphanedProductMedia(false)).toBe(0);
    });
});

describe("ShopwareCleanup unused property groups", () => {
    function setup(groups: unknown[], products: unknown[]) {
        const { cleanup, mockClient } = createTestableCleanup();
        mockClient.mockSearchResponse("property-group", { data: groups, total: groups.length });
        mockClient.mockSearchResponse("product", { data: products, total: products.length });
        return { cleanup, mockClient };
    }

    test("returns 0 without loading products when there are no groups", async () => {
        const { cleanup, mockClient } = setup([], []);

        expect(await cleanup.deleteUnusedPropertyGroups()).toBe(0);
        expect(mockClient.getCallsByOperation("searchProduct")).toHaveLength(0);
        expect(syncOperations(mockClient)).toEqual([]);
    });

    test("loads groups with options and products with properties and options", async () => {
        const { cleanup, mockClient } = setup([{ id: "g", name: "G", options: [] }], []);

        await cleanup.deleteUnusedPropertyGroups(true);

        expect(searchBody(mockClient, "searchPropertyGroup").associations).toEqual({
            options: {},
        });
        expect(searchBody(mockClient, "searchProduct").associations).toEqual({
            properties: {},
            options: {},
        });
    });

    test("deletes groups whose options are not used by any product", async () => {
        const { cleanup, mockClient } = setup(
            [
                { id: "used-by-property", name: "A", options: [{ id: "o-1", name: "x" }] },
                { id: "used-by-option", name: "B", options: [{ id: "o-2", name: "y" }] },
                { id: "unused", name: "C", options: [{ id: "o-3", name: "z" }] },
                { id: "empty", name: "D", options: [] },
                { id: "no-options", name: "E" },
            ],
            [
                { id: "p-1", properties: [{ id: "o-1" }] },
                { id: "p-2", options: [{ id: "o-2" }] },
                { id: "p-3" },
            ]
        );

        const deleted = await cleanup.deleteUnusedPropertyGroups(false);

        expect(deleted).toBe(3);
        expect(syncOperations(mockClient)).toEqual([
            {
                entity: "property_group",
                action: "delete",
                payload: [{ id: "unused" }, { id: "empty" }, { id: "no-options" }],
            },
        ]);
    });

    test("returns 0 when all groups are in use", async () => {
        const { cleanup, mockClient } = setup(
            [{ id: "g", name: "G", options: [{ id: "o-1", name: "x" }] }],
            [{ id: "p", properties: [{ id: "o-1" }], options: [{ id: "o-1" }] }]
        );

        expect(await cleanup.deleteUnusedPropertyGroups(false)).toBe(0);
        expect(syncOperations(mockClient)).toEqual([]);
    });

    test("dry run returns the count without deleting", async () => {
        const { cleanup, mockClient } = setup([{ id: "g", name: "G", options: [] }], []);

        expect(await cleanup.deleteUnusedPropertyGroups(true)).toBe(1);
        expect(syncOperations(mockClient)).toEqual([]);
    });

    test("deletes in batches of 50", async () => {
        const groups = Array.from({ length: 120 }, (_, i) => ({ id: `g-${i}`, name: `G${i}` }));
        const { cleanup, mockClient } = setup(groups, []);

        expect(await cleanup.deleteUnusedPropertyGroups(false)).toBe(120);
        expect(syncOperations(mockClient).map((op) => op.payload.length)).toEqual([50, 50, 20]);
        expect(syncOperations(mockClient)[2]?.payload[0]).toEqual({ id: "g-100" });
    });
});

describe("ShopwareCleanup unused property options", () => {
    function setup(options: unknown[], products: unknown[]) {
        const { cleanup, mockClient } = createTestableCleanup();
        mockClient.mockSearchResponse("property-group-option", {
            data: options,
            total: options.length,
        });
        mockClient.mockSearchResponse("product", { data: products, total: products.length });
        return { cleanup, mockClient };
    }

    test("returns 0 without loading products when there are no options", async () => {
        const { cleanup, mockClient } = setup([], []);

        expect(await cleanup.deleteUnusedPropertyOptions()).toBe(0);
        expect(mockClient.getCallsByOperation("searchProduct")).toHaveLength(0);
    });

    test("loads options with their group", async () => {
        const { cleanup, mockClient } = setup([{ id: "o", name: "x" }], []);

        await cleanup.deleteUnusedPropertyOptions(true);

        expect(searchBody(mockClient, "searchPropertyGroupOption").associations).toEqual({
            group: {},
        });
    });

    test("deletes options not used as property or variant option", async () => {
        const { cleanup, mockClient } = setup(
            [
                { id: "o-1", name: "Red", group: { name: "Color" } },
                { id: "o-2", name: "Blue", group: { name: "Color" } },
                { id: "o-3", name: "XL" },
                { id: "o-4", name: "Wood", group: { name: "Material" } },
            ],
            [
                { id: "p-1", properties: [{ id: "o-1" }] },
                { id: "p-2", options: [{ id: "o-4" }] },
            ]
        );

        const deleted = await cleanup.deleteUnusedPropertyOptions(false);

        expect(deleted).toBe(2);
        expect(syncOperations(mockClient)).toEqual([
            {
                entity: "property_group_option",
                action: "delete",
                payload: [{ id: "o-2" }, { id: "o-3" }],
            },
        ]);
    });

    test("returns 0 when every option is used", async () => {
        const { cleanup, mockClient } = setup(
            [{ id: "o-1", name: "Red" }],
            [{ id: "p", options: [{ id: "o-1" }] }]
        );

        expect(await cleanup.deleteUnusedPropertyOptions(false)).toBe(0);
        expect(syncOperations(mockClient)).toEqual([]);
    });

    test("dry run returns the count without deleting", async () => {
        const { cleanup, mockClient } = setup([{ id: "o-1", name: "Red" }], []);

        expect(await cleanup.deleteUnusedPropertyOptions(true)).toBe(1);
        expect(syncOperations(mockClient)).toEqual([]);
    });

    test("deletes in batches of 100", async () => {
        const options = Array.from({ length: 250 }, (_, i) => ({ id: `o-${i}`, name: `O${i}` }));
        const { cleanup, mockClient } = setup(options, []);

        expect(await cleanup.deleteUnusedPropertyOptions(false)).toBe(250);
        expect(syncOperations(mockClient).map((op) => op.payload.length)).toEqual([100, 100, 50]);
        expect(syncOperations(mockClient)[1]?.payload[0]).toEqual({ id: "o-100" });
    });
});

describe("ShopwareCleanup cleanupSalesChannel steps", () => {
    function setup() {
        const { cleanup, mockClient } = createTestableCleanup();
        mockClient.mockSearchResponse("sales-channel", {
            data: [{ id: "sc-1", navigationCategoryId: "root-1" }],
            total: 1,
        });
        const steps: string[] = [];
        cleanup.deleteProductsInSalesChannel = async (id: string) => {
            steps.push(`products:${id}`);
            return 2;
        };
        cleanup.deleteCategoriesUnderRoot = async (id: string) => {
            steps.push(`categories:${id}`);
            return 3;
        };
        cleanup.deleteSalesChannel = async (id: string) => {
            steps.push(`sales-channel:${id}`);
            return true;
        };
        cleanup.deleteRootCategory = async (id: string) => {
            steps.push(`root:${id}`);
            return true;
        };
        cleanup.deleteAllPropertyGroups = async () => {
            steps.push("property-groups");
            return 4;
        };
        return { cleanup, steps };
    }

    test("runs all steps in dependency order", async () => {
        const { cleanup, steps } = setup();

        const result = await cleanup.cleanupSalesChannel("store", {
            deletePropertyGroups: true,
            deleteSalesChannel: true,
            deleteManufacturers: true,
        });

        expect(steps).toEqual([
            "products:sc-1",
            "categories:root-1",
            "sales-channel:sc-1",
            "root:root-1",
            "property-groups",
        ]);
        expect(result).toEqual({
            products: 2,
            categories: 3,
            propertyGroups: 4,
            manufacturers: 0,
            salesChannelDeleted: true,
            rootCategoryDeleted: true,
            errors: [],
        });
    });

    test("skips optional steps by default", async () => {
        const { cleanup, steps } = setup();

        await cleanup.cleanupSalesChannel("store");

        expect(steps).toEqual(["products:sc-1", "categories:root-1"]);
    });

    test("keeps the root category when the SalesChannel could not be deleted", async () => {
        const { cleanup, steps } = setup();
        cleanup.deleteSalesChannel = async () => false;

        const result = await cleanup.cleanupSalesChannel("store", { deleteSalesChannel: true });

        expect(steps).not.toContain("root:root-1");
        expect(result.salesChannelDeleted).toBe(false);
        expect(result.rootCategoryDeleted).toBe(false);
    });

    test("collects errors per step and continues with the next step", async () => {
        const { cleanup, steps } = setup();
        cleanup.deleteProductsInSalesChannel = async () => {
            throw new Error("products down");
        };
        cleanup.deleteCategoriesUnderRoot = async () => {
            throw "categories down";
        };
        cleanup.deleteSalesChannel = async () => {
            throw new Error("sc down");
        };
        cleanup.deleteAllPropertyGroups = async () => {
            throw new Error("groups down");
        };

        const result = await cleanup.cleanupSalesChannel("store", {
            deleteSalesChannel: true,
            deletePropertyGroups: true,
        });

        expect(steps).toEqual([]);
        expect(result.errors).toEqual([
            "Failed to delete products: products down",
            "Failed to delete categories: categories down",
            "Failed to delete SalesChannel: sc down",
            "Failed to delete property groups: groups down",
        ]);
        expect(result.products).toBe(0);
        expect(result.categories).toBe(0);
        expect(result.propertyGroups).toBe(0);
    });

    test("keeps salesChannelDeleted when the root category delete throws", async () => {
        const { cleanup } = setup();
        cleanup.deleteRootCategory = async () => {
            throw new Error("root down");
        };

        const result = await cleanup.cleanupSalesChannel("store", { deleteSalesChannel: true });

        expect(result.salesChannelDeleted).toBe(true);
        expect(result.rootCategoryDeleted).toBe(false);
        expect(result.errors).toEqual(["Failed to delete SalesChannel: root down"]);
    });
});
