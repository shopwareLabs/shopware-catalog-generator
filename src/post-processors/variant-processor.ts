/**
 * Variant Processor - Creates product variants in Shopware
 *
 * Creates child variant products based on property options:
 * - Finds products with isVariant: true in metadata
 * - Converts parent to configurable product
 * - Creates child variants with property options
 * - Applies price modifiers per variant
 */

import type { CachedPropertyGroup, VariantConfig } from "../types/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

import { PropertyCache } from "../property-cache.js";
import { searchAllByEqualsAny, searchAllByFilter } from "../shopware/api-helpers.js";
import {
    apiPost,
    cartesianProduct,
    createShortHash,
    generateUUID,
    logger,
    sleep,
    toKebabCase,
} from "../utils/index.js";

interface PropertyOption {
    id: string;
    name: string;
}

interface PropertyGroup {
    id: string;
    name: string;
    options: PropertyOption[];
}

export function isTransientShopwareSyncError(errorText: string): boolean {
    const normalized = errorText.toLowerCase();
    return (
        normalized.includes("deadlock found when trying to get lock") ||
        normalized.includes("sqlstate[40001]") ||
        normalized.includes("savepoint doctrine_") ||
        normalized.includes("lock wait timeout exceeded")
    );
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
    // Cached currency ID (resolved once per run)
    private resolvedCurrencyId: string | null = null;
    // Track which groups we've ensured exist in Shopware
    private ensuredGroups: Set<string> = new Set();
    // Property cache for group definitions
    private propertyCache: PropertyCache | null = null;
    private readonly syncRetryAttempts = 3;
    private readonly syncRetryBaseDelayMs = 500;

    private interfaceResolutionResult(
        resolved: Array<{
            group: PropertyGroup;
            selectedOptions: PropertyOption[];
            priceModifiers: Record<string, number>;
        }>,
        issues: string[]
    ): {
        resolved: Array<{
            group: PropertyGroup;
            selectedOptions: PropertyOption[];
            priceModifiers: Record<string, number>;
        }>;
        issues: string[];
    } {
        return { resolved, issues };
    }

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

        logger.info(`    Creating variants for ${variantProducts.length} products...`, {
            cli: true,
        });

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
                logger.info(`      [DRY RUN] ${product.name} -> ${groupNames} variants`, {
                    cli: true,
                });
                processed++;
                continue;
            }

            try {
                // Resolve property groups for each variant config
                const resolution = await this.resolvePropertyGroups(context, variantConfigs);
                const resolvedGroups = resolution.resolved;

                if (resolvedGroups.length === 0) {
                    const issueSuffix =
                        resolution.issues.length > 0 ? ` (${resolution.issues.join("; ")})` : "";
                    logger.info(
                        `      ⊘ ${product.name}: No suitable property groups found${issueSuffix}`,
                        { cli: true }
                    );
                    skipped++;
                    continue;
                }

                // Check if product already has variants or configurator settings
                const hasVariants = await this.productHasVariants(context, product.id);
                if (hasVariants) {
                    logger.info(`      ⊘ ${product.name}: Already configured as variant product`, {
                        cli: true,
                    });
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
                    logger.info(
                        `      ✓ ${product.name}: Created ${variantCount} variants (${groupNames})`,
                        { cli: true }
                    );
                    processed++;
                } else {
                    // Already configured (0 variants created means duplicate was detected)
                    skipped++;
                }
            } catch (error) {
                const errorMsg = `Failed to create variants for ${product.name}: ${error instanceof Error ? error.message : String(error)}`;
                errors.push(errorMsg);
                logger.warn(errorMsg, { cli: true });
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
     * Get the primary currency ID, caching the result for subsequent calls.
     */
    private async getCurrencyId(context: PostProcessorContext): Promise<string> {
        if (this.resolvedCurrencyId) return this.resolvedCurrencyId;
        this.resolvedCurrencyId = await context.api.getDefaultCurrencyId();
        return this.resolvedCurrencyId;
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

        logger.info(
            `      Creating variant property group "${groupName}" with ${cachedGroup.options.length} options...`,
            { cli: true }
        );

        // Create/update property group with all options
        const allOptions = [...(existingGroup?.options || []), ...newOptions];

        const response = await this.syncWithRetry(context, "property group sync", {
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
            logger.apiError("_action/sync (property group)", response.status, {
                groupName,
                error: response.errorText ?? "Unknown error",
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
            logger.warn(`Failed to get property group "${groupName}"`, { data: error });
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
                        data: {
                            hasChildren,
                            hasConfigSettings,
                            childCount: product?.children?.length || 0,
                            configCount: product?.configuratorSettings?.length || 0,
                        },
                    });
                    return true;
                }
            }
        } catch (error) {
            logger.warn(`Error checking variants for ${productId}`, { data: error });
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
    ): Promise<{
        resolved: Array<{
            group: PropertyGroup;
            selectedOptions: PropertyOption[];
            priceModifiers: Record<string, number>;
        }>;
        issues: string[];
    }> {
        const resolved: Array<{
            group: PropertyGroup;
            selectedOptions: PropertyOption[];
            priceModifiers: Record<string, number>;
        }> = [];
        const issues: string[] = [];

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

            if (!propertyGroup) {
                issues.push(`${config.group}: group not found`);
                logger.debug(`Skipping variant config "${config.group}": not enough options`, {
                    data: {
                        found: false,
                        optionCount: 0,
                    },
                });
                continue;
            }

            if (propertyGroup.options.length < 2) {
                issues.push(`${config.group}: only ${propertyGroup.options.length} option(s)`);
                logger.debug(`Skipping variant config "${config.group}": not enough options`, {
                    data: {
                        found: true,
                        optionCount: propertyGroup.options.length,
                    },
                });
                continue;
            }

            // Filter to selected options only
            const selectedOptionNames = new Set(config.selectedOptions.map((o) => o.toLowerCase()));
            const selectedOptions = propertyGroup.options.filter((o) =>
                selectedOptionNames.has(o.name.toLowerCase())
            );

            // If no matching options found, use first few options from the group
            const finalOptions =
                selectedOptions.length >= 2
                    ? selectedOptions
                    : propertyGroup.options.slice(0, Math.min(3, propertyGroup.options.length));

            if (finalOptions.length >= 2) {
                if (selectedOptions.length < 2) {
                    const selectedText =
                        config.selectedOptions.length > 0
                            ? config.selectedOptions.join(", ")
                            : "none";
                    issues.push(
                        `${config.group}: selected options mismatch (${selectedText}); used fallback options`
                    );
                }
                resolved.push({
                    group: propertyGroup,
                    selectedOptions: finalOptions,
                    priceModifiers: config.priceModifiers,
                });
            }
        }

        return this.interfaceResolutionResult(resolved, issues);
    }

    /**
     * Create variants using cartesian product of multiple property groups
     */
    private async createMultiPropertyVariants(
        context: PostProcessorContext,
        product: { id: string; name: string; price: number },
        resolvedGroups: Array<{
            group: PropertyGroup;
            selectedOptions: PropertyOption[];
            priceModifiers: Record<string, number>;
        }>
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
        const updateParentResponse = await this.syncWithRetry(
            context,
            "update parent configurator settings",
            {
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
            }
        );

        if (!updateParentResponse.ok) {
            const errorText = updateParentResponse.errorText ?? "Unknown error";

            if (errorText.includes("Duplicate entry") || errorText.includes("1062")) {
                logger.info(`      ⊘ ${product.name}: Configurator settings already exist`, {
                    cli: true,
                });
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
            const optionSuffix = combo
                .map((o) => o.name.toLowerCase().replace(/\s+/g, "-"))
                .join("-");

            // Shopware productNumber has max 64 chars.
            // Format: {8-char UUID prefix}-{truncated suffix}-{5-char hash}
            // The hash of the full suffix guarantees uniqueness even when truncation
            // causes different option combos to share the same prefix.
            const prefix = product.id.slice(0, 8);
            const hashSuffix = createShortHash(optionSuffix, 5);
            const maxSuffixLength = 64 - prefix.length - 1 - hashSuffix.length - 1; // hyphens between parts
            const truncatedSuffix = optionSuffix.slice(0, maxSuffixLength);

            return {
                id: generateUUID(),
                parentId: product.id,
                productNumber: `${prefix}-${truncatedSuffix}-${hashSuffix}`,
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

        const createVariantsResponse = await this.syncWithRetry(context, "create variants", {
            createVariants: {
                entity: "product",
                action: "upsert",
                payload: variantPayload,
            },
        });

        if (!createVariantsResponse.ok) {
            const errorText = createVariantsResponse.errorText ?? "Unknown error";
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

        const visibilityResponse = await this.syncWithRetry(context, "variant visibility", {
            addVisibility: {
                entity: "product_visibility",
                action: "upsert",
                payload: visibilityPayload,
            },
        });

        if (!visibilityResponse.ok) {
            logger.apiError("_action/sync (variant visibility)", visibilityResponse.status, {
                error: visibilityResponse.errorText ?? "Unknown error",
            });
        }

        return variantPayload.length;
    }

    private async syncWithRetry(
        context: PostProcessorContext,
        operationName: string,
        payload: unknown
    ): Promise<{ ok: boolean; status: number; errorText?: string }> {
        let delayMs = this.syncRetryBaseDelayMs;
        let lastStatus = 500;
        let lastErrorText = "Unknown error";

        for (let attempt = 1; attempt <= this.syncRetryAttempts; attempt++) {
            try {
                const response = await apiPost(context, "_action/sync", payload);
                if (response.ok) {
                    return { ok: true, status: response.status };
                }

                lastStatus = response.status;
                lastErrorText = await response.text();
            } catch (error) {
                lastStatus = 500;
                lastErrorText = error instanceof Error ? error.message : String(error);
            }

            const transient = isTransientShopwareSyncError(lastErrorText);
            const isLastAttempt = attempt === this.syncRetryAttempts;
            if (!transient || isLastAttempt) {
                return {
                    ok: false,
                    status: lastStatus,
                    errorText: lastErrorText,
                };
            }

            logger.warn(
                `Transient Shopware sync error during ${operationName} (attempt ${attempt}/${this.syncRetryAttempts}). Retrying in ${delayMs}ms...`,
                { cli: true }
            );
            await sleep(delayMs);
            delayMs *= 2;
        }

        return { ok: false, status: lastStatus, errorText: lastErrorText };
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
            logger.info(`    [DRY RUN] Would delete variants for products in SalesChannel`, {
                cli: true,
            });
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        if (!context.api) {
            errors.push("API helpers not available - cannot perform cleanup");
            return { name: this.name, deleted: 0, errors, durationMs: 0 };
        }

        try {
            // Step 1: Get all parent products in this SalesChannel
            const parents = await searchAllByFilter<{ id: string }>(context, "product", [
                {
                    type: "equals",
                    field: "visibilities.salesChannelId",
                    value: context.salesChannelId,
                },
                {
                    type: "equals",
                    field: "parentId",
                    value: null,
                },
            ]);
            const parentIds = parents.map((parent) => parent.id);

            if (parentIds.length === 0) {
                logger.info(`    No products found in SalesChannel`, { cli: true });
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            logger.info(`    Found ${parentIds.length} parent products in SalesChannel`, {
                cli: true,
            });

            // Step 2: Find all child products (variants) with these parentIds
            const variants = await searchAllByEqualsAny<{ id: string }>(
                context,
                "product",
                "parentId",
                parentIds,
                { includes: { product: ["id"] } }
            );

            if (variants.length > 0) {
                logger.info(`    Found ${variants.length} variant products`, { cli: true });

                // Step 3: Delete child products
                await context.api.deleteEntities(
                    "product",
                    variants.map((variant) => variant.id)
                );
                deleted = variants.length;
            } else {
                logger.info(`    No variant products found`, { cli: true });
            }

            // Step 4: Clear configuratorSettings from parent products
            // Find parents that have configuratorSettings
            const parentsWithConfigurator = await searchAllByEqualsAny<{
                id: string;
                configuratorSettings?: unknown[];
            }>(context, "product", "id", parentIds, { associations: { configuratorSettings: {} } });

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
                logger.info(
                    `    ✓ Cleared configurator settings from ${parentsToUpdate.length} parent products`,
                    { cli: true }
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
