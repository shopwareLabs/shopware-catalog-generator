/**
 * Unit tests for shopware/cleanup module
 */

import { describe, expect, mock, test } from "bun:test";

import { ShopwareCleanup } from "../../../src/shopware/cleanup.js";

// =============================================================================
// Test Setup
// =============================================================================

/**
 * Create a mock apiClient for testing
 */
function createMockApiClient() {
    const postResponses = new Map<string, unknown>();
    const deleteResponses = new Map<string, unknown>();
    const calls: Array<{ method: string; endpoint: string; body?: unknown }> = [];

    return {
        calls,
        postResponses,
        deleteResponses,

        post: mock(async <T>(endpoint: string, body?: unknown): Promise<{ data: T }> => {
            calls.push({ method: "post", endpoint, body });
            const response = postResponses.get(endpoint);
            if (response !== undefined) {
                return { data: response as T };
            }
            // Default empty response
            return { data: { total: 0, data: [] } as T };
        }),

        delete: mock(async (endpoint: string): Promise<void> => {
            calls.push({ method: "delete", endpoint });
            const error = deleteResponses.get(endpoint);
            if (error instanceof Error) {
                throw error;
            }
        }),

        // Helper to set response for a specific endpoint
        mockResponse(endpoint: string, response: unknown) {
            postResponses.set(endpoint, response);
        },

        // Helper to set delete error
        mockDeleteError(endpoint: string, error: Error) {
            deleteResponses.set(endpoint, error);
        },

        // Get calls by endpoint
        getCallsByEndpoint(pattern: string) {
            return calls.filter((c) => c.endpoint.includes(pattern));
        },

        // Reset
        reset() {
            calls.length = 0;
            postResponses.clear();
            deleteResponses.clear();
        },
    };
}

/**
 * Create a testable ShopwareCleanup instance with mocked internals
 */
function createTestableCleanup() {
    const cleanup = new ShopwareCleanup();
    const mockClient = createMockApiClient();

    // Override the apiClient with our mock
    (cleanup as unknown as { apiClient: typeof mockClient }).apiClient = mockClient;

    // Override isAuthenticated to return true
    (cleanup as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => true;

    // Override capitalizeString (it's a protected method on ShopwareClient)
    (cleanup as unknown as { capitalizeString: (s: string) => string }).capitalizeString = (
        s: string
    ) => s.charAt(0).toUpperCase() + s.slice(1);

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

            mockClient.mockResponse("search/sales-channel", {
                total: 1,
                data: [{ id: "sc-123", navigationCategoryId: "cat-root" }],
            });

            const result = await cleanup.getSalesChannelByName("digital_invitations");

            expect(result).not.toBeNull();
            expect(result?.id).toBe("sc-123");
            expect(result?.navigationCategoryId).toBe("cat-root");
        });

        test("returns null when SalesChannel not found", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockResponse("search/sales-channel", { total: 0, data: [] });

            const result = await cleanup.getSalesChannelByName("nonexistent");

            expect(result).toBeNull();
        });

        test("returns null when not authenticated", async () => {
            const cleanup = new ShopwareCleanup();
            // Not authenticated by default

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

            mockClient.mockResponse("search/product", {
                total: 3,
                data: [
                    { id: "prod-1", name: "Product 1" },
                    { id: "prod-2", name: "Product 2" },
                    { id: "prod-3", name: "Product 3" },
                ],
            });

            const count = await cleanup.deleteProductsInSalesChannel("sc-123");

            expect(count).toBe(3);

            // Verify sync was called with delete payload
            const syncCalls = mockClient.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBe(1);

            const syncBody = syncCalls[0]?.body as Record<string, unknown>;
            const deleteProducts = syncBody?.deleteProducts as {
                entity: string;
                action: string;
                payload: Array<{ id: string }>;
            };
            expect(deleteProducts.entity).toBe("product");
            expect(deleteProducts.action).toBe("delete");
            expect(deleteProducts.payload).toHaveLength(3);
        });

        test("returns 0 when no products found", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockResponse("search/product", { total: 0, data: [] });

            const count = await cleanup.deleteProductsInSalesChannel("sc-123");

            expect(count).toBe(0);

            // No sync call should be made
            const syncCalls = mockClient.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBe(0);
        });
    });

    // =========================================================================
    // Tests: deleteCategoriesUnderRoot
    // =========================================================================

    describe("deleteCategoriesUnderRoot", () => {
        test("deletes all child categories", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockResponse("search/category", {
                total: 5,
                data: [
                    { id: "cat-1", name: "Category 1", parentId: "root" },
                    { id: "cat-2", name: "Category 2", parentId: "root" },
                    { id: "cat-3", name: "Category 3", parentId: "cat-1" },
                    { id: "cat-4", name: "Category 4", parentId: "cat-1" },
                    { id: "cat-5", name: "Category 5", parentId: "cat-2" },
                ],
            });

            const count = await cleanup.deleteCategoriesUnderRoot("root");

            expect(count).toBe(5);

            // Verify sync was called with delete payload
            const syncCalls = mockClient.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBe(1);
        });

        test("returns 0 when no child categories", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockResponse("search/category", { total: 0, data: [] });

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

            // Mock media search - some with productMedia, some without
            mockClient.mockResponse("search/media", {
                total: 3,
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
            });

            const count = await cleanup.deleteOrphanedProductMedia(true);

            // Should report 2 orphaned (media-1 and media-3 have no productMedia)
            expect(count).toBe(2);

            // No delete calls should be made in dry run
            const deleteCalls = mockClient.calls.filter((c) => c.method === "delete");
            expect(deleteCalls.length).toBe(0);
        });

        test("actual run deletes orphaned media", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockResponse("search/media", {
                total: 2,
                data: [
                    {
                        id: "media-1",
                        fileName: "orphan-1",
                        mediaFolderId: "folder-1",
                        productMedia: [],
                    },
                    { id: "media-2", fileName: "orphan-2", mediaFolderId: null, productMedia: [] },
                ],
            });

            const count = await cleanup.deleteOrphanedProductMedia(false);

            expect(count).toBe(2);

            // Verify delete calls were made
            const deleteCalls = mockClient.calls.filter((c) => c.method === "delete");
            expect(deleteCalls.length).toBe(2);
        });
    });

    // =========================================================================
    // Tests: cleanupSalesChannel
    // =========================================================================

    describe("cleanupSalesChannel", () => {
        test("cleans up products and categories for SalesChannel", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            // Mock getSalesChannelByName
            mockClient.mockResponse("search/sales-channel", {
                total: 1,
                data: [{ id: "sc-123", navigationCategoryId: "cat-root" }],
            });

            // Mock products
            mockClient.mockResponse("search/product", {
                total: 2,
                data: [
                    { id: "prod-1", name: "Product 1" },
                    { id: "prod-2", name: "Product 2" },
                ],
            });

            // Mock categories
            mockClient.mockResponse("search/category", {
                total: 3,
                data: [
                    { id: "cat-1", name: "Cat 1", parentId: "cat-root" },
                    { id: "cat-2", name: "Cat 2", parentId: "cat-root" },
                    { id: "cat-3", name: "Cat 3", parentId: "cat-1" },
                ],
            });

            const result = await cleanup.cleanupSalesChannel("test-store");

            expect(result.products).toBe(2);
            expect(result.categories).toBe(3);
            expect(result.salesChannelDeleted).toBe(false);
            expect(result.rootCategoryDeleted).toBe(false);
        });

        test("returns zeros when SalesChannel not found", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockResponse("search/sales-channel", { total: 0, data: [] });

            const result = await cleanup.cleanupSalesChannel("nonexistent");

            expect(result.products).toBe(0);
            expect(result.categories).toBe(0);
            expect(result.propertyGroups).toBe(0);
        });

        test("deletes SalesChannel when option is set", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockResponse("search/sales-channel", {
                total: 1,
                data: [{ id: "sc-123", navigationCategoryId: "cat-root" }],
            });
            mockClient.mockResponse("search/product", { total: 0, data: [] });
            mockClient.mockResponse("search/category", { total: 0, data: [] });

            const result = await cleanup.cleanupSalesChannel("test-store", {
                deleteSalesChannel: true,
            });

            expect(result.salesChannelDeleted).toBe(true);
            expect(result.rootCategoryDeleted).toBe(true);

            // Verify delete calls
            const deleteCalls = mockClient.calls.filter((c) => c.method === "delete");
            expect(deleteCalls.some((c) => c.endpoint.includes("sales-channel/sc-123"))).toBe(true);
            expect(deleteCalls.some((c) => c.endpoint.includes("category/cat-root"))).toBe(true);
        });
    });

    // =========================================================================
    // Tests: deletePropertyGroups
    // =========================================================================

    describe("deletePropertyGroups", () => {
        test("deletes property groups by name", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockResponse("search/property-group", {
                total: 2,
                data: [{ id: "pg-1" }, { id: "pg-2" }],
            });

            const count = await cleanup.deletePropertyGroups(["Color", "Size"]);

            // Called twice, 2 groups found each time = 4 total
            // Actually, our mock returns the same response for all calls
            expect(count).toBe(4);
        });

        test("returns 0 when no property groups found", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockResponse("search/property-group", { total: 0, data: [] });

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

            const deleteCalls = mockClient.calls.filter((c) => c.method === "delete");
            expect(deleteCalls.some((c) => c.endpoint === "sales-channel/sc-123")).toBe(true);
        });

        test("returns false on delete error", async () => {
            const { cleanup, mockClient } = createTestableCleanup();

            mockClient.mockDeleteError("sales-channel/sc-123", new Error("Cannot delete"));

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
