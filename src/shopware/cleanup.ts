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
     * @param dryRun - If true, only report what would be deleted without actually deleting
     * @returns Number of deleted (or would-be-deleted) media files
     */
    async deleteOrphanedProductMedia(dryRun = false): Promise<number> {
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

        // Find all matching media with their productMedia associations (paginated)
        interface MediaItem {
            id: string;
            fileName: string;
            mediaFolderId: string | null;
            productMedia?: { id: string }[];
        }

        const allMedia = await this.fetchAllPages<MediaItem>("search/media", {
            filter: [{ type: "or", queries: filters }],
            associations: {
                productMedia: {},
            },
        });

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

        if (dryRun) {
            console.log(`[DRY RUN] Would delete ${orphanedMedia.length} orphaned media files:`);
            for (const media of orphanedMedia.slice(0, 20)) {
                const folder = media.mediaFolderId ? "Product Media" : "no folder";
                console.log(`  - ${media.fileName} (${folder})`);
            }
            if (orphanedMedia.length > 20) {
                console.log(`  ... and ${orphanedMedia.length - 20} more`);
            }
            return orphanedMedia.length;
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
     * Normalize a SalesChannel name for lookup
     * Converts underscores to hyphens and capitalizes first letter
     */
    private normalizeSalesChannelName(name: string): string {
        // Convert underscores to hyphens (common user input variation)
        const normalized = name.replace(/_/g, "-");
        // Capitalize first letter only (SalesChannel names are like "Digital-invitations")
        return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
    }

    /**
     * Get a SalesChannel by name
     * Handles common variations: underscores vs hyphens, case differences
     * @returns The SalesChannel details or null if not found
     */
    async getSalesChannelByName(
        name: string
    ): Promise<{ id: string; navigationCategoryId: string } | null> {
        if (!this.isAuthenticated()) {
            console.error("Client is not authenticated.");
            return null;
        }

        // Try multiple name variations to find the SalesChannel
        const variations = [
            this.normalizeSalesChannelName(name), // "digital_invitations" → "Digital-invitations"
            this.capitalizeString(name), // Original behavior: "Digital_invitations"
            name, // Exact match as provided
        ];

        // Remove duplicates
        const uniqueVariations = [...new Set(variations)];

        for (const variation of uniqueVariations) {
            const response = await this.apiClient.post<
                SearchResponse<{ id: string; navigationCategoryId: string }>
            >("search/sales-channel", {
                limit: 1,
                filter: [{ type: "equals", field: "name", value: variation }],
            });

            const salesChannel = response.data.data[0];
            if (response.data.total > 0 && salesChannel) {
                return salesChannel;
            }
        }

        return null;
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

    // =========================================================================
    // Orphaned Entity Cleanup Methods
    // =========================================================================

    /**
     * Fetch all entities with pagination
     * @param endpoint - Search endpoint (e.g., "search/product-review")
     * @param options - Search options (filters, associations, includes)
     * @param pageSize - Number of items per page (default 500)
     * @returns All entities across all pages
     */
    private async fetchAllPages<T>(
        endpoint: string,
        options: Record<string, unknown> = {},
        pageSize = 500
    ): Promise<T[]> {
        const allItems: T[] = [];
        let page = 1;
        let hasMore = true;

        console.log(`  [Pagination] Starting fetch from ${endpoint}...`);

        while (hasMore) {
            const requestBody = {
                ...options,
                limit: pageSize,
                page,
                // CRITICAL: Shopware defaults to NOT returning total count!
                // Mode 1 = exact total, required for proper pagination
                "total-count-mode": 1,
            };

            console.log(`  [Pagination] Requesting page ${page} (limit: ${pageSize})...`);

            const response = await this.apiClient.post<SearchResponse<T>>(endpoint, requestBody);

            const items = response.data.data;
            const total = response.data.total;

            console.log(
                `  [Pagination] Page ${page}: received ${items.length} items, total reported: ${total}`
            );

            allItems.push(...items);

            // Check if there are more pages
            hasMore = allItems.length < total && items.length > 0;

            if (hasMore) {
                console.log(`  [Pagination] Fetched ${allItems.length}/${total}, continuing...`);
            }

            page++;

            // Safety: prevent infinite loops
            if (page > 100) {
                console.warn(`  [Pagination] Safety limit reached at page 100, stopping.`);
                break;
            }
        }

        console.log(`  [Pagination] Complete: ${allItems.length} total items fetched.`);
        return allItems;
    }

    /**
     * Collect all used property option IDs from products (with pagination)
     * Checks both product.properties (filterable attributes) and product.options (variant configurator)
     */
    private async collectUsedPropertyOptionIds(): Promise<Set<string>> {
        interface ProductWithPropertiesAndOptions {
            id: string;
            properties?: Array<{ id: string }>;
            options?: Array<{ id: string }>;
        }

        console.log("  Collecting used property options from products...");
        const allProducts = await this.fetchAllPages<ProductWithPropertiesAndOptions>(
            "search/product",
            {
                associations: {
                    properties: {},
                    options: {}, // Variant configurator options
                },
            }
        );

        const usedOptionIds = new Set<string>();
        let propertiesCount = 0;
        let optionsCount = 0;

        for (const product of allProducts) {
            // Check product.properties (filterable attributes)
            if (product.properties) {
                for (const prop of product.properties) {
                    if (!usedOptionIds.has(prop.id)) {
                        propertiesCount++;
                    }
                    usedOptionIds.add(prop.id);
                }
            }
            // Check product.options (variant configurator options)
            if (product.options) {
                for (const opt of product.options) {
                    if (!usedOptionIds.has(opt.id)) {
                        optionsCount++;
                    }
                    usedOptionIds.add(opt.id);
                }
            }
        }

        console.log(
            `  Found ${usedOptionIds.size} property options used by ${allProducts.length} products`
        );
        console.log(
            `    (${propertiesCount} from properties, ${optionsCount} from variant options)`
        );
        return usedOptionIds;
    }

    /**
     * Delete unused property groups - groups where none of their options are used by any product
     * @param dryRun - If true, only report what would be deleted without actually deleting
     * @returns Number of deleted (or would-be-deleted) property groups
     */
    async deleteUnusedPropertyGroups(dryRun = false): Promise<number> {
        if (!this.isAuthenticated()) {
            console.error("Client is not authenticated.");
            return 0;
        }

        console.log("Searching for unused property groups...");

        // Step 1: Get ALL property groups with their options (paginated)
        interface PropertyGroupItem {
            id: string;
            name: string;
            options?: Array<{ id: string; name: string }>;
        }

        const allGroups = await this.fetchAllPages<PropertyGroupItem>("search/property-group", {
            associations: { options: {} },
        });
        console.log(`Found ${allGroups.length} property groups`);

        if (allGroups.length === 0) {
            console.log("No property groups found.");
            return 0;
        }

        // Step 2: Get all option IDs that are actually used by products (paginated)
        const usedOptionIds = await this.collectUsedPropertyOptionIds();

        // Step 3: Find groups where NO options are used
        const unusedGroups = allGroups.filter((group) => {
            if (!group.options || group.options.length === 0) {
                return true; // No options = definitely unused
            }
            // Check if any option in this group is used
            const hasUsedOption = group.options.some((opt) => usedOptionIds.has(opt.id));
            return !hasUsedOption;
        });

        console.log(
            `${unusedGroups.length} property groups are unused (no options linked to products)`
        );

        if (unusedGroups.length === 0) {
            console.log("No unused property groups to delete.");
            return 0;
        }

        // Log which groups will be deleted
        for (const group of unusedGroups) {
            const optCount = group.options?.length ?? 0;
            console.log(`  - ${group.name} (${optCount} options)`);
        }

        if (dryRun) {
            console.log(`[DRY RUN] Would delete ${unusedGroups.length} unused property groups`);
            return unusedGroups.length;
        }

        console.log(`Deleting ${unusedGroups.length} unused property groups...`);

        // Delete in batches
        const deleteBatchSize = 50;
        let deleted = 0;

        for (let i = 0; i < unusedGroups.length; i += deleteBatchSize) {
            const batch = unusedGroups.slice(i, i + deleteBatchSize);
            const deletePayload = batch.map((g) => ({ id: g.id }));

            await this.apiClient.post("_action/sync", {
                deletePropertyGroups: {
                    entity: "property_group",
                    action: "delete",
                    payload: deletePayload,
                },
            });

            deleted += batch.length;
            if (unusedGroups.length > deleteBatchSize) {
                console.log(`  Deleted ${deleted}/${unusedGroups.length}...`);
            }
        }

        console.log(`Deleted ${unusedGroups.length} unused property groups.`);
        return unusedGroups.length;
    }

    /**
     * Delete unused property options - options not used by any product
     * Keeps the property group if it still has used options
     * @param dryRun - If true, only report what would be deleted without actually deleting
     * @returns Number of deleted (or would-be-deleted) property options
     */
    async deleteUnusedPropertyOptions(dryRun = false): Promise<number> {
        if (!this.isAuthenticated()) {
            console.error("Client is not authenticated.");
            return 0;
        }

        console.log("Searching for unused property options...");

        // Step 1: Get ALL property options (paginated)
        interface PropertyOptionItem {
            id: string;
            name: string;
            group?: { name: string };
        }

        const allOptions = await this.fetchAllPages<PropertyOptionItem>(
            "search/property-group-option",
            { associations: { group: {} } }
        );
        console.log(`Found ${allOptions.length} total property options`);

        if (allOptions.length === 0) {
            console.log("No property options found.");
            return 0;
        }

        // Step 2: Get all option IDs that are actually used by products (paginated)
        const usedOptionIds = await this.collectUsedPropertyOptionIds();

        // Step 3: Find unused options
        const unusedOptions = allOptions.filter((opt) => !usedOptionIds.has(opt.id));

        console.log(`${unusedOptions.length} property options are unused`);

        if (unusedOptions.length === 0) {
            console.log("No unused property options to delete.");
            return 0;
        }

        // Group by property group for logging
        const byGroup = new Map<string, string[]>();
        for (const opt of unusedOptions) {
            const groupName = opt.group?.name ?? "Unknown";
            const existing = byGroup.get(groupName) ?? [];
            existing.push(opt.name);
            byGroup.set(groupName, existing);
        }

        for (const [groupName, options] of byGroup) {
            console.log(`  - ${groupName}: ${options.length} unused options`);
        }

        if (dryRun) {
            console.log(`[DRY RUN] Would delete ${unusedOptions.length} unused property options`);
            return unusedOptions.length;
        }

        console.log(`Deleting ${unusedOptions.length} unused property options...`);

        // Delete in batches
        const deleteBatchSize = 100;
        let deleted = 0;

        for (let i = 0; i < unusedOptions.length; i += deleteBatchSize) {
            const batch = unusedOptions.slice(i, i + deleteBatchSize);
            const deletePayload = batch.map((o) => ({ id: o.id }));

            await this.apiClient.post("_action/sync", {
                deletePropertyOptions: {
                    entity: "property_group_option",
                    action: "delete",
                    payload: deletePayload,
                },
            });

            deleted += batch.length;
            if (unusedOptions.length > deleteBatchSize) {
                console.log(`  Deleted ${deleted}/${unusedOptions.length}...`);
            }
        }

        console.log(`Deleted ${unusedOptions.length} unused property options.`);
        return unusedOptions.length;
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
