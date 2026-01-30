/**
 * Shopware Sync Operations
 *
 * Shared sync functions used by both CLI (main.ts) and server.
 * These orchestrate the DataHydrator to sync data to Shopware.
 */

import type { HydratedBlueprint, SalesChannelFull } from "../types/index.js";
import {
    buildBlueprintCategoryPathMap,
    buildCategoryPath,
    convertBlueprintCategories,
    findCategoryPathById,
} from "../utils/index.js";

import type { DataHydrator } from "./index.js";

// =============================================================================
// Types
// =============================================================================

/** Property lookup maps for product creation */
export interface PropertyMaps {
    /** Group name -> group ID */
    groupIdMap: Map<string, string>;
    /** "groupname::optionname" -> option ID */
    optionIdMap: Map<string, string>;
    /** "groupname::optionname" -> { id, name } */
    propertyOptionMap: Map<string, { id: string; name: string }>;
}

// =============================================================================
// Category Sync
// =============================================================================

/**
 * Sync categories to Shopware (idempotent upsert).
 * For new SalesChannels, creates all categories.
 * For existing ones, maps existing IDs and upserts.
 *
 * @param dataHydrator - Authenticated DataHydrator instance
 * @param blueprint - Hydrated blueprint with categories
 * @param salesChannel - SalesChannel to sync to
 * @param isNew - Whether this is a new SalesChannel
 * @returns Map of category path -> Shopware category ID
 */
export async function syncCategories(
    dataHydrator: DataHydrator,
    blueprint: HydratedBlueprint,
    salesChannel: SalesChannelFull,
    isNew: boolean
): Promise<Map<string, string>> {
    const categoryNodes = convertBlueprintCategories(blueprint.categories);

    if (isNew) {
        // New SalesChannel: create all categories
        const categoryIdMap = await dataHydrator.createCategoryTree(
            categoryNodes,
            salesChannel.navigationCategoryId,
            salesChannel.id
        );
        console.log(`  Created ${categoryIdMap.size} categories`);
        return categoryIdMap;
    } else {
        // Existing SalesChannel: get existing categories, then upsert
        const existingCategoryMap = await dataHydrator.getExistingCategoryMap(
            salesChannel.navigationCategoryId,
            categoryNodes
        );

        // Update blueprint category IDs with existing ones
        const updateCategoryIds = (
            cats: HydratedBlueprint["categories"],
            existingMap: Map<string, string>,
            parentPath: string | null = null
        ): void => {
            for (const cat of cats) {
                const path = buildCategoryPath(parentPath, cat.name);
                const existingId = existingMap.get(path);
                if (existingId) {
                    cat.id = existingId;
                }
                if (cat.children.length > 0) {
                    updateCategoryIds(cat.children, existingMap, path);
                }
            }
        };
        updateCategoryIds(blueprint.categories, existingCategoryMap);

        // Create/update categories (upsert)
        const categoryIdMap = await dataHydrator.createCategoryTree(
            convertBlueprintCategories(blueprint.categories),
            salesChannel.navigationCategoryId,
            salesChannel.id
        );
        console.log(`  Synced ${categoryIdMap.size} categories`);
        return categoryIdMap;
    }
}

// =============================================================================
// Property Group Sync
// =============================================================================

/**
 * Sync property groups to Shopware (idempotent upsert).
 *
 * @param dataHydrator - Authenticated DataHydrator instance
 * @param blueprint - Hydrated blueprint with property groups
 */
export async function syncPropertyGroups(
    dataHydrator: DataHydrator,
    blueprint: HydratedBlueprint
): Promise<void> {
    const propertyGroupsToCreate = blueprint.propertyGroups.map((g) => ({
        id: g.id,
        name: g.name,
        description: `Properties for ${g.name}`,
        displayType: g.displayType,
        options: g.options.map((o) => ({
            id: o.id,
            name: o.name,
            colorHexCode: o.colorHexCode,
        })),
    }));

    const propertyGroups = await dataHydrator.hydrateEnvWithPropertyGroups(propertyGroupsToCreate);
    console.log(`  Synced ${propertyGroups.length} property groups`);
}

// =============================================================================
// Property Maps
// =============================================================================

/**
 * Build property lookup maps from blueprint.
 * Used for mapping product properties to Shopware option IDs.
 *
 * @param blueprint - Hydrated blueprint with property groups
 * @returns PropertyMaps with group and option lookups
 */
export function buildPropertyMaps(blueprint: HydratedBlueprint): PropertyMaps {
    const groupIdMap = new Map<string, string>();
    const optionIdMap = new Map<string, string>();
    const propertyOptionMap = new Map<string, { id: string; name: string }>();

    for (const group of blueprint.propertyGroups) {
        groupIdMap.set(group.name.toLowerCase(), group.id);
        for (const option of group.options) {
            const key = `${group.name.toLowerCase()}::${option.name.toLowerCase()}`;
            optionIdMap.set(key, option.id);
            propertyOptionMap.set(key, { id: option.id, name: option.name });
        }
    }

    return { groupIdMap, optionIdMap, propertyOptionMap };
}

// =============================================================================
// Product Sync
// =============================================================================

/**
 * Sync products to Shopware (idempotent upsert).
 *
 * @param dataHydrator - Authenticated DataHydrator instance
 * @param blueprint - Hydrated blueprint with products
 * @param salesChannel - SalesChannel to sync to
 * @param categoryIdMap - Map of category path -> Shopware category ID
 * @param propertyOptionMap - Map of "group::option" -> { id, name }
 */
export async function syncProducts(
    dataHydrator: DataHydrator,
    blueprint: HydratedBlueprint,
    salesChannel: SalesChannelFull,
    categoryIdMap: Map<string, string>,
    propertyOptionMap: Map<string, { id: string; name: string }>
): Promise<void> {
    // Build reverse lookup: category ID -> path
    const blueprintPathMap = buildBlueprintCategoryPathMap(blueprint.categories);
    const idToPath = new Map<string, string>();
    for (const [path, id] of blueprintPathMap) {
        idToPath.set(id, path);
    }

    type ProductToCreate = {
        id: string;
        name: string;
        description: string;
        price: number;
        stock: number;
        options?: Array<{ id: string; name: string }>;
        categoryIds?: string[];
    };

    const productsToCreate: ProductToCreate[] = blueprint.products.map((p) => {
        // Map product properties to option IDs
        const options: Array<{ id: string; name: string }> = [];
        for (const prop of p.metadata.properties) {
            const key = `${prop.group.toLowerCase()}::${prop.value.toLowerCase()}`;
            const option = propertyOptionMap.get(key);
            if (option) {
                options.push(option);
            }
        }

        // Map blueprint category IDs to Shopware category IDs via paths
        const resolvedCategoryIds: string[] = [];
        for (const catId of p.categoryIds) {
            // Find the path for this blueprint category ID
            const path = findCategoryPathById(blueprint.categories, catId);
            if (path) {
                // Get the Shopware category ID for this path
                const shopwareCatId = categoryIdMap.get(path);
                if (shopwareCatId) {
                    resolvedCategoryIds.push(shopwareCatId);
                }
            }
        }

        return {
            id: p.id,
            name: p.name,
            description: p.description,
            price: p.price,
            stock: p.stock,
            categoryIds: resolvedCategoryIds.length > 0 ? resolvedCategoryIds : p.categoryIds,
            ...(options.length > 0 && { options }),
        };
    });

    await dataHydrator.hydrateEnvWithProductsDirect(
        productsToCreate,
        salesChannel.id,
        salesChannel.navigationCategoryId
    );
    console.log(`  Synced ${productsToCreate.length} products`);
}

// =============================================================================
// Property ID Sync (for blueprint updates)
// =============================================================================

/**
 * Sync property IDs back to product properties in the blueprint.
 * This updates the blueprint so property IDs are persisted.
 *
 * @param blueprint - Hydrated blueprint to update (modified in place)
 * @param propertyMaps - Property lookup maps
 */
export function syncPropertyIdsToBlueprint(
    blueprint: HydratedBlueprint,
    propertyMaps: PropertyMaps
): void {
    const { groupIdMap, optionIdMap } = propertyMaps;

    for (const product of blueprint.products) {
        for (const prop of product.metadata.properties) {
            prop.groupId = groupIdMap.get(prop.group.toLowerCase());
            prop.optionId = optionIdMap.get(
                `${prop.group.toLowerCase()}::${prop.value.toLowerCase()}`
            );
        }
    }
}
