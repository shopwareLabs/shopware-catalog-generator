/**
 * Variant Processor - Creates product variants in Shopware
 *
 * Creates child variant products based on property options:
 * - Finds products with isVariant: true in metadata
 * - Converts parent to configurable product
 * - Creates child variants with property options
 * - Applies price modifiers per variant
 */

import { PropertyCache } from "../property-cache.js";
import type { CachedPropertyGroup, VariantConfig } from "../types/index.js";
import { apiPost, cartesianProduct, generateUUID, logger, toKebabCase } from "../utils/index.js";

import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

interface PropertyOption {
    id: string;
    name: string;
}

interface PropertyGroup {
    id: string;
    name: string;
    options: PropertyOption[];
}

/**
 * Variant Processor implementation
 */
class VariantProcessorImpl implements PostProcessor {
    readonly name = "variants";
    readonly description = "Create product variants in Shopware";
    readonly dependsOn: string[] = ["manufacturers"]; // Run after manufacturers

    // Cache for property groups from Shopware
    private shopwareGroupCache: Map<string, PropertyGroup> = new Map();
    // Cache for currency ID
    private currencyId: string | null = null;
    // Track which groups we've ensured exist in Shopware
    private ensuredGroups: Set<string> = new Set();
    // Property cache for group definitions
    private propertyCache: PropertyCache | null = null;

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { blueprint, cache, options } = context;

        let processed = 0;
        let skipped = 0;
        const errors: string[] = [];
        const startTime = Date.now();

        // Initialize store-scoped property cache for this sales channel
        const cacheDir = process.env.CACHE_DIR || "./generated";
        const storeSlug = toKebabCase(context.salesChannelName);
        this.propertyCache = PropertyCache.forStore(cacheDir, storeSlug);

        // Find products with isVariant: true
        const variantProducts = blueprint.products.filter((p) => p.metadata.isVariant);

        if (variantProducts.length === 0) {
            return {
                name: this.name,
                processed: 0,
                skipped: blueprint.products.length,
                errors: [],
                durationMs: Date.now() - startTime,
            };
        }

        console.log(`    Creating variants for ${variantProducts.length} products...`);

        for (const product of variantProducts) {
            const metadata = cache.loadProductMetadata(context.salesChannelName, product.id);

            // Use variantConfigs from metadata (new format)
            const variantConfigs = metadata?.variantConfigs ?? product.metadata.variantConfigs;

            if (!metadata?.isVariant || !variantConfigs || variantConfigs.length === 0) {
                skipped++;
                continue;
            }

            if (options.dryRun) {
                const groupNames = variantConfigs.map((c) => c.group).join(" + ");
                console.log(`      [DRY RUN] ${product.name} -> ${groupNames} variants`);
                processed++;
                continue;
            }

            try {
                // Resolve property groups for each variant config
                const resolvedGroups = await this.resolvePropertyGroups(context, variantConfigs);

                if (resolvedGroups.length === 0) {
                    console.log(`      ⊘ ${product.name}: No suitable property groups found`);
                    skipped++;
                    continue;
                }

                // Check if product already has variants or configurator settings
                const hasVariants = await this.productHasVariants(context, product.id);
                if (hasVariants) {
                    console.log(`      ⊘ ${product.name}: Already configured as variant product`);
                    skipped++;
                    continue;
                }

                // Create variants using cartesian product
                const variantCount = await this.createMultiPropertyVariants(
                    context,
                    product,
                    resolvedGroups
                );

                if (variantCount > 0) {
                    const groupNames = resolvedGroups.map((g) => g.group.name).join(" + ");
                    console.log(`      ✓ ${product.name}: Created ${variantCount} variants (${groupNames})`);
                    processed++;
                } else {
                    // Already configured (0 variants created means duplicate was detected)
                    skipped++;
                }
            } catch (error) {
                const errorMsg = `Failed to create variants for ${product.name}: ${error instanceof Error ? error.message : String(error)}`;
                errors.push(errorMsg);
                logger.warn(errorMsg);
            }
        }

        return {
            name: this.name,
            processed,
            skipped,
            errors,
            durationMs: Date.now() - startTime,
        };
    }

    /**
     * Find property group directly from the blueprint (already has synced Shopware IDs)
     * This is faster and more reliable than searching Shopware API
     */
    private findPropertyGroupInBlueprint(
        context: PostProcessorContext,
        groupName: string
    ): PropertyGroup | null {
        const normalizedName = groupName.toLowerCase().trim();

        // Search in blueprint's property groups
        for (const group of context.blueprint.propertyGroups) {
            if (group.name.toLowerCase() === normalizedName) {
                return {
                    id: group.id,
                    name: group.name,
                    options: group.options.map((o) => ({
                        id: o.id,
                        name: o.name,
                    })),
                };
            }
        }

        // Try partial match
        for (const group of context.blueprint.propertyGroups) {
            const groupLower = group.name.toLowerCase();
            if (groupLower.includes(normalizedName) || normalizedName.includes(groupLower)) {
                return {
                    id: group.id,
                    name: group.name,
                    options: group.options.map((o) => ({
                        id: o.id,
                        name: o.name,
                    })),
                };
            }
        }

        return null;
    }

    /**
     * Get the default currency ID
     */
    private async getCurrencyId(context: PostProcessorContext): Promise<string> {
        if (this.currencyId) {
            return this.currencyId;
        }

        try {
            interface CurrencyResponse {
                data?: Array<{ id: string }>;
            }

            const response = await apiPost(context, "search/currency", {
                filter: [{ type: "equals", field: "isoCode", value: "EUR" }],
                limit: 1,
            });

            if (response.ok) {
                const data = (await response.json()) as CurrencyResponse;
                const currency = data.data?.[0];
                if (currency) {
                    this.currencyId = currency.id;
                    return this.currencyId;
                }
            }
        } catch (error) {
            logger.warn("Failed to get currency ID", { error });
        }

        // Fallback to Shopware's default EUR currency ID
        this.currencyId = "b7d2554b0ce847cd82f3ac9bd1c0dfca";
        return this.currencyId;
    }

    /**
     * Ensure a property group exists in Shopware with all its options
     * Uses PropertyCache for group definitions
     */
    private async ensurePropertyGroupInShopware(
        context: PostProcessorContext,
        groupName: string
    ): Promise<PropertyGroup | null> {
        // Only ensure once per group
        if (this.ensuredGroups.has(groupName)) {
            return await this.getPropertyGroup(context, groupName);
        }

        // Get options from PropertyCache
        let cachedGroup: CachedPropertyGroup | null = null;
        if (this.propertyCache) {
            cachedGroup = this.propertyCache.get(groupName);
        }

        if (!cachedGroup) {
            // No cached definition available
            logger.debug(`No cached property group definition for "${groupName}"`);
            this.ensuredGroups.add(groupName);
            return null;
        }

        // Check if group exists in Shopware
        const existingGroup = await this.getPropertyGroup(context, groupName);

        if (existingGroup && existingGroup.options.length >= cachedGroup.options.length) {
            // Group exists with enough options
            this.ensuredGroups.add(groupName);
            return existingGroup;
        }

        // Create or update the property group with all options from cache
        const groupId = existingGroup?.id || generateUUID();
        const existingOptionNames = new Set(existingGroup?.options.map((o) => o.name) || []);

        // Create options that don't exist
        const newOptions = cachedGroup.options
            .filter((name) => !existingOptionNames.has(name))
            .map((name) => ({
                id: generateUUID(),
                name,
            }));

        if (newOptions.length === 0 && existingGroup) {
            // All options already exist
            this.ensuredGroups.add(groupName);
            return existingGroup;
        }

        console.log(
            `      Creating variant property group "${groupName}" with ${cachedGroup.options.length} options...`
        );

        // Create/update property group with all options
        const allOptions = [...(existingGroup?.options || []), ...newOptions];

        const response = await apiPost(context, "_action/sync", {
            createPropertyGroup: {
                entity: "property_group",
                action: "upsert",
                payload: [
                    {
                        id: groupId,
                        name: cachedGroup.name,
                        sortingType: "alphanumeric",
                        displayType: cachedGroup.displayType,
                        options: allOptions.map((o) => ({
                            id: o.id,
                            name: o.name,
                        })),
                    },
                ],
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.apiError("_action/sync (property group)", response.status, {
                groupName,
                error: errorText,
            });
            this.ensuredGroups.add(groupName);
            return null;
        }

        // Clear Shopware cache so we get fresh data
        this.shopwareGroupCache.delete(groupName);
        this.ensuredGroups.add(groupName);

        // Return the created/updated group
        return await this.getPropertyGroup(context, groupName);
    }

    /**
     * Get property group by name with options from Shopware (supports fuzzy matching)
     */
    private async getPropertyGroup(
        context: PostProcessorContext,
        groupName: string
    ): Promise<PropertyGroup | null> {
        // Check Shopware cache
        const cached = this.shopwareGroupCache.get(groupName);
        if (cached) {
            return cached;
        }

        try {
            interface PropertyGroupResponse {
                data?: Array<{
                    id: string;
                    name: string;
                    options?: Array<{ id: string; name: string }>;
                }>;
            }

            // First try exact match
            let response = await apiPost(context, "search/property-group", {
                filter: [{ type: "equals", field: "name", value: groupName }],
                associations: { options: {} },
                limit: 1,
            });

            if (response.ok) {
                const data = (await response.json()) as PropertyGroupResponse;
                if (data.data?.[0]?.options) {
                    const group = data.data[0];
                    const propertyGroup: PropertyGroup = {
                        id: group.id,
                        name: group.name,
                        options:
                            group.options?.map((o) => ({
                                id: o.id,
                                name: o.name,
                            })) || [],
                    };
                    this.shopwareGroupCache.set(groupName, propertyGroup);
                    return propertyGroup;
                }
            }

            // If no exact match, try fuzzy match (contains)
            response = await apiPost(context, "search/property-group", {
                filter: [{ type: "contains", field: "name", value: groupName }],
                associations: { options: {} },
                limit: 1,
            });

            if (response.ok) {
                const data = (await response.json()) as PropertyGroupResponse;
                if (data.data?.[0]?.options) {
                    const group = data.data[0];
                    const propertyGroup: PropertyGroup = {
                        id: group.id,
                        name: group.name,
                        options:
                            group.options?.map((o) => ({
                                id: o.id,
                                name: o.name,
                            })) || [],
                    };
                    this.shopwareGroupCache.set(groupName, propertyGroup);
                    return propertyGroup;
                }
            }
        } catch (error) {
            logger.warn(`Failed to get property group "${groupName}"`, { error });
        }

        return null;
    }

    /**
     * Check if product already has variants or configurator settings
     */
    private async productHasVariants(
        context: PostProcessorContext,
        productId: string
    ): Promise<boolean> {
        try {
            // Check for child products AND configurator settings in one query
            interface ProductResponse {
                data?: Array<{
                    children?: Array<{ id: string }>;
                    configuratorSettings?: Array<{ id: string }>;
                }>;
            }

            const productResponse = await apiPost(context, "search/product", {
                ids: [productId],
                associations: {
                    children: {},
                    configuratorSettings: {},
                },
            });

            if (productResponse.ok) {
                const productData = (await productResponse.json()) as ProductResponse;
                const product = productData.data?.[0];

                const hasChildren = !!product?.children && product.children.length > 0;
                const hasConfigSettings =
                    !!product?.configuratorSettings && product.configuratorSettings.length > 0;

                if (hasChildren || hasConfigSettings) {
                    logger.debug(`Product ${productId} already has variants`, {
                        hasChildren,
                        hasConfigSettings,
                        childCount: product?.children?.length || 0,
                        configCount: product?.configuratorSettings?.length || 0,
                    });
                    return true;
                }
            }
        } catch (error) {
            logger.warn(`Error checking variants for ${productId}`, { error });
        }

        return false;
    }

    /**
     * Resolve variant configs to actual Shopware property groups
     * Uses PropertyCache for group definitions and creates groups in Shopware if needed
     */
    private async resolvePropertyGroups(
        context: PostProcessorContext,
        configs: VariantConfig[]
    ): Promise<Array<{ group: PropertyGroup; selectedOptions: PropertyOption[]; priceModifiers: Record<string, number> }>> {
        const resolved: Array<{ group: PropertyGroup; selectedOptions: PropertyOption[]; priceModifiers: Record<string, number> }> = [];

        for (const config of configs) {
            // Try to find property group in blueprint first
            let propertyGroup = this.findPropertyGroupInBlueprint(context, config.group);

            // If not found in blueprint, try to ensure it exists using PropertyCache
            if (!propertyGroup) {
                propertyGroup = await this.ensurePropertyGroupInShopware(context, config.group);
            }

            // Last resort: search Shopware API directly
            if (!propertyGroup) {
                propertyGroup = await this.getPropertyGroup(context, config.group);
            }

            if (!propertyGroup || propertyGroup.options.length < 2) {
                logger.debug(`Skipping variant config "${config.group}": not enough options`, {
                    found: !!propertyGroup,
                    optionCount: propertyGroup?.options.length || 0,
                });
                continue;
            }

            // Filter to selected options only
            const selectedOptionNames = new Set(config.selectedOptions.map((o) => o.toLowerCase()));
            const selectedOptions = propertyGroup.options.filter((o) =>
                selectedOptionNames.has(o.name.toLowerCase())
            );

            // If no matching options found, use first few options from the group
            const finalOptions = selectedOptions.length >= 2
                ? selectedOptions
                : propertyGroup.options.slice(0, Math.min(3, propertyGroup.options.length));

            if (finalOptions.length >= 2) {
                resolved.push({
                    group: propertyGroup,
                    selectedOptions: finalOptions,
                    priceModifiers: config.priceModifiers,
                });
            }
        }

        return resolved;
    }

    /**
     * Create variants using cartesian product of multiple property groups
     */
    private async createMultiPropertyVariants(
        context: PostProcessorContext,
        product: { id: string; name: string; price: number },
        resolvedGroups: Array<{ group: PropertyGroup; selectedOptions: PropertyOption[]; priceModifiers: Record<string, number> }>
    ): Promise<number> {
        // Get currency ID for pricing
        const currencyId = await this.getCurrencyId(context);

        // Step 1: Collect all options for configurator settings
        const allConfiguratorSettings: Array<{ id: string; optionId: string }> = [];
        for (const { selectedOptions } of resolvedGroups) {
            for (const option of selectedOptions) {
                allConfiguratorSettings.push({
                    id: generateUUID(),
                    optionId: option.id,
                });
            }
        }

        // Update parent with all configurator settings
        const updateParentResponse = await apiPost(context, "_action/sync", {
            updateParent: {
                entity: "product",
                action: "upsert",
                payload: [
                    {
                        id: product.id,
                        configuratorSettings: allConfiguratorSettings,
                    },
                ],
            },
        });

        if (!updateParentResponse.ok) {
            const errorText = await updateParentResponse.text();

            if (errorText.includes("Duplicate entry") || errorText.includes("1062")) {
                console.log(`      ⊘ ${product.name}: Configurator settings already exist`);
                return 0;
            }

            logger.apiError("_action/sync (configuratorSettings)", updateParentResponse.status, {
                productId: product.id,
                error: errorText,
            });
            throw new Error(`Failed to update parent product: ${updateParentResponse.status}`);
        }

        // Step 2: Generate cartesian product of options
        const optionArrays = resolvedGroups.map((g) => g.selectedOptions);
        const combinations = cartesianProduct(optionArrays);

        // Step 3: Create variant products
        const variantPayload = combinations.map((combo) => {
            // Calculate combined price modifier
            let totalModifier = 1;
            for (let i = 0; i < combo.length; i++) {
                const option = combo[i];
                const group = resolvedGroups[i];
                if (option && group) {
                    totalModifier *= group.priceModifiers[option.name] || 1;
                }
            }

            const variantPrice = Math.round(product.price * totalModifier * 100) / 100;
            const optionSuffix = combo.map((o) => o.name.toLowerCase().replace(/\s+/g, "-")).join("-");

            return {
                id: generateUUID(),
                parentId: product.id,
                productNumber: `${product.id.slice(0, 8)}-${optionSuffix}`,
                stock: Math.floor(Math.random() * 100) + 10,
                options: combo.map((o) => ({ id: o.id })),
                price: [
                    {
                        currencyId,
                        gross: variantPrice,
                        net: Math.round((variantPrice / 1.19) * 100) / 100,
                        linked: true,
                    },
                ],
            };
        });

        const createVariantsResponse = await apiPost(context, "_action/sync", {
            createVariants: {
                entity: "product",
                action: "upsert",
                payload: variantPayload,
            },
        });

        if (!createVariantsResponse.ok) {
            const errorText = await createVariantsResponse.text();
            logger.apiError("_action/sync (variants)", createVariantsResponse.status, {
                productId: product.id,
                error: errorText,
            });
            throw new Error(`Failed to create variants: ${createVariantsResponse.status}`);
        }

        // Step 4: Add visibility to variants
        const visibilityPayload = variantPayload.map((variant) => ({
            id: generateUUID(),
            productId: variant.id,
            salesChannelId: context.salesChannelId,
            visibility: 30,
        }));

        const visibilityResponse = await apiPost(context, "_action/sync", {
            addVisibility: {
                entity: "product_visibility",
                action: "upsert",
                payload: visibilityPayload,
            },
        });

        if (!visibilityResponse.ok) {
            const errorText = await visibilityResponse.text();
            logger.apiError("_action/sync (variant visibility)", visibilityResponse.status, {
                error: errorText,
            });
        }

        return variantPayload.length;
    }

    /**
     * Cleanup variants for products in the SalesChannel
     *
     * 1. Get all parent products in the SalesChannel (products with visibilities)
     * 2. Find child products (variants) with those parentIds
     * 3. Delete child products
     * 4. Clear configuratorSettings from parent products
     */
    async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        const errors: string[] = [];
        let deleted = 0;

        if (context.options.dryRun) {
            console.log(`    [DRY RUN] Would delete variants for products in SalesChannel`);
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        if (!context.api) {
            errors.push("API helpers not available - cannot perform cleanup");
            return { name: this.name, deleted: 0, errors, durationMs: 0 };
        }

        try {
            // Step 1: Get all parent products in this SalesChannel
            const parentProducts = await context.api.searchEntities<{ id: string }>(
                "product",
                [
                    {
                        type: "equals",
                        field: "visibilities.salesChannelId",
                        value: context.salesChannelId,
                    },
                ],
                { limit: 500 }
            );

            if (parentProducts.length === 0) {
                console.log(`    No products found in SalesChannel`);
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            const parentIds = parentProducts.map((p) => p.id);
            console.log(`    Found ${parentIds.length} parent products in SalesChannel`);

            // Step 2: Find all child products (variants) with these parentIds
            const variants = await context.api.searchEntities<{ id: string }>(
                "product",
                [{ type: "equalsAny" as "equals", field: "parentId", value: parentIds }],
                { limit: 500 }
            );

            if (variants.length > 0) {
                console.log(`    Found ${variants.length} variant products`);

                // Step 3: Delete child products
                const variantIds = variants.map((v) => v.id);
                await context.api.deleteEntities("product", variantIds);
                deleted = variantIds.length;
                console.log(`    ✓ Deleted ${deleted} variant products`);
            } else {
                console.log(`    No variant products found`);
            }

            // Step 4: Clear configuratorSettings from parent products
            // Find parents that have configuratorSettings
            const parentsWithConfigurator = await context.api.searchEntities<{
                id: string;
                configuratorSettings?: unknown[];
            }>("product", [{ type: "equalsAny" as "equals", field: "id", value: parentIds }], {
                associations: { configuratorSettings: {} },
                limit: 500,
            });

            const parentsToUpdate = parentsWithConfigurator.filter(
                (p) => p.configuratorSettings && p.configuratorSettings.length > 0
            );

            if (parentsToUpdate.length > 0) {
                // We need to delete configurator settings entries
                for (const parent of parentsToUpdate) {
                    try {
                        // Get configurator settings for this product
                        const settings = await context.api.searchEntities<{ id: string }>(
                            "product-configurator-setting",
                            [{ type: "equals", field: "productId", value: parent.id }],
                            { limit: 100 }
                        );

                        if (settings.length > 0) {
                            await context.api.deleteEntities(
                                "product_configurator_setting",
                                settings.map((s) => s.id)
                            );
                        }
                    } catch {
                        // Settings might not exist, skip
                    }
                }
                console.log(
                    `    ✓ Cleared configurator settings from ${parentsToUpdate.length} parent products`
                );
            }
        } catch (error) {
            errors.push(
                `Variant cleanup failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        return { name: this.name, deleted, errors, durationMs: 0 };
    }
}

/** Variant processor singleton */
export const VariantProcessor = new VariantProcessorImpl();
