import { createHash } from "crypto";

import type {
    CategoryNode,
    ProductInput,
    ProductReview,
    PropertyGroup,
    PropertyOption,
    SalesChannel,
    SalesChannelFull,
    SalesChannelInput,
} from "../types/index.js";

import {
    buildCategoryPath,
    CATEGORY_PATH_SEPARATOR,
    capitalizeString,
    generateSubdomainUrl,
    generateUUID,
    logger,
    validateSubdomainName,
} from "../utils/index.js";

import { ShopwareClient } from "./client.js";

/** Common Shopware search response structure */
interface SearchResponse<T> {
    total: number;
    data: T[];
}

/** Create response structure */
interface CreateResponse<T> {
    data: T;
}

/**
 * Shopware data hydrator - creates products, categories, and property groups
 */
export class ShopwareHydrator extends ShopwareClient {
    /**
     * Create or get existing product category
     */
    async createProductCategory(
        category: string,
        salesChannel: SalesChannel
    ): Promise<{ id: string; name: string }> {
        const categoryName = capitalizeString(category.trim());

        logger.debug("Searching for category", {
            name: categoryName,
            parentId: salesChannel.navigationCategoryId,
        });

        const categorySearchResponse = await this.apiClient.post<
            SearchResponse<{ id: string; name: string }>
        >("search/category", {
            limit: 1,
            filter: [
                { type: "equals", field: "name", value: categoryName },
                {
                    type: "equals",
                    field: "parentId",
                    value: salesChannel.navigationCategoryId,
                },
            ],
        });

        if (categorySearchResponse.data.total === 1 && categorySearchResponse.data.data[0]) {
            logger.debug("Found existing category", categorySearchResponse.data.data[0]);
            return categorySearchResponse.data.data[0];
        }

        logger.debug("Creating new category", { name: categoryName });

        const categoryResponse = await this.apiClient.post<
            CreateResponse<{ id: string; name: string }>
        >("category?_response", {
            name: categoryName,
            parentId: salesChannel.navigationCategoryId,
            displayNestedProducts: true,
            type: "page",
            productAssignmentType: "product",
            visible: true,
            active: true,
        });

        logger.debug("Category created", categoryResponse.data.data);

        return categoryResponse.data.data;
    }

    /**
     * Verify that property groups AND their options exist in Shopware
     * Returns true if all IDs are valid, false otherwise
     */
    async verifyPropertyGroupsExist(propertyGroups: PropertyGroup[]): Promise<boolean> {
        if (!this.isAuthenticated()) {
            return false;
        }

        // Collect group IDs and option IDs
        const groupIds: string[] = [];
        const optionIds: string[] = [];

        for (const group of propertyGroups) {
            if (group.id) {
                groupIds.push(group.id);
            }
            for (const option of group.options) {
                if (option.id) {
                    optionIds.push(option.id);
                }
            }
        }

        if (groupIds.length === 0 && optionIds.length === 0) {
            return false;
        }

        try {
            // Check if property groups exist
            if (groupIds.length > 0) {
                const groupResponse = await this.apiClient.post<SearchResponse<{ id: string }>>(
                    "search/property-group",
                    {
                        limit: groupIds.length,
                        filter: [{ type: "equalsAny", field: "id", value: groupIds }],
                    }
                );

                const foundGroups = groupResponse.data.total || 0;
                if (foundGroups !== groupIds.length) {
                    logger.debug("Property groups verification failed", {
                        requestedGroups: groupIds.length,
                        foundGroups,
                    });
                    return false;
                }
            }

            // Check if options exist
            if (optionIds.length > 0) {
                const optionResponse = await this.apiClient.post<SearchResponse<{ id: string }>>(
                    "search/property-group-option",
                    {
                        limit: optionIds.length,
                        filter: [{ type: "equalsAny", field: "id", value: optionIds }],
                    }
                );

                const foundOptions = optionResponse.data.total || 0;
                if (foundOptions !== optionIds.length) {
                    logger.debug("Property options verification failed", {
                        requestedOptions: optionIds.length,
                        foundOptions,
                    });
                    return false;
                }
            }

            logger.debug("Property groups and options verified", {
                groups: groupIds.length,
                options: optionIds.length,
            });

            return true;
        } catch (error) {
            logger.error("Failed to verify property groups", error);
            return false;
        }
    }

    /**
     * Search for existing property groups by name to enable idempotent creation.
     * Returns a map of lowercase group name -> { id, options: Map<lowercase name, id> }
     */
    private async findExistingPropertyGroups(): Promise<
        Map<string, { id: string; options: Map<string, string> }>
    > {
        const result = new Map<string, { id: string; options: Map<string, string> }>();

        try {
            const response = await this.apiClient.post<
                SearchResponse<{
                    id: string;
                    name: string;
                    options: Array<{ id: string; name: string }>;
                }>
            >("search/property-group", {
                limit: 100,
                associations: {
                    options: { sort: [{ field: "position", order: "ASC" }] },
                },
            });

            if (!response.ok || !response.data?.data) {
                return result;
            }

            for (const group of response.data.data) {
                const optionMap = new Map<string, string>();
                for (const opt of group.options || []) {
                    optionMap.set(opt.name.toLowerCase(), opt.id);
                }
                result.set(group.name.toLowerCase(), { id: group.id, options: optionMap });
            }
        } catch (error) {
            logger.warn("Failed to fetch existing property groups for idempotency check", error);
        }

        return result;
    }

    /**
     * Create property groups with options (idempotent).
     *
     * This method queries existing property groups and reuses their IDs
     * to prevent duplicate creation on repeated runs.
     */
    async hydrateEnvWithPropertyGroups(propertyGroups: PropertyGroup[]): Promise<PropertyGroup[]> {
        if (!this.isAuthenticated()) {
            return [];
        }

        // Fetch existing groups to reuse IDs (idempotency)
        const existingGroups = await this.findExistingPropertyGroups();

        const propertyGroupsPayload = propertyGroups.map((group) => {
            const existing = existingGroups.get(group.name.toLowerCase());
            const groupId = group.id || existing?.id || generateUUID();

            return {
                id: groupId,
                name: group.name,
                description: group.description,
                displayType: group.displayType,
                options: group.options.map((option: PropertyOption) => {
                    // Reuse existing option ID if available
                    const existingOptionId = existing?.options.get(option.name.toLowerCase());
                    return {
                        id: option.id || existingOptionId || generateUUID(),
                        name: option.name,
                        colorHexCode: option.colorHexCode,
                    };
                }),
            };
        });

        const propertyGroupResponse = await this.apiClient.post("_action/sync", {
            hydratePropertyGroups: {
                entity: "property_group",
                action: "upsert",
                payload: propertyGroupsPayload,
            },
        });

        // Log response for debugging
        if (propertyGroupResponse.status >= 400) {
            logger.apiError("_action/sync (property_groups)", propertyGroupResponse.status, {
                request: propertyGroupsPayload,
                response: propertyGroupResponse.data,
            });
        } else {
            logger.debug("Property groups sync successful", {
                status: propertyGroupResponse.status,
                reusedExisting: existingGroups.size,
            });
        }

        return propertyGroupsPayload;
    }

    /**
     * Direct product creation with explicit category IDs
     * Used by the new generate flow that passes all category assignments
     */
    async hydrateEnvWithProductsDirect(
        products: Array<{
            id: string;
            name: string;
            description: string;
            price: number;
            stock: number;
            categoryIds?: string[];
            options?: Array<{ id: string; name: string }>;
        }>,
        salesChannelId: string,
        navigationCategoryId: string
    ): Promise<number> {
        if (!this.isAuthenticated()) {
            return 0;
        }

        const taxId = await this.getStandardTaxId();
        const currencyId = await this.getCurrencyId();

        const productPayload = products.map((p) => {
            // Build category assignments - include navigation root + all assigned categories
            const categories = [{ id: navigationCategoryId }];
            if (p.categoryIds) {
                for (const catId of p.categoryIds) {
                    if (catId !== navigationCategoryId) {
                        categories.push({ id: catId });
                    }
                }
            }

            const product: Record<string, unknown> = {
                id: p.id,
                productNumber: `AI-${p.id}`,
                name: p.name,
                description: p.description,
                stock: p.stock,
                taxId: taxId,
                price: [
                    {
                        currencyId: currencyId,
                        gross: p.price,
                        net: p.price,
                        linked: true,
                    },
                ],
                visibilities: [
                    {
                        // Use deterministic ID for idempotent upsert
                        id: this.generateVisibilityId(p.id, salesChannelId),
                        productId: p.id,
                        salesChannelId: salesChannelId,
                        visibility: 30,
                    },
                ],
                categories,
            };

            // Add property options if present
            if (p.options && p.options.length > 0) {
                product.properties = p.options.map((option) => ({ id: option.id }));
            }

            return product;
        });

        // Sync products in batches of 50
        const BATCH_SIZE = 50;
        let created = 0;

        for (let i = 0; i < productPayload.length; i += BATCH_SIZE) {
            const batch = productPayload.slice(i, i + BATCH_SIZE);

            const response = await this.apiClient.post("_action/sync", {
                hydrateProducts: {
                    entity: "product",
                    action: "upsert",
                    payload: batch,
                },
            });

            if (response.status >= 400) {
                logger.apiError("_action/sync (products)", response.status, {
                    request: batch.slice(0, 2), // Log first 2 products for debugging
                    response: response.data,
                });
            } else {
                created += batch.length;
            }
        }

        return created;
    }

    /**
     * Create products with images and property options
     */
    async hydrateEnvWithProducts(
        products: ProductInput[],
        category: string,
        salesChannelName: string = "Storefront"
    ): Promise<number | false> {
        if (!this.isAuthenticated()) {
            return false;
        }

        const taxId = await this.getStandardTaxId();
        const salesChannel = await this.getStandardSalesChannel(salesChannelName);

        let currencyId = salesChannel.currencyId;
        if (!currencyId) {
            currencyId = await this.getCurrencyId();
        }

        const productCategory = await this.createProductCategory(category, salesChannel);

        // Get the Product Media folder for organizing images
        const productMediaFolderId = await this.getProductMediaFolderId();

        const mediaUploads: { id: string; image: { name: string; data: string } }[] = [];
        const mediaPayload: { id: string; private: boolean; mediaFolderId?: string }[] = [];

        const productPayload = products.map((p: ProductInput) => {
            const UUID = generateUUID();

            const product: Record<string, unknown> = {
                id: UUID,
                productNumber: `AI-${UUID}`,
                name: p.name,
                description: p.description,
                stock: p.stock,
                taxId: taxId,
                price: [
                    {
                        currencyId: currencyId,
                        gross: p.price,
                        net: p.price,
                        linked: true,
                    },
                ],
                visibilities: [
                    {
                        productId: UUID,
                        salesChannelId: salesChannel.id,
                        visibility: 30,
                    },
                ],
                categories: [{ id: salesChannel.navigationCategoryId }, { id: productCategory.id }],
            };

            if (p.productReviews) {
                product.productReviews = p.productReviews.map((review: ProductReview) => {
                    review.salesChannelId = salesChannel.id;
                    return review;
                });
            }

            if (p.options) {
                product.properties = p.options.map((option: PropertyOption) => ({
                    id: option.id,
                }));
            }

            if (p.image) {
                const mediaId = generateUUID();
                const productMediaId = generateUUID();

                mediaUploads.push({
                    id: mediaId,
                    image: p.image,
                });

                mediaPayload.push({
                    id: mediaId,
                    private: false,
                    ...(productMediaFolderId && { mediaFolderId: productMediaFolderId }),
                });

                product.coverId = productMediaId;
                product.media = [
                    {
                        id: productMediaId,
                        media: { id: mediaId },
                    },
                ];
            }

            return product;
        });

        const syncPayload: Record<string, unknown> = {
            hydrateProducts: {
                entity: "product",
                action: "upsert",
                payload: productPayload,
            },
        };

        // Only include media sync if there are media items to upsert
        if (mediaPayload.length > 0) {
            syncPayload.hydrateMedia = {
                entity: "media",
                action: "upsert",
                payload: mediaPayload,
            };
        }

        logger.debug("Syncing products", {
            productCount: productPayload.length,
            mediaCount: mediaPayload.length,
            categoryId: productCategory.id,
            categoryName: productCategory.name,
        });

        const productResponse = await this.apiClient.post("_action/sync", syncPayload);

        // Log response for debugging
        if (productResponse.status >= 400) {
            logger.apiError("_action/sync (products)", productResponse.status, {
                request: syncPayload,
                response: productResponse.data,
            });
        } else {
            logger.debug("Product sync successful", { status: productResponse.status });
        }

        // Upload media files
        await Promise.all(
            mediaUploads.map(async (media) => {
                const imageBuffer = Buffer.from(media.image.data, "base64");
                return await this.apiClient.post(
                    `_action/media/${media.id}/upload?extension=png&fileName=${media.image.name}-${media.id}`,
                    imageBuffer,
                    {
                        headers: { "Content-Type": "image/png" },
                    }
                );
            })
        );

        return productResponse.status;
    }

    // =========================================================================
    // SalesChannel Creation Methods
    // =========================================================================

    /**
     * Create or get existing SalesChannel cloned from Storefront.
     * If a SalesChannel with the same name already exists, returns the existing one.
     *
     * @param input - SalesChannel creation input
     * @returns The SalesChannel with full details (created or existing)
     */
    async createSalesChannel(
        input: SalesChannelInput
    ): Promise<SalesChannelFull & { isNew: boolean }> {
        if (!this.isAuthenticated()) {
            throw new Error("Client is not authenticated");
        }

        // Validate and sanitize the name
        const validation = validateSubdomainName(input.name);
        if (!validation.valid) {
            throw new Error(`Invalid SalesChannel name: ${validation.error}`);
        }

        const sanitizedName = validation.sanitized;
        if (validation.warning) {
            logger.warn(validation.warning);
        }

        // Check if SalesChannel already exists
        const existing = await this.findSalesChannelByName(sanitizedName);
        if (existing) {
            logger.cli(`Using existing SalesChannel "${existing.name}" (ID: ${existing.id})`);
            return { ...existing, isNew: false };
        }

        // Get Storefront config to clone
        const storefront = await this.getFullSalesChannel("Storefront");

        // Create or reuse a root category for this SalesChannel
        const rootCategory = await this.createRootCategory(sanitizedName);

        // If reusing existing root, clean up old children
        if (!rootCategory.isNew) {
            const deletedCount = await this.deleteChildCategories(rootCategory.id);
            if (deletedCount > 0) {
                logger.info(`Cleaned up ${deletedCount} old categories from existing root`);
            }
        }

        // Generate access key
        const accessKey = this.generateAccessKey();

        // Determine the URL
        const baseUrl =
            input.baseUrl ||
            generateSubdomainUrl(
                sanitizedName,
                this.envPath?.replace(/^https?:\/\//, "") || "localhost:8000"
            );

        // Create the SalesChannel
        const salesChannelId = generateUUID();
        const domainId = generateUUID();

        const payload = {
            id: salesChannelId,
            name: capitalizeString(sanitizedName),
            typeId: storefront.typeId,
            languageId: storefront.languageId,
            currencyId: storefront.currencyId,
            paymentMethodId: storefront.paymentMethodId,
            shippingMethodId: storefront.shippingMethodId,
            countryId: storefront.countryId,
            customerGroupId: storefront.customerGroupId,
            navigationCategoryId: rootCategory.id,
            accessKey,
            active: true,
            languages: [{ id: storefront.languageId }],
            currencies: [{ id: storefront.currencyId }],
            paymentMethods: [{ id: storefront.paymentMethodId }],
            shippingMethods: [{ id: storefront.shippingMethodId }],
            countries: [{ id: storefront.countryId }],
            domains: [
                {
                    id: domainId,
                    url: baseUrl,
                    languageId: storefront.languageId,
                    currencyId: storefront.currencyId,
                    snippetSetId: storefront.snippetSetId,
                },
            ],
        };

        await this.apiClient.post<{ data: SalesChannelFull }>("sales-channel?_response", payload);

        logger.cli(`Created SalesChannel "${sanitizedName}" with URL: ${baseUrl}`);

        // Assign the same theme as Storefront
        const storefrontThemeId = await this.getThemeForSalesChannel(storefront.id);
        if (storefrontThemeId) {
            await this.assignThemeToSalesChannel(salesChannelId, storefrontThemeId);
        } else {
            logger.warn(
                "No theme found for Storefront - new SalesChannel may not display correctly"
            );
        }

        return {
            id: salesChannelId,
            name: capitalizeString(sanitizedName),
            typeId: storefront.typeId,
            languageId: storefront.languageId,
            currencyId: storefront.currencyId,
            paymentMethodId: storefront.paymentMethodId,
            shippingMethodId: storefront.shippingMethodId,
            countryId: storefront.countryId,
            customerGroupId: storefront.customerGroupId,
            navigationCategoryId: rootCategory.id,
            accessKey,
            snippetSetId: storefront.snippetSetId,
            isNew: true,
        };
    }

    /**
     * Find a SalesChannel by name (case-insensitive)
     */
    async findSalesChannelByName(name: string): Promise<SalesChannelFull | null> {
        const capitalizedName = capitalizeString(name);

        const response = await this.apiClient.post<SearchResponse<SalesChannelFull>>(
            "search/sales-channel",
            {
                limit: 1,
                filter: [{ type: "equals", field: "name", value: capitalizedName }],
            }
        );

        if (response.ok && response.data?.data?.[0]) {
            // Fetch full details including snippetSetId
            try {
                return await this.getFullSalesChannel(capitalizedName);
            } catch {
                // If we can't get full details, return what we have
                return response.data.data[0];
            }
        }

        return null;
    }

    /**
     * Create or reuse a root category for a SalesChannel.
     * If a root category with the same name exists, it will be reused
     * (children will be deleted when creating the new category tree).
     */
    async createRootCategory(name: string): Promise<{ id: string; name: string; isNew: boolean }> {
        const categoryName = `${capitalizeString(name)} Root`;

        // Check if a root category with this name already exists
        const existingResponse = await this.apiClient.post<SearchResponse<{ id: string }>>(
            "search/category",
            {
                limit: 1,
                filter: [{ type: "equals", field: "name", value: categoryName }],
            }
        );

        if (existingResponse.ok && existingResponse.data?.data?.[0]) {
            const existingCategory = existingResponse.data.data[0];
            logger.info(
                `Reusing existing root category: ${categoryName} (ID: ${existingCategory.id})`
            );
            return { ...existingCategory, name: categoryName, isNew: false };
        }

        // Create new root category
        const categoryResponse = await this.apiClient.post<
            CreateResponse<{ id: string; name: string }>
        >("category?_response", {
            name: categoryName,
            displayNestedProducts: true,
            type: "page",
            productAssignmentType: "product",
            visible: false, // Root categories are typically hidden
            active: true,
        });

        logger.cli(`Created root category: ${categoryName}`);
        return { ...categoryResponse.data.data, isNew: true };
    }

    /**
     * Delete all child categories of a parent category.
     * Used to clean up before regenerating a category tree.
     */
    async deleteChildCategories(parentCategoryId: string): Promise<number> {
        // Find all child categories
        const childResponse = await this.apiClient.post<SearchResponse<{ id: string }>>(
            "search/category",
            {
                filter: [{ type: "equals", field: "parentId", value: parentCategoryId }],
                limit: 500,
            }
        );

        if (!childResponse.ok || !childResponse.data?.data?.length) {
            return 0;
        }

        const children = childResponse.data.data;

        // Recursively delete children of each child first
        for (const child of children) {
            await this.deleteChildCategories(child.id);
        }

        // Delete all child categories
        const deletePayload = children.map((c) => ({ id: c.id }));
        await this.apiClient.post("_action/sync", {
            deleteChildCategories: {
                entity: "category",
                action: "delete",
                payload: deletePayload,
            },
        });

        return children.length;
    }

    /**
     * Create a category tree in Shopware (idempotent).
     *
     * This method first checks for existing categories with matching names/paths
     * and reuses their IDs to prevent duplicate creation on repeated runs.
     *
     * @param tree - The category tree structure
     * @param parentId - Parent category ID (typically the SalesChannel's navigationCategoryId)
     * @param salesChannelId - SalesChannel ID for visibility
     * @returns Map of category paths to their Shopware IDs (e.g., "Living Room > Sofas" -> "uuid")
     */
    async createCategoryTree(
        tree: CategoryNode[],
        parentId: string,
        _salesChannelId: string
    ): Promise<Map<string, string>> {
        if (!this.isAuthenticated()) {
            throw new Error("Client is not authenticated");
        }

        // Check for existing categories and reuse their IDs (idempotency)
        // This modifies tree nodes in-place by setting node.id for matches
        const existingMap = await this.getExistingCategoryMap(parentId, tree);
        if (existingMap.size > 0) {
            logger.debug("Found existing categories for reuse", { count: existingMap.size });
        }

        const categoryIdMap = new Map<string, string>();

        // Build flat list of categories with parent relationships and paths
        const flatCategories = this.flattenCategoryTree(tree, parentId);

        // Create categories in batches using sync API
        const categoryPayload = flatCategories.map((item) => ({
            id: item.category.id || generateUUID(),
            name: item.category.name,
            description: item.category.description,
            parentId: item.parentId,
            displayNestedProducts: true,
            type: "page",
            productAssignmentType: "product",
            visible: true,
            active: true,
        }));

        // Store IDs in the original tree nodes using path as key (prevents collisions)
        for (let i = 0; i < flatCategories.length; i++) {
            const item = flatCategories[i];
            const payloadItem = categoryPayload[i];
            if (item && payloadItem) {
                item.category.id = payloadItem.id;
                // Use full path as key to avoid collisions with duplicate names
                categoryIdMap.set(item.path, payloadItem.id);
            }
        }

        const response = await this.apiClient.post("_action/sync", {
            createCategories: {
                entity: "category",
                action: "upsert",
                payload: categoryPayload,
            },
        });

        logger.cli(`Created ${categoryPayload.length} categories (status: ${response.status})`);

        // Upload category images
        await this.uploadCategoryImages(flatCategories.map((f) => f.category));

        return categoryIdMap;
    }

    /**
     * Get existing categories under a parent and map them to the expected category tree.
     * Uses full paths as keys to avoid collisions with duplicate names.
     * Used when a SalesChannel already exists.
     *
     * @returns Map of category paths to their Shopware IDs (e.g., "Living Room > Sofas" -> "uuid")
     */
    async getExistingCategoryMap(
        parentCategoryId: string,
        expectedTree: CategoryNode[]
    ): Promise<Map<string, string>> {
        const categoryIdMap = new Map<string, string>();

        // Fetch all categories under the parent
        const response = await this.apiClient.post<
            SearchResponse<{ id: string; name: string; parentId: string }>
        >("search/category", {
            limit: 500,
            filter: [
                {
                    type: "multi",
                    operator: "OR",
                    queries: [
                        { type: "equals", field: "parentId", value: parentCategoryId },
                        { type: "contains", field: "path", value: parentCategoryId },
                    ],
                },
            ],
        });

        if (!response.ok || !response.data?.data) {
            return categoryIdMap;
        }

        const existingCategories = response.data.data;

        // Build parent-child relationships to reconstruct paths
        const categoriesById = new Map<string, { id: string; name: string; parentId: string }>();
        for (const cat of existingCategories) {
            categoriesById.set(cat.id, cat);
        }

        // Reconstruct path for each category by walking up the parent chain
        const getPathForCategory = (catId: string): string | null => {
            const parts: string[] = [];
            let currentId: string | null = catId;

            while (currentId && currentId !== parentCategoryId) {
                const cat = categoriesById.get(currentId);
                if (!cat) break;
                parts.unshift(cat.name);
                currentId = cat.parentId;
            }

            return parts.length > 0 ? parts.join(CATEGORY_PATH_SEPARATOR) : null;
        };

        // Build path-to-id map from existing categories
        const existingByPath = new Map<string, string>();
        for (const cat of existingCategories) {
            const path = getPathForCategory(cat.id);
            if (path) {
                existingByPath.set(path.toLowerCase(), cat.id);
            }
        }

        // Match expected categories to existing ones by path
        const matchCategories = (nodes: CategoryNode[], parentPath: string | null): void => {
            for (const node of nodes) {
                const path = buildCategoryPath(parentPath, node.name);
                const existingId = existingByPath.get(path.toLowerCase());
                if (existingId) {
                    node.id = existingId;
                    categoryIdMap.set(path, existingId);
                }
                if (node.children.length > 0) {
                    matchCategories(node.children, path);
                }
            }
        };

        matchCategories(expectedTree, null);

        return categoryIdMap;
    }

    /**
     * Flattened category item with parent reference and full path
     */
    private flattenCategoryTree(
        tree: CategoryNode[],
        parentId: string,
        parentPath: string | null = null
    ): Array<{ category: CategoryNode; parentId: string; path: string }> {
        const result: Array<{ category: CategoryNode; parentId: string; path: string }> = [];

        for (const category of tree) {
            // Ensure category has an ID
            if (!category.id) {
                category.id = generateUUID();
            }

            const path = buildCategoryPath(parentPath, category.name);
            result.push({ category, parentId, path });

            if (category.children.length > 0) {
                result.push(...this.flattenCategoryTree(category.children, category.id, path));
            }
        }

        return result;
    }

    /**
     * Generate a deterministic visibility ID from product and sales channel IDs.
     * This ensures idempotent upserts - re-running won't create duplicate visibilities.
     *
     * Uses SHA256 hash for collision resistance (XOR is not collision-resistant).
     */
    private generateVisibilityId(productId: string, salesChannelId: string): string {
        const hash = createHash("sha256")
            .update(`${productId}:${salesChannelId}`)
            .digest("hex");
        return hash.slice(0, 32); // Shopware UUID format (32 hex chars)
    }

    /**
     * Upload images for categories that have them
     */
    private async uploadCategoryImages(categories: CategoryNode[]): Promise<void> {
        const categoriesWithImages = categories.filter((c) => c.image && c.id);

        if (categoriesWithImages.length === 0) {
            return;
        }

        logger.info(`Uploading ${categoriesWithImages.length} category images...`);

        const productMediaFolderId = await this.getProductMediaFolderId();

        for (const category of categoriesWithImages) {
            if (!category.image || !category.id) continue;

            const mediaId = generateUUID();

            // Create media entity
            await this.apiClient.post("_action/sync", {
                createMedia: {
                    entity: "media",
                    action: "upsert",
                    payload: [
                        {
                            id: mediaId,
                            private: false,
                            ...(productMediaFolderId && { mediaFolderId: productMediaFolderId }),
                        },
                    ],
                },
            });

            // Upload the image
            const imageBuffer = Buffer.from(category.image.data, "base64");
            await this.apiClient.post(
                `_action/media/${mediaId}/upload?extension=png&fileName=category-${category.id}`,
                imageBuffer,
                { headers: { "Content-Type": "image/png" } }
            );

            // Associate media with category
            await this.apiClient.patch(`category/${category.id}`, {
                mediaId,
            });

            logger.cli(`Uploaded image for category "${category.name}"`);
        }
    }

    // =========================================================================
    // Property Option Media Helpers
    // =========================================================================

    /**
     * Get or create a media folder by name
     */
    async getOrCreateMediaFolder(folderName: string): Promise<string | null> {
        if (!this.isAuthenticated()) return null;

        try {
            // Search for existing folder
            const response = await this.apiClient.post<{
                data?: Array<{ id: string; name: string }>;
            }>("search/media-folder", {
                filter: [{ type: "equals", field: "name", value: folderName }],
                limit: 1,
            });

            const existing = response.data?.data?.[0];
            if (existing) {
                return existing.id;
            }

            // Get default configuration to use for the folder
            const configResponse = await this.apiClient.post<{
                data?: Array<{ id: string }>;
            }>("search/media-default-folder", {
                filter: [{ type: "equals", field: "entity", value: "product" }],
                limit: 1,
            });
            const defaultConfig = configResponse.data?.data?.[0];

            // Create new folder
            const folderId = generateUUID();
            await this.apiClient.post("_action/sync", {
                createMediaFolder: {
                    entity: "media_folder",
                    action: "upsert",
                    payload: [
                        {
                            id: folderId,
                            name: folderName,
                            useParentConfiguration: true,
                            ...(defaultConfig && {
                                configurationId: defaultConfig.id,
                            }),
                        },
                    ],
                },
            });

            return folderId;
        } catch (error) {
            logger.warn(
                `Failed to get/create media folder: ${error instanceof Error ? error.message : String(error)}`
            );
            return null;
        }
    }

    /**
     * Create a media entity in a folder
     */
    async createMedia(folderId: string, _fileName: string): Promise<string | null> {
        if (!this.isAuthenticated()) return null;

        try {
            const mediaId = generateUUID();
            await this.apiClient.post("_action/sync", {
                createMedia: {
                    entity: "media",
                    action: "upsert",
                    payload: [
                        {
                            id: mediaId,
                            private: false,
                            mediaFolderId: folderId,
                        },
                    ],
                },
            });
            return mediaId;
        } catch (error) {
            logger.warn(
                `Failed to create media: ${error instanceof Error ? error.message : String(error)}`
            );
            return null;
        }
    }

    /**
     * Upload a file to an existing media entity
     */
    async uploadMediaFile(
        mediaId: string,
        buffer: Buffer,
        extension: string
    ): Promise<boolean> {
        if (!this.isAuthenticated()) return false;

        try {
            const contentType =
                extension === "svg" ? "image/svg+xml" : `image/${extension}`;

            await this.apiClient.post(
                `_action/media/${mediaId}/upload?extension=${extension}&fileName=color-option-${mediaId}`,
                buffer,
                { headers: { "Content-Type": contentType } }
            );
            return true;
        } catch (error) {
            logger.warn(
                `Failed to upload media file: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
        }
    }

    /**
     * Update a property option with a media ID (and clear hex code)
     */
    async updatePropertyOptionMedia(
        optionId: string,
        mediaId: string
    ): Promise<boolean> {
        if (!this.isAuthenticated()) return false;

        try {
            // Set mediaId AND clear colorHexCode - Shopware shows hex over image if both set
            await this.apiClient.patch(`property-group-option/${optionId}`, {
                mediaId,
                colorHexCode: null,
            });
            return true;
        } catch (error) {
            logger.warn(
                `Failed to update property option media: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
        }
    }
}
