import type { Schemas } from "./admin-client.js";
import type { SearchResult } from "./api-types.js";

import { logger } from "../utils/index.js";
import { ShopwareClient } from "./client.js";

/**
 * Shopware cleanup operations - delete products, categories, property groups, and media.
 * Uses the official @shopware/api-client invoke() for all API calls.
 */
export class ShopwareCleanup extends ShopwareClient {
    /**
     * Delete all products in a specific category
     * @returns Number of deleted products
     */
    async deleteProductsByCategory(categoryName: string): Promise<number> {
        if (!this.isAuthenticated()) {
            return 0;
        }

        // Find the category
        const { data: categoryData } = await this.getClient().invoke(
            "searchCategory post /search/category",
            {
                body: {
                    limit: 1,
                    filter: [
                        {
                            type: "equals",
                            field: "name",
                            value: this.capitalizeString(categoryName),
                        },
                    ],
                },
            }
        );
        const categoryResult = categoryData as SearchResult<Schemas["Category"]>;
        const category = (categoryResult.data ?? [])[0];
        if (!category) {
            logger.info(`Category "${categoryName}" not found.`);
            return 0;
        }

        // Find all products in this category
        const { data: productsData } = await this.getClient().invoke(
            "searchProduct post /search/product",
            {
                body: {
                    limit: 500,
                    filter: [{ type: "equals", field: "categories.id", value: category.id }],
                },
            }
        );
        const productsResult = productsData as SearchResult<Schemas["Product"]>;
        const products = productsResult.data ?? [];

        if (products.length === 0) {
            logger.info(`No products found in category "${categoryName}".`);
            return 0;
        }

        logger.info(`Deleting ${products.length} products from "${categoryName}"...`);

        const deletePayload = products.map((p) => ({ id: p.id }));
        await this.sync([{ entity: "product", action: "delete", payload: deletePayload }]);

        logger.info(`Deleted ${products.length} products.`);
        return products.length;
    }

    /**
     * Delete a category by name
     * @returns true if deleted, false if not found
     */
    async deleteCategory(categoryName: string): Promise<boolean> {
        if (!this.isAuthenticated()) {
            return false;
        }

        const { data: categoryData } = await this.getClient().invoke(
            "searchCategory post /search/category",
            {
                body: {
                    limit: 1,
                    filter: [
                        {
                            type: "equals",
                            field: "name",
                            value: this.capitalizeString(categoryName),
                        },
                    ],
                },
            }
        );
        const categoryResult = categoryData as SearchResult<Schemas["Category"]>;
        const category = (categoryResult.data ?? [])[0];
        if (!category) {
            logger.info(`Category "${categoryName}" not found.`);
            return false;
        }

        await this.getClient().invoke("deleteCategory delete /category/{id}", {
            pathParams: { id: category.id },
        });
        logger.info(`Deleted category "${categoryName}".`);
        return true;
    }

    /**
     * Delete property groups by name
     * @returns Number of deleted property groups
     */
    async deletePropertyGroups(groupNames: string[]): Promise<number> {
        if (!this.isAuthenticated()) {
            return 0;
        }

        let deletedCount = 0;

        for (const name of groupNames) {
            const { data: groupData } = await this.getClient().invoke(
                "searchPropertyGroup post /search/property-group",
                {
                    body: {
                        limit: 100,
                        filter: [{ type: "equals", field: "name", value: name }],
                    },
                }
            );
            const groupResult = groupData as SearchResult<Schemas["PropertyGroup"]>;
            const groups = groupResult.data ?? [];

            if (groups.length > 0) {
                const deletePayload = groups.map((g) => ({ id: g.id }));
                await this.sync([
                    {
                        entity: "property_group",
                        action: "delete",
                        payload: deletePayload,
                    },
                ]);

                deletedCount += groups.length;
                logger.info(`Deleted ${groups.length} property group(s) named "${name}".`);
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
            return 0;
        }

        const { data: groupData } = await this.getClient().invoke(
            "searchPropertyGroup post /search/property-group",
            { body: { limit: 500 } }
        );
        const groupResult = groupData as SearchResult<Schemas["PropertyGroup"]>;
        const groups = groupResult.data ?? [];

        if (groups.length === 0) {
            logger.info("No property groups found.");
            return 0;
        }

        logger.info(`Deleting ${groups.length} property groups...`);

        const deletePayload = groups.map((g) => ({ id: g.id }));
        await this.sync([
            {
                entity: "property_group",
                action: "delete",
                payload: deletePayload,
            },
        ]);

        logger.info(`Deleted ${groups.length} property groups.`);
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
     * @param dryRun - If true, only report what would be deleted without actually deleting
     * @returns Number of deleted (or would-be-deleted) media files
     */
    async deleteOrphanedProductMedia(dryRun = false): Promise<number> {
        if (!this.isAuthenticated()) {
            return 0;
        }

        // Get the Product Media folder
        const productMediaFolderId = await this.getProductMediaFolderId();

        logger.info("Searching for orphaned product media...");

        // Build filter: media in Product Media folder OR media with no folder
        const filters: Record<string, unknown>[] = [];

        if (productMediaFolderId) {
            filters.push({
                type: "equals",
                field: "mediaFolderId",
                value: productMediaFolderId,
            });
        }

        // Also find media with no folder (null mediaFolderId)
        filters.push({ type: "equals", field: "mediaFolderId", value: null });

        interface MediaItem {
            id: string;
            fileName: string;
            mediaFolderId: string | null;
            productMedia?: { id: string }[];
        }

        const allMedia = await this.fetchAllPages<MediaItem>(
            async (body) => {
                const { data } = await this.getClient().invoke("searchMedia post /search/media", {
                    body,
                });
                return data as { data?: MediaItem[]; total?: number };
            },
            {
                filter: [{ type: "or", queries: filters }],
                associations: { productMedia: {} },
            }
        );

        logger.info(`Found ${allMedia.length} media files (in Product Media folder or no folder)`);

        // Filter to media that have NO productMedia associations (orphaned)
        const orphanedMedia = allMedia.filter(
            (media) => !media.productMedia || media.productMedia.length === 0
        );

        const usedCount = allMedia.length - orphanedMedia.length;
        logger.info(`${usedCount} media files are linked to products (keeping)`);
        logger.info(`${orphanedMedia.length} media files are orphaned (no product link)`);

        if (orphanedMedia.length === 0) {
            logger.info("No orphaned media to delete.");
            return 0;
        }

        if (dryRun) {
            logger.info(`[DRY RUN] Would delete ${orphanedMedia.length} orphaned media files:`);
            for (const media of orphanedMedia.slice(0, 20)) {
                const folder = media.mediaFolderId ? "Product Media" : "no folder";
                logger.info(`  - ${media.fileName} (${folder})`);
            }
            if (orphanedMedia.length > 20) {
                logger.info(`  ... and ${orphanedMedia.length - 20} more`);
            }
            return orphanedMedia.length;
        }

        logger.info(`Deleting ${orphanedMedia.length} orphaned media files...`);

        // Delete one by one to handle errors gracefully
        let deleted = 0;
        for (const media of orphanedMedia) {
            try {
                await this.getClient().invoke("deleteMedia delete /media/{id}", {
                    pathParams: { id: media.id },
                });
                deleted++;
                const folder = media.mediaFolderId ? "Product Media" : "no folder";
                logger.info(`  Deleted: ${media.fileName} (${folder})`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (message.includes("409") || message.includes("in use")) {
                    logger.info(`  Skipped (still in use elsewhere): ${media.fileName}`);
                } else {
                    logger.info(`  Failed: ${media.fileName} - ${message}`);
                }
            }
        }

        logger.info(`Deleted ${deleted}/${orphanedMedia.length} orphaned media files.`);
        return deleted;
    }

    // =========================================================================
    // SalesChannel-Centric Cleanup Methods
    // =========================================================================

    /**
     * Normalize a SalesChannel name for lookup
     */
    private normalizeSalesChannelName(name: string): string {
        const normalized = name.replace(/_/g, "-");
        return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
    }

    /**
     * Get a SalesChannel by name
     * Handles common variations: underscores vs hyphens, case differences
     */
    async getSalesChannelByName(
        name: string
    ): Promise<{ id: string; navigationCategoryId: string } | null> {
        if (!this.isAuthenticated()) {
            return null;
        }

        // Try multiple name variations to find the SalesChannel
        const variations = [
            this.normalizeSalesChannelName(name),
            this.capitalizeString(name),
            name,
        ];

        const uniqueVariations = [...new Set(variations)];

        for (const variation of uniqueVariations) {
            const { data: scData } = await this.getClient().invoke(
                "searchSalesChannel post /search/sales-channel",
                {
                    body: {
                        limit: 1,
                        filter: [{ type: "equals", field: "name", value: variation }],
                    },
                }
            );
            const result = scData as SearchResult<Schemas["SalesChannel"]>;
            const salesChannel = (result.data ?? [])[0];
            if (salesChannel) {
                return {
                    id: salesChannel.id,
                    navigationCategoryId: salesChannel.navigationCategoryId ?? "",
                };
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
            return 0;
        }

        logger.info(`Finding products in SalesChannel...`);

        const { data: productsData } = await this.getClient().invoke(
            "searchProduct post /search/product",
            {
                body: {
                    limit: 500,
                    filter: [
                        {
                            type: "equals",
                            field: "visibilities.salesChannelId",
                            value: salesChannelId,
                        },
                    ],
                },
            }
        );
        const productsResult = productsData as SearchResult<Schemas["Product"]>;
        const products = productsResult.data ?? [];

        if (products.length === 0) {
            logger.info(`No products found in SalesChannel.`);
            return 0;
        }

        logger.info(`Deleting ${products.length} products from SalesChannel...`);

        const deletePayload = products.map((p) => ({ id: p.id }));
        await this.sync([{ entity: "product", action: "delete", payload: deletePayload }]);

        logger.info(`Deleted ${products.length} products.`);
        return products.length;
    }

    /**
     * Delete all categories under a root category
     * @param rootCategoryId - The root category ID
     * @returns Number of deleted categories
     */
    async deleteCategoriesUnderRoot(rootCategoryId: string): Promise<number> {
        if (!this.isAuthenticated()) {
            return 0;
        }

        logger.info(`Finding categories under root category...`);

        const { data: categoriesData } = await this.getClient().invoke(
            "searchCategory post /search/category",
            {
                body: {
                    limit: 500,
                    filter: [
                        {
                            type: "multi",
                            operator: "or",
                            queries: [
                                {
                                    type: "equals",
                                    field: "parentId",
                                    value: rootCategoryId,
                                },
                                {
                                    type: "contains",
                                    field: "path",
                                    value: rootCategoryId,
                                },
                            ],
                        },
                    ],
                },
            }
        );
        const categoriesResult = categoriesData as SearchResult<Schemas["Category"]>;
        const categories = categoriesResult.data ?? [];

        if (categories.length === 0) {
            logger.info(`No child categories found.`);
            return 0;
        }

        logger.info(`Deleting ${categories.length} categories...`);

        const deletePayload = categories.map((c) => ({ id: c.id }));
        await this.sync([{ entity: "category", action: "delete", payload: deletePayload }]);

        logger.info(`Deleted ${categories.length} categories.`);
        return categories.length;
    }

    /**
     * Delete a SalesChannel by ID
     */
    async deleteSalesChannel(salesChannelId: string): Promise<boolean> {
        if (!this.isAuthenticated()) {
            return false;
        }

        try {
            await this.getClient().invoke("deleteSalesChannel delete /sales-channel/{id}", {
                pathParams: { id: salesChannelId },
            });
            logger.info(`Deleted SalesChannel.`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to delete SalesChannel: ${message}`);
            return false;
        }
    }

    /**
     * Delete the root category of a SalesChannel
     */
    async deleteRootCategory(categoryId: string): Promise<boolean> {
        if (!this.isAuthenticated()) {
            return false;
        }

        try {
            await this.getClient().invoke("deleteCategory delete /category/{id}", {
                pathParams: { id: categoryId },
            });
            logger.info(`Deleted root category.`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to delete root category: ${message}`);
            return false;
        }
    }

    // =========================================================================
    // Orphaned Entity Cleanup Methods
    // =========================================================================

    /**
     * Generic paginated search using a callback function.
     * The callback receives the search body and returns the result.
     */
    private async fetchAllPages<T>(
        searchFn: (body: Record<string, unknown>) => Promise<{ data?: T[]; total?: number }>,
        options: Record<string, unknown> = {},
        pageSize = 500
    ): Promise<T[]> {
        const allItems: T[] = [];
        let page = 1;
        let hasMore = true;

        logger.info(`  [Pagination] Starting fetch...`);

        while (hasMore) {
            const body = {
                ...options,
                limit: pageSize,
                page,
                "total-count-mode": 1,
            };

            logger.info(`  [Pagination] Requesting page ${page} (limit: ${pageSize})...`);

            const result = await searchFn(body);
            const items = result.data ?? [];
            const total = result.total ?? 0;

            logger.info(
                `  [Pagination] Page ${page}: received ${items.length} items, total reported: ${total}`
            );

            allItems.push(...items);
            hasMore = allItems.length < total && items.length > 0;

            if (hasMore) {
                logger.info(`  [Pagination] Fetched ${allItems.length}/${total}, continuing...`);
            }

            page++;

            if (page > 100) {
                logger.warn(`  [Pagination] Safety limit reached at page 100, stopping.`);
                break;
            }
        }

        logger.info(`  [Pagination] Complete: ${allItems.length} total items fetched.`);
        return allItems;
    }

    /**
     * Collect all used property option IDs from products (with pagination)
     */
    private async collectUsedPropertyOptionIds(): Promise<Set<string>> {
        interface ProductWithPropertiesAndOptions {
            id: string;
            properties?: Array<{ id: string }>;
            options?: Array<{ id: string }>;
        }

        logger.info("  Collecting used property options from products...");
        const allProducts = await this.fetchAllPages<ProductWithPropertiesAndOptions>(
            async (body) => {
                const { data } = await this.getClient().invoke(
                    "searchProduct post /search/product",
                    { body }
                );
                return data as { data?: ProductWithPropertiesAndOptions[]; total?: number };
            },
            {
                associations: {
                    properties: {},
                    options: {},
                },
            }
        );

        const usedOptionIds = new Set<string>();
        let propertiesCount = 0;
        let optionsCount = 0;

        for (const product of allProducts) {
            if (product.properties) {
                for (const prop of product.properties) {
                    if (!usedOptionIds.has(prop.id)) {
                        propertiesCount++;
                    }
                    usedOptionIds.add(prop.id);
                }
            }
            if (product.options) {
                for (const opt of product.options) {
                    if (!usedOptionIds.has(opt.id)) {
                        optionsCount++;
                    }
                    usedOptionIds.add(opt.id);
                }
            }
        }

        logger.info(
            `  Found ${usedOptionIds.size} property options used by ${allProducts.length} products`
        );
        logger.info(
            `    (${propertiesCount} from properties, ${optionsCount} from variant options)`
        );
        return usedOptionIds;
    }

    /**
     * Delete unused property groups - groups where none of their options are used by any product
     */
    async deleteUnusedPropertyGroups(dryRun = false): Promise<number> {
        if (!this.isAuthenticated()) {
            return 0;
        }

        logger.info("Searching for unused property groups...");

        interface PropertyGroupItem {
            id: string;
            name: string;
            options?: Array<{ id: string; name: string }>;
        }

        const allGroups = await this.fetchAllPages<PropertyGroupItem>(
            async (body) => {
                const { data } = await this.getClient().invoke(
                    "searchPropertyGroup post /search/property-group",
                    { body }
                );
                return data as { data?: PropertyGroupItem[]; total?: number };
            },
            { associations: { options: {} } }
        );
        logger.info(`Found ${allGroups.length} property groups`);

        if (allGroups.length === 0) {
            logger.info("No property groups found.");
            return 0;
        }

        // Get all option IDs that are actually used by products
        const usedOptionIds = await this.collectUsedPropertyOptionIds();

        // Find groups where NO options are used
        const unusedGroups = allGroups.filter((group) => {
            if (!group.options || group.options.length === 0) {
                return true;
            }
            return !group.options.some((opt) => usedOptionIds.has(opt.id));
        });

        logger.info(
            `${unusedGroups.length} property groups are unused (no options linked to products)`
        );

        if (unusedGroups.length === 0) {
            logger.info("No unused property groups to delete.");
            return 0;
        }

        for (const group of unusedGroups) {
            const optCount = group.options?.length ?? 0;
            logger.info(`  - ${group.name} (${optCount} options)`);
        }

        if (dryRun) {
            logger.info(`[DRY RUN] Would delete ${unusedGroups.length} unused property groups`);
            return unusedGroups.length;
        }

        logger.info(`Deleting ${unusedGroups.length} unused property groups...`);

        const deleteBatchSize = 50;
        let deleted = 0;

        for (let i = 0; i < unusedGroups.length; i += deleteBatchSize) {
            const batch = unusedGroups.slice(i, i + deleteBatchSize);
            const deletePayload = batch.map((g) => ({ id: g.id }));

            await this.sync([
                {
                    entity: "property_group",
                    action: "delete",
                    payload: deletePayload,
                },
            ]);

            deleted += batch.length;
            if (unusedGroups.length > deleteBatchSize) {
                logger.info(`  Deleted ${deleted}/${unusedGroups.length}...`);
            }
        }

        logger.info(`Deleted ${unusedGroups.length} unused property groups.`);
        return unusedGroups.length;
    }

    /**
     * Delete unused property options - options not used by any product
     */
    async deleteUnusedPropertyOptions(dryRun = false): Promise<number> {
        if (!this.isAuthenticated()) {
            return 0;
        }

        logger.info("Searching for unused property options...");

        interface PropertyOptionItem {
            id: string;
            name: string;
            group?: { name: string };
        }

        const allOptions = await this.fetchAllPages<PropertyOptionItem>(
            async (body) => {
                const { data } = await this.getClient().invoke(
                    "searchPropertyGroupOption post /search/property-group-option",
                    { body }
                );
                return data as { data?: PropertyOptionItem[]; total?: number };
            },
            { associations: { group: {} } }
        );
        logger.info(`Found ${allOptions.length} total property options`);

        if (allOptions.length === 0) {
            logger.info("No property options found.");
            return 0;
        }

        const usedOptionIds = await this.collectUsedPropertyOptionIds();

        const unusedOptions = allOptions.filter((opt) => !usedOptionIds.has(opt.id));

        logger.info(`${unusedOptions.length} property options are unused`);

        if (unusedOptions.length === 0) {
            logger.info("No unused property options to delete.");
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
            logger.info(`  - ${groupName}: ${options.length} unused options`);
        }

        if (dryRun) {
            logger.info(`[DRY RUN] Would delete ${unusedOptions.length} unused property options`);
            return unusedOptions.length;
        }

        logger.info(`Deleting ${unusedOptions.length} unused property options...`);

        const deleteBatchSize = 100;
        let deleted = 0;

        for (let i = 0; i < unusedOptions.length; i += deleteBatchSize) {
            const batch = unusedOptions.slice(i, i + deleteBatchSize);
            const deletePayload = batch.map((o) => ({ id: o.id }));

            await this.sync([
                {
                    entity: "property_group_option",
                    action: "delete",
                    payload: deletePayload,
                },
            ]);

            deleted += batch.length;
            if (unusedOptions.length > deleteBatchSize) {
                logger.info(`  Deleted ${deleted}/${unusedOptions.length}...`);
            }
        }

        logger.info(`Deleted ${unusedOptions.length} unused property options.`);
        return unusedOptions.length;
    }

    /**
     * Full SalesChannel cleanup: delete products, categories, and optionally the SalesChannel itself
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
        errors: string[];
    }> {
        const result = {
            products: 0,
            categories: 0,
            propertyGroups: 0,
            manufacturers: 0,
            salesChannelDeleted: false,
            rootCategoryDeleted: false,
            errors: [] as string[],
        };

        const salesChannel = await this.getSalesChannelByName(salesChannelName);
        if (!salesChannel) {
            logger.info(`SalesChannel "${salesChannelName}" not found.`);
            return result;
        }

        logger.info(`Found SalesChannel "${salesChannelName}" (ID: ${salesChannel.id})`);

        // Order: products -> categories -> SalesChannel -> property groups
        // Property groups must be deleted AFTER products/SalesChannel to avoid FK constraints
        // from product_configurator_setting referencing property_group_option.

        try {
            result.products = await this.deleteProductsInSalesChannel(salesChannel.id);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result.errors.push(`Failed to delete products: ${message}`);
            logger.error(`Failed to delete products: ${message}`, { data: error });
        }

        try {
            result.categories = await this.deleteCategoriesUnderRoot(
                salesChannel.navigationCategoryId
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result.errors.push(`Failed to delete categories: ${message}`);
            logger.error(`Failed to delete categories: ${message}`, { data: error });
        }

        if (options.deleteManufacturers) {
            logger.info(
                "Note: Manufacturer cleanup should be done via --processors=manufacturers for proper SalesChannel scoping."
            );
        }

        if (options.deleteSalesChannel) {
            try {
                result.salesChannelDeleted = await this.deleteSalesChannel(salesChannel.id);
                if (result.salesChannelDeleted) {
                    result.rootCategoryDeleted = await this.deleteRootCategory(
                        salesChannel.navigationCategoryId
                    );
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                result.errors.push(`Failed to delete SalesChannel: ${message}`);
                logger.error(`Failed to delete SalesChannel: ${message}`, { data: error });
            }
        }

        if (options.deletePropertyGroups) {
            try {
                result.propertyGroups = await this.deleteAllPropertyGroups();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                result.errors.push(`Failed to delete property groups: ${message}`);
                logger.error(`Failed to delete property groups: ${message}`, { data: error });
            }
        }

        return result;
    }
}
