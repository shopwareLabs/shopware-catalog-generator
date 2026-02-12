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
    });
});
