import { ShopwareClient } from "./client.js";

/** Common Shopware search response structure */
interface SearchResponse<T> {
    total: number;
    data: T[];
}

/**
 * Shopware cleanup operations - delete products, categories, property groups, and media
 */
export class ShopwareCleanup extends ShopwareClient {
    /**
     * Delete all products in a specific category
     * @returns Number of deleted products
     */
    async deleteProductsByCategory(categoryName: string): Promise<number> {
        if (!this.isAuthenticated()) {
            console.error("Client is not authenticated.");
            return 0;
        }

        // Find the category
        const categoryResponse = await this.apiClient.post<SearchResponse<{ id: string }>>(
            "search/category",
            {
                limit: 1,
                filter: [
                    {
                        type: "equals",
                        field: "name",
                        value: this.capitalizeString(categoryName),
                    },
                ],
            }
        );

        const category = categoryResponse.data.data[0];
        if (categoryResponse.data.total === 0 || !category) {
            console.log(`Category "${categoryName}" not found.`);
            return 0;
        }

        const categoryId = category.id;

        // Find all products in this category
        const productsResponse = await this.apiClient.post<
            SearchResponse<{ id: string; name: string }>
        >("search/product", {
            limit: 500,
            filter: [{ type: "equals", field: "categories.id", value: categoryId }],
        });

        const products = productsResponse.data.data;

        if (products.length === 0) {
            console.log(`No products found in category "${categoryName}".`);
            return 0;
        }

        console.log(`Deleting ${products.length} products from "${categoryName}"...`);

        // Delete products using sync API
        const deletePayload = products.map((p) => ({ id: p.id }));

        await this.apiClient.post("_action/sync", {
            deleteProducts: {
                entity: "product",
                action: "delete",
                payload: deletePayload,
            },
        });

        console.log(`Deleted ${products.length} products.`);
        return products.length;
    }

    /**
     * Delete a category by name
     * @returns true if deleted, false if not found
     */
    async deleteCategory(categoryName: string): Promise<boolean> {
        if (!this.isAuthenticated()) {
            console.error("Client is not authenticated.");
            return false;
        }

        const categoryResponse = await this.apiClient.post<SearchResponse<{ id: string }>>(
            "search/category",
            {
                limit: 1,
                filter: [
                    {
                        type: "equals",
                        field: "name",
                        value: this.capitalizeString(categoryName),
                    },
                ],
            }
        );

        const category = categoryResponse.data.data[0];
        if (categoryResponse.data.total === 0 || !category) {
            console.log(`Category "${categoryName}" not found.`);
            return false;
        }

        const categoryId = category.id;

        await this.apiClient.delete(`category/${categoryId}`);
        console.log(`Deleted category "${categoryName}".`);
        return true;
    }

    /**
     * Delete property groups by name
     * @returns Number of deleted property groups
     */
    async deletePropertyGroups(groupNames: string[]): Promise<number> {
        if (!this.isAuthenticated()) {
            console.error("Client is not authenticated.");
            return 0;
        }

        let deletedCount = 0;

        for (const name of groupNames) {
            const groupResponse = await this.apiClient.post<SearchResponse<{ id: string }>>(
                "search/property-group",
                {
                    limit: 100,
                    filter: [{ type: "equals", field: "name", value: name }],
                }
            );

            const groups = groupResponse.data.data;

            if (groups.length > 0) {
                const deletePayload = groups.map((g) => ({ id: g.id }));

                await this.apiClient.post("_action/sync", {
                    deletePropertyGroups: {
                        entity: "property_group",
                        action: "delete",
                        payload: deletePayload,
                    },
                });

                deletedCount += groups.length;
                console.log(`Deleted ${groups.length} property group(s) named "${name}".`);
            }
        }

        return deletedCount;
    }

    /**
     * Delete ALL property groups (use with caution!)
     * @returns Number of deleted property groups
     */
    async deleteAllPropertyGroups(): Promise<number> {
        if (!this.isAuthenticated()) {
            console.error("Client is not authenticated.");
            return 0;
        }

        const groupResponse = await this.apiClient.post<
            SearchResponse<{ id: string; name: string }>
        >("search/property-group", {
            limit: 500,
        });

        const groups = groupResponse.data.data;

        if (groups.length === 0) {
            console.log("No property groups found.");
            return 0;
        }

        console.log(`Deleting ${groups.length} property groups...`);

        const deletePayload = groups.map((g) => ({ id: g.id }));

        await this.apiClient.post("_action/sync", {
            deletePropertyGroups: {
                entity: "property_group",
                action: "delete",
                payload: deletePayload,
            },
        });

        console.log(`Deleted ${groups.length} property groups.`);
        return groups.length;
    }

    /**
     * Full cleanup: delete products, category, and optionally property groups
     */
    async cleanupCategory(
        categoryName: string,
        options: { deletePropertyGroups?: boolean } = {}
    ): Promise<{ products: number; category: boolean; propertyGroups: number }> {
        const result = { products: 0, category: false, propertyGroups: 0 };

        // Delete products first (they reference the category)
        result.products = await this.deleteProductsByCategory(categoryName);

        // Delete the category
        result.category = await this.deleteCategory(categoryName);

        // Optionally delete property groups (they might be shared across categories)
        if (options.deletePropertyGroups) {
            result.propertyGroups = await this.deleteAllPropertyGroups();
        }

        return result;
    }

    /**
     * Delete orphaned product media - media that is not used by any product
     * Looks for media that:
     * 1. Is in the Product Media folder with no product associations, OR
     * 2. Has no folder (uploaded before folder logic) with no product associations
     * @returns Number of deleted media files
     */
    async deleteOrphanedProductMedia(): Promise<number> {
        if (!this.isAuthenticated()) {
            console.error("Client is not authenticated.");
            return 0;
        }

        // Get the Product Media folder
        const productMediaFolderId = await this.getProductMediaFolderId();

        console.log("Searching for orphaned product media...");

        // Build filter: media in Product Media folder OR media with no folder
        const filters: Record<string, unknown>[] = [];

        if (productMediaFolderId) {
            filters.push({
                type: "equals",
                field: "mediaFolderId",
                value: productMediaFolderId,
            });
        }

        // Also find media with no folder (null mediaFolderId) - these are old uploads
        filters.push({ type: "equals", field: "mediaFolderId", value: null });

        // Find all matching media with their productMedia associations
        interface MediaItem {
            id: string;
            fileName: string;
            mediaFolderId: string | null;
            productMedia?: { id: string }[];
        }

        const mediaResponse = await this.apiClient.post<SearchResponse<MediaItem>>("search/media", {
            limit: 500,
            filter: [{ type: "or", queries: filters }],
            associations: {
                productMedia: {},
            },
        });

        const allMedia = mediaResponse.data.data;

        console.log(`Found ${allMedia.length} media files (in Product Media folder or no folder)`);

        // Filter to media that have NO productMedia associations (orphaned)
        const orphanedMedia = allMedia.filter(
            (media) => !media.productMedia || media.productMedia.length === 0
        );

        const usedCount = allMedia.length - orphanedMedia.length;
        console.log(`${usedCount} media files are linked to products (keeping)`);
        console.log(`${orphanedMedia.length} media files are orphaned (no product link)`);

        if (orphanedMedia.length === 0) {
            console.log("No orphaned media to delete.");
            return 0;
        }

        console.log(`Deleting ${orphanedMedia.length} orphaned media files...`);

        // Delete one by one to handle errors gracefully
        let deleted = 0;
        for (const media of orphanedMedia) {
            try {
                await this.apiClient.delete(`media/${media.id}`);
                deleted++;
                const folder = media.mediaFolderId ? "Product Media" : "no folder";
                console.log(`  Deleted: ${media.fileName} (${folder})`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (message.includes("409") || message.includes("in use")) {
                    console.log(`  Skipped (still in use elsewhere): ${media.fileName}`);
                } else {
                    console.log(`  Failed: ${media.fileName} - ${message}`);
                }
            }
        }

        console.log(`Deleted ${deleted}/${orphanedMedia.length} orphaned media files.`);
        return deleted;
    }

    // =========================================================================
    // SalesChannel-Centric Cleanup Methods
    // =========================================================================

    /**
     * Get a SalesChannel by name
     * @returns The SalesChannel details or null if not found
     */
    async getSalesChannelByName(
        name: string
    ): Promise<{ id: string; navigationCategoryId: string } | null> {
        if (!this.isAuthenticated()) {
            console.error("Client is not authenticated.");
            return null;
        }

        const response = await this.apiClient.post<
            SearchResponse<{ id: string; navigationCategoryId: string }>
        >("search/sales-channel", {
            limit: 1,
            filter: [{ type: "equals", field: "name", value: this.capitalizeString(name) }],
        });

        const salesChannel = response.data.data[0];
        if (response.data.total === 0 || !salesChannel) {
            return null;
        }

        return salesChannel;
    }

    /**
     * Delete all products visible in a SalesChannel
     * @param salesChannelId - The SalesChannel ID
     * @returns Number of deleted products
     */
    async deleteProductsInSalesChannel(salesChannelId: string): Promise<number> {
        if (!this.isAuthenticated()) {
            console.error("Client is not authenticated.");
            return 0;
        }

        console.log(`Finding products in SalesChannel...`);

        // Find all products with visibility in this SalesChannel
        const productsResponse = await this.apiClient.post<
            SearchResponse<{ id: string; name: string }>
        >("search/product", {
            limit: 500,
            filter: [
                { type: "equals", field: "visibilities.salesChannelId", value: salesChannelId },
            ],
        });

        const products = productsResponse.data.data;

        if (products.length === 0) {
            console.log(`No products found in SalesChannel.`);
            return 0;
        }

        console.log(`Deleting ${products.length} products from SalesChannel...`);

        // Delete products using sync API
        const deletePayload = products.map((p) => ({ id: p.id }));

        await this.apiClient.post("_action/sync", {
            deleteProducts: {
                entity: "product",
                action: "delete",
                payload: deletePayload,
            },
        });

        console.log(`Deleted ${products.length} products.`);
        return products.length;
    }

    /**
     * Delete all categories under a root category (the SalesChannel's navigation category)
     * @param rootCategoryId - The root category ID
     * @returns Number of deleted categories
     */
    async deleteCategoriesUnderRoot(rootCategoryId: string): Promise<number> {
        if (!this.isAuthenticated()) {
            console.error("Client is not authenticated.");
            return 0;
        }

        console.log(`Finding categories under root category...`);

        // Find all child categories (direct and nested)
        const categoriesResponse = await this.apiClient.post<
            SearchResponse<{ id: string; name: string; parentId: string | null }>
        >("search/category", {
            limit: 500,
            filter: [
                {
                    type: "multi",
                    operator: "or",
                    queries: [
                        { type: "equals", field: "parentId", value: rootCategoryId },
                        { type: "contains", field: "path", value: rootCategoryId },
                    ],
                },
            ],
        });

        const categories = categoriesResponse.data.data;

        if (categories.length === 0) {
            console.log(`No child categories found.`);
            return 0;
        }

        console.log(`Deleting ${categories.length} categories...`);

        // Delete categories using sync API (deepest first would be ideal, but sync handles it)
        const deletePayload = categories.map((c) => ({ id: c.id }));

        await this.apiClient.post("_action/sync", {
            deleteCategories: {
                entity: "category",
                action: "delete",
                payload: deletePayload,
            },
        });

        console.log(`Deleted ${categories.length} categories.`);
        return categories.length;
    }

    /**
     * Delete a SalesChannel by ID
     * @param salesChannelId - The SalesChannel ID
     * @returns true if deleted, false otherwise
     */
    async deleteSalesChannel(salesChannelId: string): Promise<boolean> {
        if (!this.isAuthenticated()) {
            console.error("Client is not authenticated.");
            return false;
        }

        try {
            await this.apiClient.delete(`sales-channel/${salesChannelId}`);
            console.log(`Deleted SalesChannel.`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Failed to delete SalesChannel: ${message}`);
            return false;
        }
    }

    /**
     * Delete the root category of a SalesChannel
     * @param categoryId - The root category ID
     * @returns true if deleted, false otherwise
     */
    async deleteRootCategory(categoryId: string): Promise<boolean> {
        if (!this.isAuthenticated()) {
            console.error("Client is not authenticated.");
            return false;
        }

        try {
            await this.apiClient.delete(`category/${categoryId}`);
            console.log(`Deleted root category.`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Failed to delete root category: ${message}`);
            return false;
        }
    }

    /**
     * Full SalesChannel cleanup: delete products, categories, and optionally the SalesChannel itself
     *
     * Note: Manufacturer cleanup is now handled by the ManufacturerProcessor.
     * Use `bun run cleanup -- --salesChannel="name" --processors=manufacturers` instead.
     *
     * @param salesChannelName - Name of the SalesChannel to clean up
     * @param options - Cleanup options
     */
    async cleanupSalesChannel(
        salesChannelName: string,
        options: {
            deletePropertyGroups?: boolean;
            deleteManufacturers?: boolean;
            deleteSalesChannel?: boolean;
        } = {}
    ): Promise<{
        products: number;
        categories: number;
        propertyGroups: number;
        manufacturers: number;
        salesChannelDeleted: boolean;
        rootCategoryDeleted: boolean;
    }> {
        const result = {
            products: 0,
            categories: 0,
            propertyGroups: 0,
            manufacturers: 0,
            salesChannelDeleted: false,
            rootCategoryDeleted: false,
        };

        // Find the SalesChannel
        const salesChannel = await this.getSalesChannelByName(salesChannelName);
        if (!salesChannel) {
            console.log(`SalesChannel "${salesChannelName}" not found.`);
            return result;
        }

        console.log(`Found SalesChannel "${salesChannelName}" (ID: ${salesChannel.id})`);

        // Delete all products in this SalesChannel
        result.products = await this.deleteProductsInSalesChannel(salesChannel.id);

        // Delete all categories under the root
        result.categories = await this.deleteCategoriesUnderRoot(salesChannel.navigationCategoryId);

        // Optionally delete property groups (they might be shared)
        if (options.deletePropertyGroups) {
            result.propertyGroups = await this.deleteAllPropertyGroups();
        }

        // Manufacturer cleanup is now handled by ManufacturerProcessor
        // Use --processors=manufacturers for SalesChannel-scoped manufacturer cleanup
        if (options.deleteManufacturers) {
            console.log(
                "Note: Manufacturer cleanup should be done via --processors=manufacturers for proper SalesChannel scoping."
            );
        }

        // Delete the SalesChannel and its root category if requested
        if (options.deleteSalesChannel) {
            result.salesChannelDeleted = await this.deleteSalesChannel(salesChannel.id);
            if (result.salesChannelDeleted) {
                result.rootCategoryDeleted = await this.deleteRootCategory(
                    salesChannel.navigationCategoryId
                );
            }
        }

        return result;
    }
}
