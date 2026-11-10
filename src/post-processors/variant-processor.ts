/**
 * Variant Processor - Creates product variants in Shopware
 *
 * Creates child variant products based on property options:
 * - Finds products with isVariant: true in metadata
 * - Converts parent to configurable product
 * - Creates child variants with property options
 * - Applies price modifiers per variant
 */

import type { BlueprintProduct, CachedPropertyGroup, VariantConfig } from "../types/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

import { blueprintVariantSettings, capVariantConfigs } from "../blueprint/variant-settings.js";
import { PropertyCache } from "../property-cache.js";
import { searchAllByEqualsAny, searchAllByFilter } from "../shopware/api-helpers.js";
import {
    apiPost,
    cartesianProduct,
    createShortHash,
    generateUUID,
    logger,
    toKebabCase,
    uniqueById,
} from "../utils/index.js";
import { errorMessage, syncWithRetry } from "./processor-utils.js";
import {
    type ExistingVariants,
    isVariantPlanEmpty,
    planVariantReconcile,
    type VariantReconcilePlan,
} from "./variant-reconcile.js";

interface PropertyOption {
    id: string;
    name: string;
}

interface PropertyGroup {
    id: string;
    name: string;
    options: PropertyOption[];
}

/** A variant config matched to a Shopware property group and its options */
interface ResolvedVariantGroup {
    group: PropertyGroup;
    selectedOptions: PropertyOption[];
    priceModifiers: Record<string, number>;
}

/** Resolved groups of a product plus the reasons why configs were dropped or changed */
interface GroupResolution {
    resolved: ResolvedVariantGroup[];
    issues: string[];
}

/** Options picked for one variant config (resolved is null when the config is dropped) */
interface OptionSelection {
    resolved: ResolvedVariantGroup | null;
    issue: string | null;
}

/** What happened to one variant product */
type VariantOutcome = "processed" | "skipped" | "failed";

/** Product data returned by the variant check */
interface ExistingVariantData {
    children?: Array<{ id: string; optionIds?: string[]; options?: Array<{ id: string }> }>;
    configuratorSettings?: Array<{ id: string; optionId: string }>;
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

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { blueprint } = context;
        const startTime = Date.now();

        // Initialize store-scoped property cache for this sales channel
        const cacheDir = process.env.CACHE_DIR || "./generated";
        this.propertyCache = PropertyCache.forStore(
            cacheDir,
            toKebabCase(context.salesChannelName)
        );

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

        // Older blueprints were hydrated without a variant cap
        const { maxVariants } = blueprintVariantSettings(blueprint);
        const counts: Record<VariantOutcome, number> = { processed: 0, skipped: 0, failed: 0 };
        const errors: string[] = [];

        for (const product of variantProducts) {
            const outcome = await this.processVariantProduct(context, product, maxVariants, errors);
            counts[outcome]++;
        }

        return {
            name: this.name,
            processed: counts.processed,
            skipped: counts.skipped,
            errors,
            durationMs: Date.now() - startTime,
        };
    }

    /**
     * Create the variants of one product. Errors are collected in `errors`.
     */
    private async processVariantProduct(
        context: PostProcessorContext,
        product: BlueprintProduct,
        maxVariants: number,
        errors: string[]
    ): Promise<VariantOutcome> {
        const variantConfigs = loadVariantConfigs(context, product, maxVariants);
        if (!variantConfigs) return "skipped";

        if (context.options.dryRun) {
            const groupNames = variantConfigs.map((c) => c.group).join(" + ");
            logger.info(`      [DRY RUN] ${product.name} -> ${groupNames} variants`, {
                cli: true,
            });
            return "processed";
        }

        try {
            return await this.createVariantsForProduct(context, product, variantConfigs);
        } catch (error) {
            const errorMsg = `Failed to create variants for ${product.name}: ${errorMessage(error)}`;
            errors.push(errorMsg);
            logger.warn(errorMsg, { cli: true });
            return "failed";
        }
    }

    /**
     * Resolve the property groups of a product and create its variants
     */
    private async createVariantsForProduct(
        context: PostProcessorContext,
        product: BlueprintProduct,
        variantConfigs: VariantConfig[]
    ): Promise<VariantOutcome> {
        const resolution = await this.resolvePropertyGroups(context, variantConfigs);
        const resolvedGroups = resolution.resolved;

        if (resolvedGroups.length === 0) {
            logger.info(
                `      ⊘ ${product.name}: No suitable property groups found${formatIssues(resolution.issues)}`,
                { cli: true }
            );
            return "skipped";
        }

        const existing = await this.fetchExistingVariants(context, product.id);
        const combinations = cartesianProduct(resolvedGroups.map((g) => g.selectedOptions));
        const plan = planVariantReconcile(combinations, existing);
        if (isVariantPlanEmpty(plan)) {
            logger.info(`      ⊘ ${product.name}: Already configured as variant product`, {
                cli: true,
            });
            return "skipped";
        }

        await this.applyVariantPlan(context, product, resolvedGroups, plan);

        const groupNames = resolvedGroups.map((g) => g.group.name).join(" + ");
        logger.info(
            `      ✓ ${product.name}: ${describeVariantPlan(plan, existing)} (${groupNames})${formatIssues(resolution.issues)}`,
            { cli: true }
        );
        return "processed";
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
        const groups = context.blueprint.propertyGroups;

        const match =
            groups.find((group) => group.name.toLowerCase() === normalizedName) ??
            groups.find((group) => isPartialNameMatch(group.name.toLowerCase(), normalizedName));

        return match ? toPropertyGroup(match) : null;
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
     * Ensure a property group exists in Shopware with the cached options (once per
     * group) and the selected options of this variant config.
     *
     * The variant options can differ from the cached plain-property options
     * (e.g. "Small, Medium, Large" vs. "100ml, 200ml"), so both are added.
     */
    private async ensurePropertyGroupInShopware(
        context: PostProcessorContext,
        config: VariantConfig
    ): Promise<PropertyGroup | null> {
        const groupName = config.group;
        const cachedGroup = this.propertyCache?.get(groupName) ?? null;
        const existingGroup = await this.getPropertyGroup(context, groupName);
        if (!cachedGroup && !existingGroup) {
            logger.debug(`No cached property group definition for "${groupName}"`);
            return null;
        }

        const firstEnsure = !this.ensuredGroups.has(groupName);
        this.ensuredGroups.add(groupName);

        // Compare option names, not counts: a shop group can have more options
        // (plain product properties) and still lack the variant options
        const wanted = wantedGroupOptions(config, cachedGroup, firstEnsure);
        const newOptions = missingOptions(wanted, existingGroup);
        if (existingGroup && newOptions.length === 0) {
            return existingGroup;
        }

        const definition = groupDefinition(groupName, cachedGroup);
        return await this.syncPropertyGroup(context, definition, existingGroup, newOptions);
    }

    /**
     * Create or update a property group in Shopware with the cached options,
     * then return the fresh group from Shopware
     */
    private async syncPropertyGroup(
        context: PostProcessorContext,
        cachedGroup: Pick<CachedPropertyGroup, "name" | "displayType">,
        existingGroup: PropertyGroup | null,
        newOptions: PropertyOption[]
    ): Promise<PropertyGroup | null> {
        const groupName = cachedGroup.name;
        logger.info(
            `      Adding ${newOptions.length} option(s) to variant property group "${groupName}"...`,
            { cli: true }
        );

        const allOptions = [...(existingGroup?.options || []), ...newOptions];
        const response = await syncWithRetry(context, "property group sync", {
            createPropertyGroup: {
                entity: "property_group",
                action: "upsert",
                payload: [
                    {
                        id: existingGroup?.id || generateUUID(),
                        name: cachedGroup.name,
                        sortingType: "alphanumeric",
                        displayType: cachedGroup.displayType,
                        options: allOptions.map((o) => ({ id: o.id, name: o.name })),
                    },
                ],
            },
        });

        if (!response.ok) {
            logger.apiError("_action/sync (property group)", response.status, {
                groupName,
                error: response.errorText ?? "Unknown error",
            });
            return null;
        }

        // Clear Shopware cache so we get fresh data
        this.shopwareGroupCache.delete(groupName);
        return await this.getPropertyGroup(context, groupName);
    }

    /**
     * Get property group by name with options from Shopware (exact match, then contains)
     */
    private async getPropertyGroup(
        context: PostProcessorContext,
        groupName: string
    ): Promise<PropertyGroup | null> {
        const cached = this.shopwareGroupCache.get(groupName);
        if (cached) {
            return cached;
        }

        try {
            const group =
                (await searchPropertyGroup(context, "equals", groupName)) ??
                (await searchPropertyGroup(context, "contains", groupName));
            if (group) {
                this.shopwareGroupCache.set(groupName, group);
            }
            return group;
        } catch (error) {
            logger.warn(`Failed to get property group "${groupName}"`, { data: error });
            return null;
        }
    }

    /**
     * Load the child variants (with their options) and configurator settings of a product
     */
    private async fetchExistingVariants(
        context: PostProcessorContext,
        productId: string
    ): Promise<ExistingVariants> {
        const none: ExistingVariants = { children: [], settings: [] };
        try {
            const productResponse = await apiPost(context, "search/product", {
                ids: [productId],
                associations: {
                    children: { associations: { options: {} } },
                    configuratorSettings: {},
                },
            });
            if (!productResponse.ok) return none;

            const productData = (await productResponse.json()) as {
                data?: ExistingVariantData[];
            };
            return toExistingVariants(productData.data?.[0]);
        } catch (error) {
            logger.warn(`Error checking variants for ${productId}`, { data: error });
            return none;
        }
    }

    /**
     * Find the property group of a variant config: blueprint first, then the
     * PropertyCache (creating the group in Shopware if needed), then a Shopware search.
     *
     * The blueprint group only collects the options that products use as plain
     * properties (e.g. "Size: Medium"), so it is skipped when it lacks the selected
     * variant options. The blueprint group is still the last resort.
     */
    private async findPropertyGroup(
        context: PostProcessorContext,
        config: VariantConfig
    ): Promise<PropertyGroup | null> {
        const blueprintGroup = this.findPropertyGroupInBlueprint(context, config.group);
        if (blueprintGroup && hasSelectedOptions(blueprintGroup, config)) {
            return blueprintGroup;
        }
        return (
            (await this.ensurePropertyGroupInShopware(context, config)) ??
            (await this.getPropertyGroup(context, config.group)) ??
            blueprintGroup
        );
    }

    /**
     * Resolve variant configs to actual Shopware property groups
     * Uses PropertyCache for group definitions and creates groups in Shopware if needed
     */
    private async resolvePropertyGroups(
        context: PostProcessorContext,
        configs: VariantConfig[]
    ): Promise<GroupResolution> {
        const resolution: GroupResolution = { resolved: [], issues: [] };

        for (const config of configs) {
            const propertyGroup = await this.findPropertyGroup(context, config);
            const selection = selectVariantOptions(config, propertyGroup);
            if (selection.issue) resolution.issues.push(selection.issue);
            if (selection.resolved) resolution.resolved.push(selection.resolved);
        }

        return resolution;
    }

    /**
     * Bring the variants of a product in line with the blueprint: remove stale variants
     * and settings, add missing configurator settings, create missing variants
     */
    private async applyVariantPlan(
        context: PostProcessorContext,
        product: { id: string; name: string; price: number },
        resolvedGroups: ResolvedVariantGroup[],
        plan: VariantReconcilePlan<PropertyOption>
    ): Promise<void> {
        await this.deleteStaleVariants(context, product.id, plan);
        await this.addConfiguratorSettings(context, product.id, plan.missingOptionIds);
        if (plan.missingCombos.length === 0) return;
        await this.createVariants(context, product, resolvedGroups, plan.missingCombos);
    }

    /** Delete children and configurator settings that are no longer in the blueprint */
    private async deleteStaleVariants(
        context: PostProcessorContext,
        productId: string,
        plan: VariantReconcilePlan<PropertyOption>
    ): Promise<void> {
        if (plan.staleChildIds.length === 0 && plan.staleSettingIds.length === 0) return;

        const response = await syncWithRetry(context, "delete stale variants", {
            deleteStaleChildren: {
                entity: "product",
                action: "delete",
                payload: plan.staleChildIds.map((id) => ({ id })),
            },
            deleteStaleSettings: {
                entity: "product_configurator_setting",
                action: "delete",
                payload: plan.staleSettingIds.map((id) => ({ id })),
            },
        });
        if (response.ok) return;

        logger.apiError("_action/sync (delete stale variants)", response.status, {
            productId,
            error: response.errorText ?? "Unknown error",
        });
        throw new Error(`Failed to delete stale variants: ${response.status}`);
    }

    /** Add configurator settings for options the parent does not have yet */
    private async addConfiguratorSettings(
        context: PostProcessorContext,
        productId: string,
        optionIds: string[]
    ): Promise<void> {
        if (optionIds.length === 0) return;

        const response = await syncWithRetry(context, "update parent configurator settings", {
            updateParent: {
                entity: "product",
                action: "upsert",
                payload: [
                    {
                        id: productId,
                        configuratorSettings: optionIds.map((optionId) => ({
                            id: generateUUID(),
                            optionId,
                        })),
                    },
                ],
            },
        });
        if (response.ok) return;

        logger.apiError("_action/sync (configuratorSettings)", response.status, {
            productId,
            error: response.errorText ?? "Unknown error",
        });
        throw new Error(`Failed to update parent product: ${response.status}`);
    }

    /**
     * Create one child variant per option combination
     */
    private async createVariants(
        context: PostProcessorContext,
        product: { id: string; name: string; price: number },
        resolvedGroups: ResolvedVariantGroup[],
        combinations: PropertyOption[][]
    ): Promise<void> {
        const currencyId = await this.getCurrencyId(context);

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

        const createVariantsResponse = await syncWithRetry(context, "create variants", {
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

        const visibilityResponse = await syncWithRetry(context, "variant visibility", {
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
        if (context.options.dryRun) {
            logger.info(`    [DRY RUN] Would delete variants for products in SalesChannel`, {
                cli: true,
            });
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        if (!context.api) {
            const errors = ["API helpers not available - cannot perform cleanup"];
            return { name: this.name, deleted: 0, errors, durationMs: 0 };
        }

        let deleted = 0;
        try {
            const parentIds = await findParentProductIds(context);
            if (parentIds.length === 0) {
                logger.info(`    No products found in SalesChannel`, { cli: true });
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            logger.info(`    Found ${parentIds.length} parent products in SalesChannel`, {
                cli: true,
            });
            deleted = await deleteVariantChildren(context, parentIds);
            await clearConfiguratorSettings(context, parentIds);
        } catch (error) {
            const errors = [`Variant cleanup failed: ${errorMessage(error)}`];
            return { name: this.name, deleted, errors, durationMs: 0 };
        }

        return { name: this.name, deleted, errors: [], durationMs: 0 };
    }
}

/**
 * Capped variant configs of a variant product, or null when the product has
 * no cached variant metadata or no configs
 */
function loadVariantConfigs(
    context: PostProcessorContext,
    product: BlueprintProduct,
    maxVariants: number
): VariantConfig[] | null {
    const metadata = context.cache.loadProductMetadata(context.salesChannelName, product.id);
    if (!metadata?.isVariant) return null;

    // Use variantConfigs from metadata (new format)
    const storedConfigs = metadata.variantConfigs ?? product.metadata.variantConfigs;
    if (!storedConfigs) return null;

    const variantConfigs = capVariantConfigs(storedConfigs, maxVariants);
    return variantConfigs.length > 0 ? variantConfigs : null;
}

/** Issue list as log suffix: " (a; b)", or "" when there are none */
function formatIssues(issues: string[]): string {
    return issues.length > 0 ? ` (${issues.join("; ")})` : "";
}

/** The group contains every selected option (case-insensitive) */
function hasSelectedOptions(group: PropertyGroup, config: VariantConfig): boolean {
    const names = new Set(group.options.map((o) => o.name.toLowerCase()));
    return config.selectedOptions.every((o) => names.has(o.toLowerCase()));
}

/** One name contains the other (both lowercase) */
function isPartialNameMatch(groupName: string, searchName: string): boolean {
    return groupName.includes(searchName) || searchName.includes(groupName);
}

/** Property group with only the id and name of each option */
function toPropertyGroup(group: {
    id: string;
    name: string;
    options: PropertyOption[];
}): PropertyGroup {
    return {
        id: group.id,
        name: group.name,
        options: group.options.map((o) => ({ id: o.id, name: o.name })),
    };
}

/** Cached options (first time a group is ensured) plus the selected variant options */
function wantedGroupOptions(
    config: VariantConfig,
    cachedGroup: CachedPropertyGroup | null,
    includeCached: boolean
): string[] {
    const cachedOptions = includeCached ? (cachedGroup?.options ?? []) : [];
    return [...cachedOptions, ...config.selectedOptions];
}

/** Name and display type for a group sync, from the cache when there is one */
function groupDefinition(
    groupName: string,
    cachedGroup: CachedPropertyGroup | null
): Pick<CachedPropertyGroup, "name" | "displayType"> {
    return {
        name: cachedGroup?.name ?? groupName,
        displayType: cachedGroup?.displayType ?? "text",
    };
}

/** Option names that the Shopware group does not have yet (case-insensitive, once each), with new IDs */
function missingOptions(names: string[], existingGroup: PropertyGroup | null): PropertyOption[] {
    const seen = new Set(existingGroup?.options.map((o) => o.name.toLowerCase()) || []);
    return names
        .filter((name) => {
            const key = name.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .map((name) => ({ id: generateUUID(), name }));
}

/** Search one property group (with options) by name in Shopware */
async function searchPropertyGroup(
    context: PostProcessorContext,
    filterType: "equals" | "contains",
    groupName: string
): Promise<PropertyGroup | null> {
    const response = await apiPost(context, "search/property-group", {
        filter: [{ type: filterType, field: "name", value: groupName }],
        associations: { options: {} },
        limit: 1,
    });
    if (!response.ok) return null;

    const data = (await response.json()) as {
        data?: Array<{ id: string; name: string; options?: PropertyOption[] }>;
    };
    const group = data.data?.[0];
    if (!group?.options) return null;

    return toPropertyGroup({ id: group.id, name: group.name, options: group.options });
}

/** Map the product search result to existing children (with option IDs) and settings */
function toExistingVariants(product: ExistingVariantData | undefined): ExistingVariants {
    return {
        children: (product?.children ?? []).map((child) => ({
            id: child.id,
            optionIds: child.options?.map((o) => o.id) ?? child.optionIds ?? [],
        })),
        settings: (product?.configuratorSettings ?? []).map((s) => ({
            id: s.id,
            optionId: s.optionId,
        })),
    };
}

/** Log text for a variant plan: a fresh product or a repaired one */
function describeVariantPlan(
    plan: VariantReconcilePlan<PropertyOption>,
    existing: ExistingVariants
): string {
    const created = plan.missingCombos.length;
    if (existing.children.length === 0) return `Created ${created} variants`;
    return `Completed variants: ${created} added, ${plan.staleChildIds.length} stale removed, ${existing.children.length - plan.staleChildIds.length} kept`;
}

/**
 * One group option per selected name, in group order.
 *
 * A shop group can hold the same name in different cases ("10 Pairs", "10 pairs").
 * Taking both gives two variants with the same product number, so an exact match
 * wins and a case-insensitive match is only the fallback.
 */
function matchSelectedOptions(names: string[], groupOptions: PropertyOption[]): PropertyOption[] {
    const keys = new Set(names.map((name) => name.toLowerCase()));
    const matched = new Set(
        [...keys].flatMap((key) => {
            const match =
                groupOptions.find((o) => names.includes(o.name) && o.name.toLowerCase() === key) ??
                groupOptions.find((o) => o.name.toLowerCase() === key);
            return match ? [match.id] : [];
        })
    );
    return groupOptions.filter((o) => matched.has(o.id));
}

/**
 * Pick the options of a variant config from its property group.
 * Falls back to the first three options when fewer than two selected options match.
 */
function selectVariantOptions(
    config: VariantConfig,
    propertyGroup: PropertyGroup | null
): OptionSelection {
    const optionCount = propertyGroup?.options.length ?? 0;
    if (!propertyGroup || optionCount < 2) {
        logger.debug(`Skipping variant config "${config.group}": not enough options`, {
            data: { found: !!propertyGroup, optionCount },
        });
        const issue = propertyGroup
            ? `${config.group}: only ${optionCount} option(s)`
            : `${config.group}: group not found`;
        return { resolved: null, issue };
    }

    // One option per ID: a group can list the same option twice, and Shopware
    // rejects duplicate configurator settings.
    const groupOptions = uniqueById(propertyGroup.options);
    const selectedOptions = matchSelectedOptions(config.selectedOptions, groupOptions);
    const { priceModifiers } = config;

    if (selectedOptions.length >= 2) {
        return { resolved: { group: propertyGroup, selectedOptions, priceModifiers }, issue: null };
    }

    const fallbackOptions = groupOptions.slice(0, 3);
    if (fallbackOptions.length < 2) {
        return { resolved: null, issue: null };
    }

    const selectedText =
        config.selectedOptions.length > 0 ? config.selectedOptions.join(", ") : "none";
    return {
        resolved: { group: propertyGroup, selectedOptions: fallbackOptions, priceModifiers },
        issue: `${config.group}: selected options mismatch (${selectedText}); used fallback options`,
    };
}

/** IDs of all parent products visible in the SalesChannel */
async function findParentProductIds(context: PostProcessorContext): Promise<string[]> {
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
    return parents.map((parent) => parent.id);
}

/** Delete all variant products of the given parents, returns the deleted count */
async function deleteVariantChildren(
    context: PostProcessorContext,
    parentIds: string[]
): Promise<number> {
    const variants = await searchAllByEqualsAny<{ id: string }>(
        context,
        "product",
        "parentId",
        parentIds,
        { includes: { product: ["id"] } }
    );

    if (variants.length === 0) {
        logger.info(`    No variant products found`, { cli: true });
        return 0;
    }

    logger.info(`    Found ${variants.length} variant products`, { cli: true });
    await context.api.deleteEntities(
        "product",
        variants.map((variant) => variant.id)
    );
    return variants.length;
}

/** Delete the configurator settings of every parent that has some */
async function clearConfiguratorSettings(
    context: PostProcessorContext,
    parentIds: string[]
): Promise<void> {
    const parentsWithConfigurator = await searchAllByEqualsAny<{
        id: string;
        configuratorSettings?: unknown[];
    }>(context, "product", "id", parentIds, { associations: { configuratorSettings: {} } });

    const parentsToUpdate = parentsWithConfigurator.filter(
        (p) => p.configuratorSettings && p.configuratorSettings.length > 0
    );
    if (parentsToUpdate.length === 0) return;

    for (const parent of parentsToUpdate) {
        await deleteParentConfiguratorSettings(context, parent.id);
    }
    logger.info(
        `    ✓ Cleared configurator settings from ${parentsToUpdate.length} parent products`,
        { cli: true }
    );
}

/** Delete the configurator settings of one parent product (errors are ignored) */
async function deleteParentConfiguratorSettings(
    context: PostProcessorContext,
    parentId: string
): Promise<void> {
    try {
        const settings = await context.api.searchEntities<{ id: string }>(
            "product-configurator-setting",
            [{ type: "equals", field: "productId", value: parentId }],
            { limit: 100 }
        );
        if (settings.length === 0) return;

        await context.api.deleteEntities(
            "product_configurator_setting",
            settings.map((s) => s.id)
        );
    } catch {
        // Settings might not exist, skip
    }
}

/** Variant processor singleton */
export const VariantProcessor = new VariantProcessorImpl();
