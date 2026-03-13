import { createHash } from "crypto";

import type {
    CategoryNode,
    MediaEntityPayload,
    PricePayload,
    ProductSyncPayload,
    ProductInput,
    ProductReview,
    PropertyGroup,
    PropertyOption,
    SalesChannel,
    SalesChannelFull,
    SalesChannelInput,
    TieredPricePayload,
} from "../types/index.js";
import type { Schemas } from "./admin-client.js";
import type { SearchResult, SyncOperation } from "./api-types.js";

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

/**
 * Shopware data hydrator - creates products, categories, and property groups.
 * Uses the official @shopware/api-client invoke() for all API calls.
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
            data: {
                name: categoryName,
                parentId: salesChannel.navigationCategoryId,
            },
        });

        const { data: searchData } = await this.getClient().invoke(
            "searchCategory post /search/category",
            {
                body: {
                    limit: 1,
                    filter: [
                        { type: "equals", field: "name", value: categoryName },
                        {
                            type: "equals",
                            field: "parentId",
                            value: salesChannel.navigationCategoryId,
                        },
                    ],
                },
            }
        );
        const searchResult = searchData as SearchResult<Schemas["Category"]>;

        if ((searchResult.total ?? 0) === 1 && searchResult.data?.[0]) {
            const existing = searchResult.data[0];
            logger.debug("Found existing category", {
                data: { id: existing.id, name: existing.name },
            });
            return { id: existing.id, name: existing.name ?? categoryName };
        }

        logger.debug("Creating new category", { data: { name: categoryName } });

        const newCategoryId = generateUUID();
        await this.sync([
            {
                entity: "category",
                action: "upsert",
                payload: [
                    {
                        id: newCategoryId,
                        name: categoryName,
                        parentId: salesChannel.navigationCategoryId,
                        displayNestedProducts: true,
                        type: "page",
                        productAssignmentType: "product",
                        visible: true,
                        active: true,
                    },
                ],
            },
        ]);

        logger.debug("Category created", {
            data: { id: newCategoryId, name: categoryName },
        });
        return { id: newCategoryId, name: categoryName };
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
                const { data: groupData } = await this.getClient().invoke(
                    "searchPropertyGroup post /search/property-group",
                    {
                        body: {
                            limit: groupIds.length,
                            filter: [{ type: "equalsAny", field: "id", value: groupIds }],
                        },
                    }
                );
                const groupResult = groupData as SearchResult<Schemas["PropertyGroup"]>;

                const foundGroups = groupResult.total ?? 0;
                if (foundGroups !== groupIds.length) {
                    logger.debug("Property groups verification failed", {
                        data: {
                            requestedGroups: groupIds.length,
                            foundGroups,
                        },
                    });
                    return false;
                }
            }

            // Check if options exist
            if (optionIds.length > 0) {
                const { data: optionData } = await this.getClient().invoke(
                    "searchPropertyGroupOption post /search/property-group-option",
                    {
                        body: {
                            limit: optionIds.length,
                            filter: [{ type: "equalsAny", field: "id", value: optionIds }],
                        },
                    }
                );
                const optionResult = optionData as SearchResult<Schemas["PropertyGroupOption"]>;

                const foundOptions = optionResult.total ?? 0;
                if (foundOptions !== optionIds.length) {
                    logger.debug("Property options verification failed", {
                        data: {
                            requestedOptions: optionIds.length,
                            foundOptions,
                        },
                    });
                    return false;
                }
            }

            logger.debug("Property groups and options verified", {
                data: {
                    groups: groupIds.length,
                    options: optionIds.length,
                },
            });

            return true;
        } catch (error) {
            logger.error("Failed to verify property groups", { data: error });
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
            const { data: searchData } = await this.getClient().invoke(
                "searchPropertyGroup post /search/property-group",
                {
                    body: {
                        limit: 100,
                        associations: {
                            options: { sort: [{ field: "position", order: "ASC" }] },
                        },
                    },
                }
            );
            const searchResult = searchData as SearchResult<Schemas["PropertyGroup"]>;

            for (const group of searchResult.data ?? []) {
                const optionMap = new Map<string, string>();
                for (const opt of group.options ?? []) {
                    optionMap.set(opt.name.toLowerCase(), opt.id);
                }
                const name = group.name ?? "";
                result.set(name.toLowerCase(), { id: group.id, options: optionMap });
            }
        } catch (error) {
            logger.warn("Failed to fetch existing property groups for idempotency check", {
                data: error,
            });
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

        try {
            await this.sync([
                {
                    entity: "property_group",
                    action: "upsert",
                    payload: propertyGroupsPayload,
                },
            ]);

            logger.debug("Property groups sync successful", {
                data: { reusedExisting: existingGroups.size },
            });
        } catch (error) {
            logger.apiError("_action/sync (property_groups)", 400, {
                request: propertyGroupsPayload,
                response: error,
            });
        }

        return propertyGroupsPayload;
    }

    /** Cached "Always valid" rule ID for graduated pricing */
    private alwaysValidRuleId: string | null | undefined = undefined;

    /**
     * Get the "Always valid" rule ID for graduated pricing (cached).
     * Falls back to any available rule if the default is not found.
     */
    async getAlwaysValidRuleId(): Promise<string | null> {
        if (this.alwaysValidRuleId !== undefined) return this.alwaysValidRuleId;

        try {
            const { data } = await this.getClient().invoke(
                "searchRule post /search/rule" as never,
                {
                    body: {
                        limit: 10,
                        sort: [{ field: "priority", order: "DESC" }],
                    },
                } as never
            );

            const rules = (data as { data?: Array<{ id: string; name: string }> })?.data ?? [];
            const alwaysValid = rules.find(
                (r) =>
                    r.name.toLowerCase().includes("always valid") ||
                    r.name.toLowerCase().includes("always true")
            );
            if (!alwaysValid) {
                logger.warn(
                    'No "Always valid" / "Always true" rule found in Shopware — tiered pricing will be skipped',
                    { cli: true }
                );
            }
            this.alwaysValidRuleId = alwaysValid?.id ?? null;
        } catch {
            this.alwaysValidRuleId = null;
        }

        return this.alwaysValidRuleId;
    }

    /** Cached physical delivery time IDs (excludes instant/digital) */
    private deliveryTimeIds: string[] | null = null;

    /**
     * Get delivery time IDs suitable for physical products (cached).
     * Excludes digital delivery times (min=0, max=0) via API filter.
     */
    async getDeliveryTimeIds(): Promise<string[]> {
        if (this.deliveryTimeIds) return this.deliveryTimeIds;

        try {
            const { data } = await this.getClient().invoke(
                "searchDeliveryTime post /search/delivery-time" as never,
                {
                    body: {
                        limit: 10,
                        filter: [{ type: "range", field: "min", parameters: { gt: 0 } }],
                    },
                } as never
            );
            const response = data as { data?: Array<{ id: string }> };
            this.deliveryTimeIds = (response.data ?? []).map((dt) => dt.id);
        } catch {
            this.deliveryTimeIds = [];
        }

        return this.deliveryTimeIds;
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
            hasSalesPrice?: boolean;
            salePercentage?: number;
            hasTieredPricing?: boolean;
            isTopseller?: boolean;
            isNew?: boolean;
            isShippingFree?: boolean;
            weight?: number;
            width?: number;
            height?: number;
            length?: number;
            ean?: string;
            manufacturerNumber?: string;
            minPurchase?: number;
            maxPurchase?: number;
            purchaseSteps?: number;
            metaTitle?: string;
            metaDescription?: string;
            deliveryTimeIndex?: number;
        }>,
        salesChannelId: string,
        navigationCategoryId: string
    ): Promise<number> {
        if (!this.isAuthenticated()) {
            return 0;
        }

        const hasTieredProducts = products.some((p) => p.hasTieredPricing);

        const [taxId, currencyId, deliveryTimeIds, ruleId] = await Promise.all([
            this.getStandardTaxId(),
            this.getCurrencyId(),
            this.getDeliveryTimeIds(),
            hasTieredProducts ? this.getAlwaysValidRuleId() : Promise.resolve(null),
        ]);

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

            // Build base price entry with optional listPrice for sale items
            const priceEntry: PricePayload = {
                currencyId: currencyId,
                gross: p.price,
                net: p.price,
                linked: true,
            };

            if (p.hasSalesPrice && p.salePercentage) {
                const originalPrice = Math.round((p.price / (1 - p.salePercentage)) * 100) / 100;
                priceEntry.listPrice = {
                    currencyId: currencyId,
                    gross: originalPrice,
                    net: originalPrice,
                    linked: true,
                };
            }

            const product: ProductSyncPayload = {
                id: p.id,
                productNumber: `AI-${p.id}`,
                name: p.name,
                description: p.description,
                stock: p.stock,
                taxId: taxId,
                price: [priceEntry],
                visibilities: [
                    {
                        id: this.generateVisibilityId(p.id, salesChannelId),
                        productId: p.id,
                        salesChannelId: salesChannelId,
                        visibility: 30,
                    },
                ],
                categories,
                markAsTopseller: p.isTopseller ?? false,
                shippingFree: p.isShippingFree ?? false,
                weight: p.weight,
                width: p.width,
                height: p.height,
                length: p.length,
                ean: p.ean,
                manufacturerNumber: p.manufacturerNumber,
            };

            // "New" badge: always set to current upload time so the badge
            // never ages out on the storefront, regardless of when the blueprint
            // was originally generated.
            if (p.isNew) {
                product.releaseDate = new Date().toISOString();
            }

            // Delivery time (deterministic round-robin via index set in Phase 1)
            if (p.deliveryTimeIndex !== undefined && deliveryTimeIds.length > 0) {
                product.deliveryTimeId =
                    deliveryTimeIds[p.deliveryTimeIndex % deliveryTimeIds.length];
            }

            // Purchase constraints
            if (p.minPurchase) {
                product.minPurchase = p.minPurchase;
                product.purchaseSteps = p.purchaseSteps ?? p.minPurchase;
            }
            if (p.maxPurchase) {
                product.maxPurchase = p.maxPurchase;
            }

            // SEO metadata
            if (p.metaTitle) {
                product.metaTitle = p.metaTitle;
            }
            if (p.metaDescription) {
                product.metaDescription = p.metaDescription;
            }

            // Property options
            if (p.options && p.options.length > 0) {
                product.properties = p.options.map((option) => ({ id: option.id }));
            }

            // Graduated/tiered pricing via product_price entities.
            // IDs are derived deterministically from the product UUID so re-syncs
            // upsert the existing rows instead of appending duplicates.
            if (p.hasTieredPricing && ruleId) {
                const round = (v: number): number => Math.round(v * 100) / 100;
                // Replace last hex digit of product UUID with tier index (0-f).
                // Guarantees a stable, valid UUID for up to 16 tiers per product.
                const tierId = (i: number): string => p.id.slice(0, -1) + i.toString(16);
                const tieredPrices: TieredPricePayload[] = [
                    {
                        id: tierId(0),
                        ruleId,
                        quantityStart: 1,
                        quantityEnd: 9,
                        price: [
                            {
                                currencyId,
                                gross: round(p.price),
                                net: round(p.price),
                                linked: true,
                            },
                        ],
                    },
                    {
                        id: tierId(1),
                        ruleId,
                        quantityStart: 10,
                        quantityEnd: 49,
                        price: [
                            {
                                currencyId,
                                gross: round(p.price * 0.9),
                                net: round(p.price * 0.9),
                                linked: true,
                            },
                        ],
                    },
                    {
                        id: tierId(2),
                        ruleId,
                        quantityStart: 50,
                        price: [
                            {
                                currencyId,
                                gross: round(p.price * 0.8),
                                net: round(p.price * 0.8),
                                linked: true,
                            },
                        ],
                    },
                ];
                product.prices = tieredPrices;
            }

            return product;
        });

        // Sync products in batches of 50
        const BATCH_SIZE = 50;
        let created = 0;

        for (let i = 0; i < productPayload.length; i += BATCH_SIZE) {
            const batch = productPayload.slice(i, i + BATCH_SIZE);

            try {
                await this.sync([{ entity: "product", action: "upsert", payload: batch }]);
                created += batch.length;
            } catch (error) {
                logger.apiError("_action/sync (products)", 400, {
                    request: batch.slice(0, 2),
                    response: error,
                });
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
        const mediaPayload: MediaEntityPayload[] = [];

        const productPayload = products.map((p: ProductInput) => {
            const UUID = generateUUID();

            const product: ProductSyncPayload = {
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
                product.properties = p.options
                    .filter(
                        (option: PropertyOption): option is PropertyOption & { id: string } =>
                            option.id != null
                    )
                    .map((option) => ({ id: option.id }));
            }

            if (p.image) {
                const mediaId = generateUUID();
                const productMediaId = generateUUID();

                mediaUploads.push({
                    id: mediaId,
                    image: p.image,
                });

                const mediaEntry: MediaEntityPayload = {
                    id: mediaId,
                    private: false,
                    ...(productMediaFolderId && { mediaFolderId: productMediaFolderId }),
                };
                mediaPayload.push(mediaEntry);

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

        logger.debug("Syncing products", {
            data: {
                productCount: productPayload.length,
                mediaCount: mediaPayload.length,
                categoryId: productCategory.id,
                categoryName: productCategory.name,
            },
        });

        // Build sync operations
        const syncOps: SyncOperation[] = [
            { entity: "product", action: "upsert", payload: productPayload },
        ];

        if (mediaPayload.length > 0) {
            syncOps.push({ entity: "media", action: "upsert", payload: mediaPayload });
        }

        let syncSuccess = true;
        try {
            await this.sync(syncOps);
            logger.debug("Product sync successful");
        } catch (error) {
            logger.apiError("_action/sync (products)", 400, {
                request: syncOps,
                response: error,
            });
            syncSuccess = false;
        }

        // Upload media files
        await Promise.all(
            mediaUploads.map(async (media) => {
                const imageBuffer = Buffer.from(media.image.data, "base64");
                await this.uploadMediaBuffer(
                    media.id,
                    imageBuffer,
                    `${media.image.name}-${media.id}`,
                    "png"
                );
            })
        );

        return syncSuccess ? 200 : 400;
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
            logger.warn(validation.warning, { cli: true });
        }

        // Check if SalesChannel already exists
        const existing = await this.findSalesChannelByName(sanitizedName);
        if (existing) {
            logger.info(`Using existing SalesChannel "${existing.name}" (ID: ${existing.id})`, {
                cli: true,
            });
            return { ...existing, isNew: false };
        }

        // Get Storefront config and multi-language/currency IDs in parallel
        const [storefront, usdResult, eurResult, deLanguageResult, deSnippetResult, rootCategory] =
            await Promise.all([
                this.getFullSalesChannel("Storefront"),
                this.getCurrencyId("USD").catch(() => null),
                this.getCurrencyId("EUR").catch(() => null),
                this.getLanguageId("de-DE"),
                this.getSnippetSetId("de-DE"),
                this.createRootCategory(sanitizedName),
            ]);

        // If reusing existing root, clean up old children
        if (!rootCategory.isNew) {
            const deletedCount = await this.deleteChildCategories(rootCategory.id);
            if (deletedCount > 0) {
                logger.info(`Cleaned up ${deletedCount} old categories from existing root`);
            }
        }

        // Resolve currencies: prefer USD for primary (EN domain), EUR for DE domain
        const usdCurrencyId = usdResult ?? storefront.currencyId;
        const eurCurrencyId = eurResult ?? storefront.currencyId;
        const hasGermanDomain = deLanguageResult !== null && deSnippetResult !== null;

        if (!usdResult) {
            logger.warn("USD currency not found in Shopware - using storefront default currency");
        }
        if (!hasGermanDomain) {
            logger.warn(
                "German language (de-DE) or snippet set not found - skipping German domain"
            );
        }

        // Generate access key
        const accessKey = this.generateAccessKey();

        // Determine URLs
        const host = this.envPath?.replace(/^https?:\/\//, "") || "localhost:8000";
        const baseUrl = input.baseUrl || generateSubdomainUrl(sanitizedName, host);
        const germanUrl = generateSubdomainUrl(`${sanitizedName}-de`, host);

        // Create the SalesChannel
        const salesChannelId = generateUUID();

        const languages = [{ id: storefront.languageId }];
        const currencies = [{ id: usdCurrencyId }];
        const domains: Array<{
            id: string;
            url: string;
            languageId: string;
            currencyId: string;
            snippetSetId: string | undefined;
        }> = [
            {
                id: generateUUID(),
                url: baseUrl,
                languageId: storefront.languageId,
                currencyId: usdCurrencyId,
                snippetSetId: storefront.snippetSetId,
            },
        ];

        if (hasGermanDomain) {
            languages.push({ id: deLanguageResult as string });
            if (eurCurrencyId !== usdCurrencyId) {
                currencies.push({ id: eurCurrencyId });
            }
            domains.push({
                id: generateUUID(),
                url: germanUrl,
                languageId: deLanguageResult as string,
                currencyId: eurCurrencyId,
                snippetSetId: deSnippetResult as string,
            });
        }

        const payload = {
            id: salesChannelId,
            name: capitalizeString(sanitizedName),
            typeId: storefront.typeId,
            languageId: storefront.languageId,
            currencyId: usdCurrencyId,
            paymentMethodId: storefront.paymentMethodId,
            shippingMethodId: storefront.shippingMethodId,
            countryId: storefront.countryId,
            customerGroupId: storefront.customerGroupId,
            navigationCategoryId: rootCategory.id,
            accessKey,
            active: true,
            languages,
            currencies,
            paymentMethods: [{ id: storefront.paymentMethodId }],
            shippingMethods: [{ id: storefront.shippingMethodId }],
            countries: [{ id: storefront.countryId }],
            domains,
        };

        await this.sync([
            {
                entity: "sales_channel",
                action: "upsert",
                payload: [payload],
            },
        ]);

        const domainUrls = domains.map((d) => d.url).join(", ");
        logger.info(`Created SalesChannel "${sanitizedName}" with domains: ${domainUrls}`, {
            cli: true,
        });

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
            currencyId: usdCurrencyId,
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

        const { data: searchData } = await this.getClient().invoke(
            "searchSalesChannel post /search/sales-channel",
            {
                body: {
                    limit: 1,
                    filter: [{ type: "equals", field: "name", value: capitalizedName }],
                },
            }
        );
        const result = searchData as SearchResult<Schemas["SalesChannel"]>;

        if (result.data?.[0]) {
            // Fetch full details including snippetSetId
            try {
                return await this.getFullSalesChannel(capitalizedName);
            } catch {
                // If we can't get full details, return what we have
                const sc = result.data[0];
                return {
                    id: sc.id ?? "",
                    name: sc.name ?? capitalizedName,
                    typeId: sc.typeId ?? "",
                    languageId: sc.languageId ?? "",
                    currencyId: sc.currencyId ?? "",
                    paymentMethodId: sc.paymentMethodId ?? "",
                    shippingMethodId: sc.shippingMethodId ?? "",
                    countryId: sc.countryId ?? "",
                    customerGroupId: sc.customerGroupId ?? "",
                    navigationCategoryId: sc.navigationCategoryId ?? "",
                };
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
        const displayName = capitalizeString(name);
        const categoryName = `${displayName} Demo-Store`;

        // Check if a root category with this name already exists
        const { data: searchData } = await this.getClient().invoke(
            "searchCategory post /search/category",
            {
                body: {
                    limit: 1,
                    filter: [{ type: "equals", field: "name", value: categoryName }],
                },
            }
        );
        const searchResult = searchData as SearchResult<Schemas["Category"]>;

        if (searchResult.data?.[0]) {
            logger.info(
                `Reusing existing root category: ${categoryName} (ID: ${searchResult.data[0].id})`
            );
            return { id: searchResult.data[0].id, name: categoryName, isNew: false };
        }

        // Create new root category
        const rootCategoryId = generateUUID();
        await this.sync([
            {
                entity: "category",
                action: "upsert",
                payload: [
                    {
                        id: rootCategoryId,
                        name: categoryName,
                        displayNestedProducts: true,
                        type: "page",
                        productAssignmentType: "product",
                        visible: false,
                        active: true,
                    },
                ],
            },
        ]);

        logger.info(`Created root category: ${categoryName}`, { cli: true });
        return {
            id: rootCategoryId,
            name: categoryName,
            isNew: true,
        };
    }

    /**
     * Delete all child categories of a parent category.
     * Used to clean up before regenerating a category tree.
     */
    async deleteChildCategories(parentCategoryId: string): Promise<number> {
        const { data: searchData } = await this.getClient().invoke(
            "searchCategory post /search/category",
            {
                body: {
                    filter: [{ type: "equals", field: "parentId", value: parentCategoryId }],
                    limit: 500,
                },
            }
        );
        const searchResult = searchData as SearchResult<Schemas["Category"]>;

        const children = searchResult.data ?? [];
        if (children.length === 0) {
            return 0;
        }

        // Recursively delete children of each child first
        for (const child of children) {
            await this.deleteChildCategories(child.id);
        }

        // Delete all child categories
        const deletePayload = children.map((c) => ({ id: c.id }));
        await this.sync([
            {
                entity: "category",
                action: "delete",
                payload: deletePayload,
            },
        ]);

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
        const existingMap = await this.getExistingCategoryMap(parentId, tree);
        if (existingMap.size > 0) {
            logger.debug("Found existing categories for reuse", {
                data: { count: existingMap.size },
            });
        }

        const categoryIdMap = new Map<string, string>();

        // Build flat list of categories with parent relationships and paths
        const flatCategories = this.flattenCategoryTree(tree, parentId);

        // Track last sibling ID per parent for afterCategoryId chaining
        const lastSiblingIdByParent = new Map<string, string>();

        // Create categories in batches using sync API with afterCategoryId for ordering
        const categoryPayload = flatCategories.map((item) => {
            const id = item.category.id || generateUUID();
            const afterCategoryId =
                lastSiblingIdByParent.get(item.parentId) ?? (null as string | null);
            lastSiblingIdByParent.set(item.parentId, id);

            return {
                id,
                name: item.category.name,
                description: item.category.description,
                parentId: item.parentId,
                afterCategoryId,
                displayNestedProducts: true,
                type: "page",
                productAssignmentType: "product",
                visible: true,
                active: true,
            };
        });

        // Store IDs in the original tree nodes using path as key (prevents collisions)
        for (let i = 0; i < flatCategories.length; i++) {
            const item = flatCategories[i];
            const payloadItem = categoryPayload[i];
            if (item && payloadItem) {
                item.category.id = payloadItem.id;
                categoryIdMap.set(item.path, payloadItem.id);
            }
        }

        await this.sync([
            {
                entity: "category",
                action: "upsert",
                payload: categoryPayload,
            },
        ]);

        logger.info(`Created ${categoryPayload.length} categories`, { cli: true });

        // Upload category images
        await this.uploadCategoryImages(flatCategories.map((f) => f.category));

        return categoryIdMap;
    }

    /**
     * Get existing categories under a parent and map them to the expected category tree.
     * Uses full paths as keys to avoid collisions with duplicate names.
     *
     * @returns Map of category paths to their Shopware IDs
     */
    async getExistingCategoryMap(
        parentCategoryId: string,
        expectedTree: CategoryNode[]
    ): Promise<Map<string, string>> {
        const categoryIdMap = new Map<string, string>();

        const { data: searchData } = await this.getClient().invoke(
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
                                    value: parentCategoryId,
                                },
                                {
                                    type: "contains",
                                    field: "path",
                                    value: parentCategoryId,
                                },
                            ],
                        },
                    ],
                },
            }
        );
        const searchResult = searchData as SearchResult<Schemas["Category"]>;

        const existingCategories = searchResult.data ?? [];
        if (existingCategories.length === 0) {
            return categoryIdMap;
        }

        // Build parent-child relationships to reconstruct paths
        const categoriesById = new Map<string, { id: string; name: string; parentId: string }>();
        for (const cat of existingCategories) {
            categoriesById.set(cat.id, {
                id: cat.id,
                name: cat.name ?? "",
                parentId: cat.parentId ?? "",
            });
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
     * Uses SHA256 hash for collision resistance.
     */
    private generateVisibilityId(productId: string, salesChannelId: string): string {
        const hash = createHash("sha256").update(`${productId}:${salesChannelId}`).digest("hex");
        return hash.slice(0, 32);
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
            await this.sync([
                {
                    entity: "media",
                    action: "upsert",
                    payload: [
                        {
                            id: mediaId,
                            private: false,
                            ...(productMediaFolderId && {
                                mediaFolderId: productMediaFolderId,
                            }),
                        },
                    ],
                },
            ]);

            // Upload the image
            const imageBuffer = Buffer.from(category.image.data, "base64");
            await this.uploadMediaBuffer(mediaId, imageBuffer, `category-${category.id}`, "png");

            // Associate media with category
            await this.sync([
                {
                    entity: "category",
                    action: "upsert",
                    payload: [{ id: category.id, mediaId }],
                },
            ]);

            logger.info(`Uploaded image for category "${category.name}"`, { cli: true });
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
            const { data: folderSearchData } = await this.getClient().invoke(
                "searchMediaFolder post /search/media-folder",
                {
                    body: {
                        filter: [{ type: "equals", field: "name", value: folderName }],
                        limit: 1,
                    },
                }
            );
            const folderResult = folderSearchData as SearchResult<Schemas["MediaFolder"]>;

            if (folderResult.data?.[0]) {
                return folderResult.data[0].id;
            }

            // Get default configuration to use for the folder
            const { data: configSearchData } = await this.getClient().invoke(
                "searchMediaDefaultFolder post /search/media-default-folder",
                {
                    body: {
                        filter: [{ type: "equals", field: "entity", value: "product" }],
                        limit: 1,
                    },
                }
            );
            const configResult = configSearchData as SearchResult<Schemas["MediaDefaultFolder"]>;
            const defaultConfigs = configResult.data ?? [];

            // Create new folder
            const folderId = generateUUID();
            await this.sync([
                {
                    entity: "media_folder",
                    action: "upsert",
                    payload: [
                        {
                            id: folderId,
                            name: folderName,
                            useParentConfiguration: true,
                            ...(defaultConfigs[0] && {
                                configurationId: defaultConfigs[0].id,
                            }),
                        },
                    ],
                },
            ]);

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
            await this.sync([
                {
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
            ]);
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
    async uploadMediaFile(mediaId: string, buffer: Buffer, extension: string): Promise<boolean> {
        if (!this.isAuthenticated()) return false;

        try {
            await this.uploadMediaBuffer(mediaId, buffer, `color-option-${mediaId}`, extension);
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
    async updatePropertyOptionMedia(optionId: string, mediaId: string): Promise<boolean> {
        if (!this.isAuthenticated()) return false;

        try {
            await this.sync([
                {
                    entity: "property_group_option",
                    action: "upsert",
                    payload: [{ id: optionId, mediaId, colorHexCode: null }],
                },
            ]);
            return true;
        } catch (error) {
            logger.warn(
                `Failed to update property option media: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
        }
    }
}
