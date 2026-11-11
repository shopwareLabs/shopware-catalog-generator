import { createHash } from "crypto";

import type { UnitDefinition } from "../fixtures/index.js";
import type {
    CategoryNode,
    DomainMeasurementUnits,
    MediaEntityPayload,
    PricePayload,
    ProductCustomFieldValues,
    ProductPackaging,
    ProductSyncPayload,
    ProductInput,
    ProductType,
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
import type { SalesChannelCloneSource } from "./client.js";

import {
    buildCustomFieldConfig,
    currencyForLocale,
    DEFAULT_DOMAIN_LOCALES,
    PRODUCT_CUSTOM_FIELD_SET,
} from "../fixtures/index.js";
import { IMPERIAL_MEASUREMENT_UNITS } from "../types/index.js";
import {
    buildCategoryPath,
    CATEGORY_PATH_SEPARATOR,
    capitalizeString,
    generateSubdomainUrl,
    generateUUID,
    logger,
    validateSubdomainName,
} from "../utils/index.js";
import { ShopwareClient, toCloneSource } from "./client.js";

interface SalesChannelDomainPayload {
    id: string;
    url: string;
    languageId: string;
    currencyId: string;
    snippetSetId: string | undefined;
    measurementUnits?: DomainMeasurementUnits;
}

interface ResolvedLocaleDomain {
    locale: string;
    languageId: string;
    snippetSetId: string;
    currencyId: string;
    urlSuffix: string;
}

/**
 * Extra domain locales for a new SalesChannel: the defaults (de-DE) plus the requested
 * ones. English locales are left out, the primary domain already serves English.
 */
export function domainLocales(requested: readonly string[] = []): string[] {
    const isEnglish = (locale: string) => locale.toLowerCase().startsWith("en");
    return [...new Set([...DEFAULT_DOMAIN_LOCALES, ...requested])].filter((l) => !isEnglish(l));
}

/**
 * Subdomain suffix for a locale: the language ("de"), or the full locale ("de-ch") when
 * another locale of the same language is in the list.
 */
export function domainUrlSuffix(locale: string, allLocales: readonly string[]): string {
    const language = locale.split("-")[0]?.toLowerCase() ?? locale.toLowerCase();
    const sameLanguage = allLocales.filter(
        (l) => (l.split("-")[0]?.toLowerCase() ?? "") === language
    );
    if (sameLanguage.length <= 1 || sameLanguage[0] === locale) return language;
    return locale.toLowerCase();
}

function uniqueIds(ids: string[]): Array<{ id: string }> {
    return [...new Set(ids)].map((id) => ({ id }));
}

function isNonEmptyId(id: string | undefined): id is string {
    return Boolean(id);
}

/** Validated, subdomain-safe SalesChannel name (throws on invalid input) */
function sanitizeSalesChannelName(name: string): string {
    const validation = validateSubdomainName(name);
    if (!validation.valid) {
        throw new Error(`Invalid SalesChannel name: ${validation.error}`);
    }
    if (validation.warning) {
        logger.warn(validation.warning, { cli: true });
    }
    return validation.sanitized;
}

function primaryCurrencyId(usdCurrencyId: string | null, storefrontCurrencyId: string): string {
    if (usdCurrencyId) {
        return usdCurrencyId;
    }
    logger.warn("USD currency not found in Shopware - using storefront default currency");
    return storefrontCurrencyId;
}

type ClonedSalesChannelFields = Omit<
    SalesChannelCloneSource,
    "id" | "name" | "navigationCategoryId"
>;

/** A freshly created SalesChannel as returned by createSalesChannel */
type NewSalesChannel = SalesChannelCloneSource & { accessKey: string; isNew: boolean };

/** Settings a new SalesChannel copies from the Storefront */
function newSalesChannelFrom(
    storefront: SalesChannelCloneSource,
    currencyId: string
): ClonedSalesChannelFields & { isNew: boolean } {
    return {
        typeId: storefront.typeId,
        languageId: storefront.languageId,
        currencyId,
        paymentMethodId: storefront.paymentMethodId,
        shippingMethodId: storefront.shippingMethodId,
        countryId: storefront.countryId,
        customerGroupId: storefront.customerGroupId,
        snippetSetId: storefront.snippetSetId,
        isNew: true,
    };
}

/** Sync payload for a new SalesChannel with its domains, languages and currencies */
function salesChannelPayload(
    salesChannel: NewSalesChannel,
    domains: SalesChannelDomainPayload[]
): Record<string, unknown> {
    const { snippetSetId: _snippetSetId, isNew: _isNew, ...fields } = salesChannel;
    return {
        ...fields,
        active: true,
        languages: uniqueIds(domains.map((d) => d.languageId)),
        currencies: uniqueIds(domains.map((d) => d.currencyId)),
        paymentMethods: [{ id: salesChannel.paymentMethodId }],
        shippingMethods: [{ id: salesChannel.shippingMethodId }],
        countries: [{ id: salesChannel.countryId }],
        domains,
    };
}

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

        const groupIds = propertyGroups.map((g) => g.id).filter(isNonEmptyId);
        const optionIds = propertyGroups
            .flatMap((g) => g.options.map((o) => o.id))
            .filter(isNonEmptyId);

        if (groupIds.length === 0 && optionIds.length === 0) {
            return false;
        }

        try {
            const foundGroups = await this.countExistingIds(
                "searchPropertyGroup post /search/property-group",
                groupIds
            );
            if (foundGroups !== groupIds.length) {
                logger.debug("Property groups verification failed", {
                    data: { requestedGroups: groupIds.length, foundGroups },
                });
                return false;
            }

            const foundOptions = await this.countExistingIds(
                "searchPropertyGroupOption post /search/property-group-option",
                optionIds
            );
            if (foundOptions !== optionIds.length) {
                logger.debug("Property options verification failed", {
                    data: { requestedOptions: optionIds.length, foundOptions },
                });
                return false;
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

    /** Count how many of the given IDs exist (0 without a request when the list is empty) */
    private async countExistingIds(
        operation:
            | "searchPropertyGroup post /search/property-group"
            | "searchPropertyGroupOption post /search/property-group-option",
        ids: string[]
    ): Promise<number> {
        if (ids.length === 0) {
            return 0;
        }
        const { data } = await this.getClient().invoke(operation, {
            body: {
                limit: ids.length,
                filter: [{ type: "equalsAny", field: "id", value: ids.join("|") }],
            },
        });
        return (data as SearchResult<unknown>).total ?? 0;
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
                ...(group.filterable !== undefined && { filterable: group.filterable }),
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
     * Ensure `unit` entities exist for the given definitions (idempotent, matched by short code).
     * A fresh Shopware has no units, so missing ones are created.
     *
     * @returns Map of unit short code -> unit ID
     */
    async ensureUnits(units: UnitDefinition[]): Promise<Map<string, string>> {
        const unitIds = new Map<string, string>();
        if (units.length === 0) return unitIds;

        const { data } = await this.getClient().invoke(
            "searchUnit post /search/unit" as never,
            {
                body: {
                    limit: 100,
                    filter: [
                        {
                            type: "equalsAny",
                            field: "shortCode",
                            value: units.map((unit) => unit.shortCode),
                        },
                    ],
                },
            } as never
        );
        const existing = (data as { data?: Array<{ id: string; shortCode: string }> })?.data ?? [];
        for (const unit of existing) {
            unitIds.set(unit.shortCode, unit.id);
        }

        const missing = units.filter((unit) => !unitIds.has(unit.shortCode));
        if (missing.length === 0) return unitIds;

        const payload = missing.map((unit) => ({
            id: generateUUID(),
            shortCode: unit.shortCode,
            name: unit.name,
        }));
        await this.sync([{ entity: "unit", action: "upsert", payload }]);
        for (const unit of payload) {
            unitIds.set(unit.shortCode, unit.id);
        }
        logger.info(
            `  ✓ Created ${payload.length} unit(s): ${missing.map((u) => u.name).join(", ")}`,
            {
                cli: true,
            }
        );
        return unitIds;
    }

    /**
     * Ensure the product custom field set from `fixtures/custom-fields.ts` exists (idempotent, found by name).
     *
     * @param includeInSearch - Send `includeInSearch` per field (Shopware 6.7.7+ only)
     * @returns ID of the custom field set
     */
    async ensureProductCustomFieldSet(includeInSearch: boolean): Promise<string> {
        const set = PRODUCT_CUSTOM_FIELD_SET;
        const { data } = await this.getClient().invoke(
            "searchCustomFieldSet post /search/custom-field-set" as never,
            {
                body: { limit: 1, filter: [{ type: "equals", field: "name", value: set.name }] },
            } as never
        );
        const existing = (data as { data?: Array<{ id: string }> })?.data?.[0];
        if (existing) {
            logger.info(`  ⊘ Custom field set "${set.name}" already exists`, { cli: true });
            return existing.id;
        }

        const setId = generateUUID();
        await this.sync([
            {
                entity: "custom_field_set",
                action: "upsert",
                payload: [
                    {
                        id: setId,
                        name: set.name,
                        active: true,
                        global: false,
                        position: 1,
                        config: { label: { "en-GB": set.label } },
                        relations: set.entities.map((entityName) => ({
                            id: generateUUID(),
                            entityName,
                        })),
                        customFields: set.fields.map((field, index) => ({
                            id: generateUUID(),
                            name: field.name,
                            type: field.type,
                            active: true,
                            config: {
                                ...buildCustomFieldConfig(field),
                                customFieldPosition: index + 1,
                            },
                            ...(includeInSearch && { includeInSearch: field.includeInSearch }),
                        })),
                    },
                ],
            },
        ]);
        logger.info(`  ✓ Created custom field set "${set.name}" (${set.fields.length} fields)`, {
            cli: true,
        });
        return setId;
    }

    /**
     * Direct product creation with explicit category IDs
     * Used by the new generate flow that passes all category assignments
     */
    async hydrateEnvWithProductsDirect(
        products: DirectProductInput[],
        salesChannelId: string,
        navigationCategoryId: string
    ): Promise<number> {
        if (!this.isAuthenticated()) {
            return 0;
        }

        const hasTieredProducts = products.some((p) => p.hasTieredPricing);

        const [taxId, currencyId, deliveryTimeIds, ruleId, unitIds] = await Promise.all([
            this.getStandardTaxId(),
            this.getDefaultCurrencyId(),
            this.getDeliveryTimeIds(),
            hasTieredProducts ? this.getAlwaysValidRuleId() : Promise.resolve(null),
            this.ensureUnits(collectPackagingUnits(products)).catch((error: unknown) => {
                logger.warn("Could not create units - products are uploaded without unitId", {
                    cli: true,
                    data: error,
                });
                return new Map<string, string>();
            }),
        ]);

        const upload: ProductUploadContext = {
            taxId,
            currencyId,
            deliveryTimeIds,
            ruleId,
            unitIds,
            salesChannelId,
            navigationCategoryId,
        };
        const productPayload = products.map((p) => buildDirectProductPayload(p, upload));

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

        await this.unlinkRemovedProductOptions(products);
        return created;
    }

    /**
     * Delete product_property links that a product no longer has (e.g. the colour of a
     * variant parent from an older run). Links that do not exist are ignored by Shopware.
     */
    private async unlinkRemovedProductOptions(products: DirectProductInput[]): Promise<void> {
        const links = products.flatMap((p) =>
            (p.removedOptionIds ?? []).map((optionId) => ({ productId: p.id, optionId }))
        );
        if (links.length === 0) return;
        try {
            await this.sync([{ entity: "product_property", action: "delete", payload: links }]);
        } catch (error) {
            logger.warn(`Could not unlink ${links.length} variant group properties`, {
                cli: true,
                data: error,
            });
        }
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
            currencyId = await this.getDefaultCurrencyId();
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

        const sanitizedName = sanitizeSalesChannelName(input.name);

        // Check if SalesChannel already exists
        const existing = await this.findSalesChannelByName(sanitizedName);
        if (existing) {
            logger.info(`Using existing SalesChannel "${existing.name}" (ID: ${existing.id})`, {
                cli: true,
            });
            return { ...existing, isNew: false };
        }

        // Get Storefront config, USD and the extra language domains in parallel
        const [storefront, usdResult, rootCategory] = await Promise.all([
            this.getFullSalesChannel("Storefront"),
            this.getCurrencyId("USD").catch(() => null),
            this.createRootCategory(sanitizedName),
        ]);

        await this.clearReusedRootCategory(rootCategory);

        const salesChannel: NewSalesChannel = {
            // Primary (English) domain uses USD when available
            ...newSalesChannelFrom(storefront, primaryCurrencyId(usdResult, storefront.currencyId)),
            accessKey: this.generateAccessKey(),
            id: generateUUID(),
            name: capitalizeString(sanitizedName),
            navigationCategoryId: rootCategory.id,
        };
        const domains = await this.buildSalesChannelDomains(
            input,
            sanitizedName,
            salesChannel,
            storefront.currencyId
        );

        await this.sync([
            {
                entity: "sales_channel",
                action: "upsert",
                payload: [salesChannelPayload(salesChannel, domains)],
            },
        ]);

        const domainUrls = domains.map((d) => d.url).join(", ");
        logger.info(`Created SalesChannel "${sanitizedName}" with domains: ${domainUrls}`, {
            cli: true,
        });

        await this.assignStorefrontTheme(storefront.id, salesChannel.id);
        return salesChannel;
    }

    /** A reused root category keeps no children from an earlier run */
    private async clearReusedRootCategory(root: { id: string; isNew: boolean }): Promise<void> {
        if (root.isNew) {
            return;
        }
        const deletedCount = await this.deleteChildCategories(root.id);
        if (deletedCount > 0) {
            logger.info(`Cleaned up ${deletedCount} old categories from existing root`);
        }
    }

    /**
     * English domain (the SalesChannel's language and currency) plus one domain per extra
     * locale that is installed and differs from the Storefront language.
     */
    private async buildSalesChannelDomains(
        input: SalesChannelInput,
        sanitizedName: string,
        salesChannel: NewSalesChannel,
        fallbackCurrencyId: string
    ): Promise<SalesChannelDomainPayload[]> {
        const host = this.envPath?.replace(/^https?:\/\//, "") || "localhost:8000";
        const localeDomains = await this.resolveLocaleDomains(
            domainLocales(input.locales),
            fallbackCurrencyId
        );
        const primary: SalesChannelDomainPayload = {
            id: generateUUID(),
            url: input.baseUrl || generateSubdomainUrl(sanitizedName, host),
            languageId: salesChannel.languageId,
            currencyId: salesChannel.currencyId,
            snippetSetId: salesChannel.snippetSetId,
            // USD domain shows inches/pounds; the other domains keep Shopware's metric default
            ...(input.imperialEnglishDomain && { measurementUnits: IMPERIAL_MEASUREMENT_UNITS }),
        };
        const extra = localeDomains
            .filter((d) => d.languageId !== salesChannel.languageId)
            .map((d) => ({
                id: generateUUID(),
                url: generateSubdomainUrl(`${sanitizedName}-${d.urlSuffix}`, host),
                languageId: d.languageId,
                currencyId: d.currencyId,
                snippetSetId: d.snippetSetId,
            }));
        return [primary, ...extra];
    }

    /** Assign the same theme as the Storefront SalesChannel */
    private async assignStorefrontTheme(
        storefrontId: string,
        salesChannelId: string
    ): Promise<void> {
        const storefrontThemeId = await this.getThemeForSalesChannel(storefrontId);
        if (!storefrontThemeId) {
            logger.warn(
                "No theme found for Storefront - new SalesChannel may not display correctly"
            );
            return;
        }
        await this.assignThemeToSalesChannel(salesChannelId, storefrontThemeId);
    }

    /**
     * Language, snippet set and currency for each extra domain locale.
     * Locales that are not installed in Shopware are skipped with a warning.
     */
    private async resolveLocaleDomains(
        locales: string[],
        fallbackCurrencyId: string
    ): Promise<ResolvedLocaleDomain[]> {
        const resolved = await Promise.all(
            locales.map(async (locale): Promise<ResolvedLocaleDomain | null> => {
                const currencyIso = currencyForLocale(locale);
                const [languageId, snippetSetId, currencyId] = await Promise.all([
                    this.getLanguageId(locale),
                    this.getSnippetSetId(locale),
                    currencyIso ? this.getCurrencyId(currencyIso).catch(() => null) : null,
                ]);
                if (!languageId || !snippetSetId) {
                    logger.warn(
                        `Language ${locale} or its snippet set is not installed - skipping the ${locale} domain`,
                        { cli: true }
                    );
                    return null;
                }
                return {
                    locale,
                    languageId,
                    snippetSetId,
                    currencyId: currencyId ?? fallbackCurrencyId,
                    urlSuffix: domainUrlSuffix(locale, locales),
                };
            })
        );
        return resolved.filter((d): d is ResolvedLocaleDomain => d !== null);
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
        const found = (searchData as SearchResult<Schemas["SalesChannel"]>).data?.[0];
        if (!found) {
            return null;
        }

        // Fetch full details including snippetSetId
        try {
            return await this.getFullSalesChannel(capitalizedName);
        } catch {
            // If we can't get full details, return what we have (without a snippet set)
            const { snippetSetId: _snippetSetId, ...basics } = toCloneSource(found);
            return { ...basics, name: found.name ?? capitalizedName };
        }
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
                visible: item.category.visible ?? true,
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

/**
 * Distinct unit definitions needed by the given products (by short code).
 */
function collectPackagingUnits(
    products: Array<{ packaging?: ProductPackaging }>
): UnitDefinition[] {
    const byShortCode = new Map<string, UnitDefinition>();
    for (const { packaging } of products) {
        if (!packaging || byShortCode.has(packaging.unitShortCode)) continue;
        byShortCode.set(packaging.unitShortCode, {
            shortCode: packaging.unitShortCode,
            name: packaging.unitName,
        });
    }
    return [...byShortCode.values()];
}

/** Product as passed to `hydrateEnvWithProductsDirect` (built from blueprint products) */
interface DirectProductInput {
    id: string;
    name: string;
    description: string;
    price: number;
    stock: number;
    categoryIds?: string[];
    options?: Array<{ id: string; name: string }>;
    /** Property options to unlink (left out on purpose, may exist from an older run) */
    removedOptionIds?: string[];
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
    type?: ProductType;
    packaging?: ProductPackaging;
    customFields?: ProductCustomFieldValues;
    ogTitle?: string;
    ogDescription?: string;
}

/** Shop lookups shared by every product of one upload */
interface ProductUploadContext {
    taxId: string;
    currencyId: string;
    deliveryTimeIds: string[];
    ruleId: string | null;
    unitIds: Map<string, string>;
    salesChannelId: string;
    navigationCategoryId: string;
}

const roundPrice = (value: number): number => Math.round(value * 100) / 100;

function linkedPrice(currencyId: string, gross: number): PricePayload {
    return { currencyId, gross, net: gross, linked: true };
}

/**
 * Deterministic visibility ID from product and SalesChannel IDs (SHA256 for collision resistance).
 */
function visibilityId(productId: string, salesChannelId: string): string {
    return createHash("sha256").update(`${productId}:${salesChannelId}`).digest("hex").slice(0, 32);
}

/**
 * Base price. Sale items also get a list price and the lowest price of the last 30 days
 * (EU price indication), which lies between sale and list price.
 */
function productPrice(p: DirectProductInput, currencyId: string): PricePayload {
    const price = linkedPrice(currencyId, p.price);
    if (!p.hasSalesPrice || !p.salePercentage) return price;

    const listPrice = roundPrice(p.price / (1 - p.salePercentage));
    return {
        ...price,
        listPrice: linkedPrice(currencyId, listPrice),
        regulationPrice: linkedPrice(currencyId, roundPrice((p.price + listPrice) / 2)),
    };
}

/** Graduated prices: 1-9 full price, 10-49 minus 10%, 50+ minus 20% */
const PRICE_TIERS: Array<{ quantityStart: number; quantityEnd?: number; factor: number }> = [
    { quantityStart: 1, quantityEnd: 9, factor: 1 },
    { quantityStart: 10, quantityEnd: 49, factor: 0.9 },
    { quantityStart: 50, factor: 0.8 },
];

/**
 * Tiered prices via product_price entities. The last hex digit of the product UUID is replaced
 * by the tier index, so re-syncs upsert the same rows instead of appending duplicates.
 */
function tieredPrices(
    p: DirectProductInput,
    ruleId: string,
    currencyId: string
): TieredPricePayload[] {
    return PRICE_TIERS.map((tier, index) => ({
        id: p.id.slice(0, -1) + index.toString(16),
        ruleId,
        quantityStart: tier.quantityStart,
        ...(tier.quantityEnd !== undefined && { quantityEnd: tier.quantityEnd }),
        price: [linkedPrice(currencyId, roundPrice(p.price * tier.factor))],
    }));
}

/** Packaging / reference price ("6 pc, 1 pc = $4.99") */
function packagingFields(
    packaging: ProductPackaging,
    unitIds: Map<string, string>
): Partial<ProductSyncPayload> {
    const unitId = unitIds.get(packaging.unitShortCode);
    return {
        ...(unitId && { unitId }),
        purchaseUnit: packaging.purchaseUnit,
        referenceUnit: packaging.referenceUnit,
        packUnit: packaging.packUnit,
        packUnitPlural: packaging.packUnitPlural,
    };
}

/** Purchase limits and SEO fields, only when set */
function purchaseAndSeoFields(p: DirectProductInput): Partial<ProductSyncPayload> {
    return {
        ...(p.minPurchase && {
            minPurchase: p.minPurchase,
            purchaseSteps: p.purchaseSteps ?? p.minPurchase,
        }),
        ...(p.maxPurchase && { maxPurchase: p.maxPurchase }),
        ...(p.metaTitle && { metaTitle: p.metaTitle }),
        ...(p.metaDescription && { metaDescription: p.metaDescription }),
    };
}

/** Delivery time by round-robin over the index set in Phase 1 (stable across runs) */
function deliveryTimeId(p: DirectProductInput, deliveryTimeIds: string[]): string | undefined {
    if (p.deliveryTimeIndex === undefined || deliveryTimeIds.length === 0) return undefined;
    return deliveryTimeIds[p.deliveryTimeIndex % deliveryTimeIds.length];
}

/** Product type, custom fields and Open Graph texts, only when set */
function typeAndMetaFields(p: DirectProductInput): Partial<ProductSyncPayload> {
    return {
        ...(p.type && { type: p.type }),
        ...(p.customFields && { customFields: p.customFields }),
        ...(p.ogTitle && { ogTitle: p.ogTitle }),
        ...(p.ogDescription && { ogDescription: p.ogDescription }),
    };
}

/** Packaging, "New" badge and delivery time, only when set */
function packagingAndDeliveryFields(
    p: DirectProductInput,
    ctx: ProductUploadContext
): Partial<ProductSyncPayload> {
    const delivery = deliveryTimeId(p, ctx.deliveryTimeIds);
    return {
        ...(p.packaging && packagingFields(p.packaging, ctx.unitIds)),
        // "New" badge: always the upload time, so the badge never ages out on the storefront
        ...(p.isNew && { releaseDate: new Date().toISOString() }),
        ...(delivery && { deliveryTimeId: delivery }),
    };
}

/** Property options and tiered prices (tiers need the rule ID) */
function propertyAndTierFields(
    p: DirectProductInput,
    ctx: ProductUploadContext
): Partial<ProductSyncPayload> {
    return {
        ...(p.options?.length && { properties: p.options.map((option) => ({ id: option.id })) }),
        ...(p.hasTieredPricing &&
            ctx.ruleId && { prices: tieredPrices(p, ctx.ruleId, ctx.currencyId) }),
    };
}

function buildDirectProductPayload(
    p: DirectProductInput,
    ctx: ProductUploadContext
): ProductSyncPayload {
    return {
        id: p.id,
        productNumber: `AI-${p.id}`,
        name: p.name,
        description: p.description,
        stock: p.stock,
        taxId: ctx.taxId,
        price: [productPrice(p, ctx.currencyId)],
        visibilities: [
            {
                id: visibilityId(p.id, ctx.salesChannelId),
                productId: p.id,
                salesChannelId: ctx.salesChannelId,
                visibility: 30,
            },
        ],
        // Navigation root first, then every assigned category
        categories: uniqueIds([ctx.navigationCategoryId, ...(p.categoryIds ?? [])]),
        markAsTopseller: p.isTopseller ?? false,
        shippingFree: p.isShippingFree ?? false,
        weight: p.weight,
        width: p.width,
        height: p.height,
        length: p.length,
        ean: p.ean,
        manufacturerNumber: p.manufacturerNumber,
        ...typeAndMetaFields(p),
        ...packagingAndDeliveryFields(p, ctx),
        ...purchaseAndSeoFields(p),
        ...propertyAndTierFields(p, ctx),
    };
}
