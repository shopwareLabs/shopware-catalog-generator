/**
 * Shopware Sync Operations
 *
 * Shared sync functions used by both CLI (main.ts) and server.
 * These orchestrate the DataHydrator to sync data to Shopware.
 */

import fs from "node:fs";
import path from "node:path";

import type {
    BlueprintPropertyGroup,
    BlueprintPropertyOption,
    CategoryNode,
    HydratedBlueprint,
    ProductCustomFieldValues,
    ProductPackaging,
    ProductSyncResult,
    ProductType,
    PropertyGroup,
    PropertyOption,
    SalesChannelFull,
} from "../types/index.js";
import type { ExistingProperty } from "../utils/index.js";
import type { DataHydrator } from "./index.js";
import type { ShopwareCapabilities } from "./version.js";

import { singleOptionGroupNames } from "../blueprint/property-synonyms.js";
import {
    buildCategoryPath,
    convertBlueprintCategories,
    findCategoryPathById,
    hideEmptyCategories,
    logger,
} from "../utils/index.js";

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

    // New SalesChannel: create all categories
    if (isNew) {
        const categoryIdMap = await dataHydrator.createCategoryTree(
            categoryTreeForUpload(blueprint),
            salesChannel.navigationCategoryId,
            salesChannel.id
        );
        logger.info(`  Created ${categoryIdMap.size} categories`, { cli: true });
        return categoryIdMap;
    }

    // Existing SalesChannel: get existing categories, then upsert
    const existingCategoryMap = await dataHydrator.getExistingCategoryMap(
        salesChannel.navigationCategoryId,
        categoryNodes
    );

    // Build a map of old ID -> new ID for updating product categoryIds
    const oldToNewIdMap = new Map<string, string>();

    // Update blueprint category IDs with existing ones
    const updateCategoryIds = (
        cats: HydratedBlueprint["categories"],
        existingMap: Map<string, string>,
        parentPath: string | null = null
    ): void => {
        for (const cat of cats) {
            const path = buildCategoryPath(parentPath, cat.name);
            const existingId = existingMap.get(path);
            if (existingId && cat.id !== existingId) {
                // Track the mapping from old ID to new ID
                oldToNewIdMap.set(cat.id, existingId);
                cat.id = existingId;
            }
            if (cat.children.length > 0) {
                updateCategoryIds(cat.children, existingMap, path);
            }
        }
    };
    updateCategoryIds(blueprint.categories, existingCategoryMap);

    // Update product categoryIds to use the new Shopware IDs
    if (oldToNewIdMap.size > 0) {
        for (const product of blueprint.products) {
            product.categoryIds = product.categoryIds.map(
                (catId) => oldToNewIdMap.get(catId) ?? catId
            );
            const newPrimaryCatId = product.primaryCategoryId
                ? oldToNewIdMap.get(product.primaryCategoryId)
                : undefined;
            if (newPrimaryCatId) {
                product.primaryCategoryId = newPrimaryCatId;
            }
        }
    }

    // Create/update categories (upsert)
    const categoryIdMap = await dataHydrator.createCategoryTree(
        categoryTreeForUpload(blueprint),
        salesChannel.navigationCategoryId,
        salesChannel.id
    );
    logger.info(`  Synced ${categoryIdMap.size} categories`, { cli: true });
    return categoryIdMap;
}

/** Category nodes for the upload, empty categories hidden from the navigation */
function categoryTreeForUpload(blueprint: HydratedBlueprint): CategoryNode[] {
    const productCategoryIds = new Set(blueprint.products.flatMap((p) => p.categoryIds));
    const nodes = hideEmptyCategories(
        convertBlueprintCategories(blueprint.categories),
        productCategoryIds
    );
    const hidden = countHidden(nodes);
    if (hidden > 0) {
        logger.info(`  ${hidden} categories without products are hidden from the navigation`, {
            cli: true,
        });
    }
    return nodes;
}

function countHidden(nodes: CategoryNode[]): number {
    return nodes.reduce(
        (sum, n) => sum + (n.visible === false ? 1 : 0) + countHidden(n.children),
        0
    );
}

// =============================================================================
// Property Group Sync
// =============================================================================

/**
 * Sync property groups to Shopware (smart idempotent sync).
 *
 * This function:
 * 1. Fetches existing property groups from Shopware
 * 2. For matching groups (by name): uses existing IDs and adds missing options
 * 3. For new groups: creates them with blueprint IDs
 * 4. Updates the blueprint with correct Shopware IDs
 *
 * @param dataHydrator - Authenticated DataHydrator instance
 * @param blueprint - Hydrated blueprint with property groups (modified in place)
 */
export async function syncPropertyGroups(
    dataHydrator: DataHydrator,
    blueprint: HydratedBlueprint
): Promise<void> {
    const existingGroups = await dataHydrator.getExistingPropertyGroups();
    const existingByName = new Map(existingGroups.map((g) => [g.name.toLowerCase(), g]));

    const counts = { created: 0, updated: 0, skipped: 0 };
    const propertyGroupsToSync: PropertyGroup[] = [];
    const singleOption = singleOptionGroupNames(blueprint);

    for (const blueprintGroup of blueprint.propertyGroups) {
        const existing = existingByName.get(blueprintGroup.name.toLowerCase());
        if (!existing) {
            const isSingle = singleOption.has(blueprintGroup.name.toLowerCase());
            propertyGroupsToSync.push(newPropertyGroupPayload(blueprintGroup, isSingle));
            counts.created++;
            continue;
        }

        const update = existingPropertyGroupUpdate(blueprintGroup, existing);
        if (!update) {
            counts.skipped++;
            continue;
        }
        propertyGroupsToSync.push(update);
        counts.updated++;
    }

    if (propertyGroupsToSync.length > 0) {
        await dataHydrator.hydrateEnvWithPropertyGroups(propertyGroupsToSync);
    }

    logger.info(
        `  Property groups: ${counts.created} created, ${counts.updated} updated, ${counts.skipped} unchanged`,
        { cli: true }
    );

    // Upload images for color options that can't use hex codes (Multicolor, Rainbow, etc.)
    await uploadColorImages(dataHydrator, blueprint);
}

/** What differs between a blueprint group and the matching Shopware group */
interface PropertyGroupDiff {
    wantsColor: boolean;
    missingOptions: BlueprintPropertyOption[];
    hexUpdates: BlueprintPropertyOption[];
    needsDisplayTypeUpdate: boolean;
    needsFilterableUpdate: boolean;
}

/**
 * Payload for a group that does not exist in Shopware yet (blueprint IDs). A group whose
 * products use one option only is kept out of the listing filter, unless the blueprint
 * says otherwise. Existing groups keep their setting: other stores may use more options.
 */
function newPropertyGroupPayload(
    group: BlueprintPropertyGroup,
    hasSingleOption: boolean
): PropertyGroup {
    const isColorType = group.displayType === "color";
    return {
        id: group.id,
        name: group.name,
        description: `Properties for ${group.name}`,
        displayType: group.displayType,
        filterable: group.filterable ?? (hasSingleOption ? false : undefined),
        options: group.options.map((o) => optionPayload(o, isColorType)),
    };
}

/**
 * Adopt the Shopware IDs of an existing group into the blueprint and return the
 * update payload, or null when Shopware already matches the blueprint.
 */
function existingPropertyGroupUpdate(
    group: BlueprintPropertyGroup,
    existing: ExistingProperty
): PropertyGroup | null {
    adoptExistingIds(group, existing);

    const diff = diffPropertyGroup(group, existing);
    const hasChanges =
        diff.missingOptions.length > 0 ||
        diff.hexUpdates.length > 0 ||
        diff.needsDisplayTypeUpdate ||
        diff.needsFilterableUpdate;
    if (!hasChanges) return null;

    logPropertyGroupUpdate(existing.name, group, diff);

    return {
        id: existing.id,
        name: existing.name,
        description: `Properties for ${existing.name}`,
        displayType: diff.wantsColor ? "color" : existing.displayType,
        filterable: group.filterable,
        options: optionsToSync(group, diff),
    };
}

/** Use Shopware's group ID and the IDs of options Shopware already has */
function adoptExistingIds(group: BlueprintPropertyGroup, existing: ExistingProperty): void {
    group.id = existing.id;
    const existingIdByName = new Map(existing.options.map((o) => [o.name.toLowerCase(), o.id]));
    for (const option of group.options) {
        option.id = existingIdByName.get(option.name.toLowerCase()) ?? option.id;
    }
}

function diffPropertyGroup(
    group: BlueprintPropertyGroup,
    existing: ExistingProperty
): PropertyGroupDiff {
    const existingByName = new Map(existing.options.map((o) => [o.name.toLowerCase(), o]));
    const wantsColor = group.displayType === "color";

    return {
        wantsColor,
        missingOptions: group.options.filter((o) => !existingByName.has(o.name.toLowerCase())),
        hexUpdates: wantsColor
            ? group.options.filter((o) => {
                  const existingOption = existingByName.get(o.name.toLowerCase());
                  return (
                      existingOption &&
                      o.colorHexCode &&
                      existingOption.colorHexCode !== o.colorHexCode
                  );
              })
            : [],
        needsDisplayTypeUpdate: wantsColor && existing.displayType !== "color",
        needsFilterableUpdate:
            group.filterable !== undefined && existing.filterable !== group.filterable,
    };
}

/**
 * Switching to colour resends every option with its hex code. Otherwise only the
 * missing options and the options with a changed hex code are sent.
 * Option IDs are already the Shopware IDs where they exist (adoptExistingIds).
 */
function optionsToSync(group: BlueprintPropertyGroup, diff: PropertyGroupDiff): PropertyOption[] {
    if (diff.needsDisplayTypeUpdate) {
        return group.options.map((o) => optionPayload(o, true));
    }
    return [
        ...diff.missingOptions.map((o) => optionPayload(o, diff.wantsColor)),
        ...diff.hexUpdates.map((o) => optionPayload(o, true)),
    ];
}

/** Hex codes are only sent for colour-type groups */
function optionPayload(option: BlueprintPropertyOption, withHex: boolean): PropertyOption {
    return {
        id: option.id,
        name: option.name,
        colorHexCode: withHex ? option.colorHexCode : undefined,
    };
}

function logPropertyGroupUpdate(
    name: string,
    group: BlueprintPropertyGroup,
    diff: PropertyGroupDiff
): void {
    if (diff.needsFilterableUpdate) {
        const state = group.filterable ? "shown in" : "hidden from";
        logger.info(`  ⊕ "${name}" is now ${state} the listing filter`, { cli: true });
    }
    if (diff.needsDisplayTypeUpdate) {
        logger.info(`  ⊕ Updating "${name}" displayType to "color" with hex codes`, { cli: true });
        return;
    }
    if (diff.missingOptions.length > 0) {
        logger.info(`  ⊕ Adding ${diff.missingOptions.length} options to "${name}"`, { cli: true });
    }
    if (diff.hexUpdates.length > 0) {
        logger.info(`  ⊕ Updating ${diff.hexUpdates.length} color hex codes in "${name}"`, {
            cli: true,
        });
    }
}

// =============================================================================
// Special Color Images
// =============================================================================

/**
 * Upload images for color options that can't be represented with hex codes.
 * This runs after property groups are synced to set mediaId on options.
 */
async function uploadColorImages(
    dataHydrator: DataHydrator,
    blueprint: HydratedBlueprint
): Promise<void> {
    const { colorHasImage, getColorImagePath } = await import("../fixtures/index.js");

    const colorGroup = blueprint.propertyGroups.find((g) => g.name.toLowerCase() === "color");
    if (!colorGroup) return;

    const imageOptions = colorGroup.options.filter((o) => colorHasImage(o.name));
    if (imageOptions.length === 0) return;

    logger.info(`  Uploading images for ${imageOptions.length} color options...`, {
        cli: true,
    });

    const folderId = await dataHydrator.getOrCreateMediaFolder("Property Images");
    if (!folderId) {
        logger.warn("Could not create media folder for property images");
        return;
    }

    const fixturesDir = path.join(import.meta.dir, "..", "fixtures");
    for (const option of imageOptions) {
        await uploadColorImage(dataHydrator, folderId, option, {
            fixturesDir,
            imagePath: getColorImagePath(option.name),
        });
    }
}

/** Fixture image of one colour option, relative to the fixtures directory */
interface ColorImageSource {
    fixturesDir: string;
    imagePath: string | undefined;
}

/** Upload one colour image; a missing file or failed upload is logged and skipped */
async function uploadColorImage(
    dataHydrator: DataHydrator,
    folderId: string,
    option: BlueprintPropertyOption,
    source: ColorImageSource
): Promise<void> {
    if (!source.imagePath) return;

    const fullPath = path.join(source.fixturesDir, source.imagePath);
    if (!fs.existsSync(fullPath)) {
        logger.warn(`Color image not found: ${fullPath}`);
        return;
    }

    try {
        const extension = path.extname(source.imagePath).slice(1); // "png" or "svg"
        await linkColorImage(dataHydrator, folderId, option, fs.readFileSync(fullPath), extension);
    } catch (error) {
        logger.warn(
            `Failed to upload image for ${option.name}: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/** Create the media entity, upload the file and set it on the property option */
async function linkColorImage(
    dataHydrator: DataHydrator,
    folderId: string,
    option: BlueprintPropertyOption,
    imageBuffer: Buffer,
    extension: string
): Promise<void> {
    const mediaId = await dataHydrator.createMedia(folderId, colorMediaName(option.name));
    if (!mediaId) return;

    await dataHydrator.uploadMediaFile(mediaId, imageBuffer, extension);
    await dataHydrator.updatePropertyOptionMedia(option.id, mediaId);
    logger.info(`Uploaded image for color option: ${option.name}`);
}

/** Media file name for a colour option, e.g. "Multi Color" → "color-multi-color" */
function colorMediaName(optionName: string): string {
    return `color-${optionName.toLowerCase().replace(/\s+/g, "-")}`;
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
    const groupIdMap = new Map(blueprint.propertyGroups.map((g) => [g.name.toLowerCase(), g.id]));

    // Build option maps from flattened group.options
    const optionEntries = blueprint.propertyGroups.flatMap((group) =>
        group.options.map((option) => {
            const key = `${group.name.toLowerCase()}::${option.name.toLowerCase()}`;
            return { key, id: option.id, name: option.name };
        })
    );

    const optionIdMap = new Map(optionEntries.map((e) => [e.key, e.id]));
    const propertyOptionMap = new Map(
        optionEntries.map((e) => [e.key, { id: e.id, name: e.name }])
    );

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
 * @param shopware - Capabilities of the connected shop (decides which optional fields are sent)
 * @returns How many products Shopware accepted and how many were in rejected batches
 */
export async function syncProducts(
    dataHydrator: DataHydrator,
    blueprint: HydratedBlueprint,
    salesChannel: SalesChannelFull,
    categoryIdMap: Map<string, string>,
    propertyOptionMap: Map<string, { id: string; name: string }>,
    shopware: ShopwareCapabilities
): Promise<ProductSyncResult> {
    const sendProductType = shopware.supports("productType");
    const sendOpenGraph = shopware.supports("productOpenGraph");
    const sendCustomFields = await ensureCustomFieldSet(dataHydrator, blueprint, shopware);

    const lookups: ProductLookups = {
        categories: blueprint.categories,
        categoryIdMap,
        propertyOptionMap,
        flags: { sendProductType, sendOpenGraph, sendCustomFields },
    };
    const productsToCreate = blueprint.products.map((p) => toProductToCreate(p, lookups));

    const synced = await dataHydrator.hydrateEnvWithProductsDirect(
        productsToCreate,
        salesChannel.id,
        salesChannel.navigationCategoryId
    );
    const failed = productsToCreate.length - synced;
    logger.info(`  Synced ${synced} products`, { cli: true });
    if (failed > 0) {
        logger.error(`  ✗ ${failed} products were rejected by Shopware (see log for details)`, {
            cli: true,
        });
    }
    return { synced, failed };
}

type HydratedProduct = HydratedBlueprint["products"][number];

/** Product as passed to DataHydrator.hydrateEnvWithProductsDirect */
interface ProductToCreate {
    id: string;
    name: string;
    description: string;
    price: number;
    stock: number;
    options?: Array<{ id: string; name: string }>;
    /** Options left out because they belong to the product's own variant groups */
    removedOptionIds?: string[];
    categoryIds?: string[];
    hasSalesPrice?: boolean;
    salePercentage?: number;
    hasTieredPricing?: boolean;
    isTopseller: boolean;
    isNew: boolean;
    isShippingFree: boolean;
    weight: number;
    width: number;
    height: number;
    length: number;
    ean: string;
    manufacturerNumber: string;
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

/** Which version-gated product fields the connected shop accepts */
interface ProductFieldFlags {
    sendProductType: boolean;
    sendOpenGraph: boolean;
    sendCustomFields: boolean;
}

/** Everything needed to turn a blueprint product into an upload product */
interface ProductLookups {
    categories: HydratedBlueprint["categories"];
    categoryIdMap: Map<string, string>;
    propertyOptionMap: Map<string, { id: string; name: string }>;
    flags: ProductFieldFlags;
}

function toProductToCreate(p: HydratedProduct, lookups: ProductLookups): ProductToCreate {
    const { options, removedOptionIds } = resolveProductOptions(p, lookups.propertyOptionMap);
    const resolvedCategoryIds = resolveCategoryIds(p, lookups);
    const { metadata } = p;

    return {
        id: p.id,
        name: p.name,
        description: p.description,
        price: p.price,
        stock: p.stock,
        // Fall back to the blueprint IDs when no category path resolves
        categoryIds: resolvedCategoryIds.length > 0 ? resolvedCategoryIds : p.categoryIds,
        ...(options.length > 0 && { options }),
        ...(removedOptionIds.length > 0 && { removedOptionIds }),
        hasSalesPrice: metadata.hasSalesPrice,
        salePercentage: metadata.salePercentage,
        hasTieredPricing: metadata.hasTieredPricing,
        isTopseller: metadata.isTopseller,
        isNew: metadata.isNew,
        isShippingFree: metadata.isShippingFree,
        weight: metadata.weight,
        width: metadata.width,
        height: metadata.height,
        length: metadata.length,
        ean: metadata.ean,
        manufacturerNumber: metadata.manufacturerNumber,
        ...purchaseAndSeoFields(p),
        ...versionGatedFields(p, lookups.flags),
    };
}

/** Lowercase names of the groups a variant product's variants differ in */
function variantGroupNames(p: HydratedProduct): Set<string> {
    if (!p.metadata.isVariant) return new Set();
    return new Set((p.metadata.variantConfigs ?? []).map((c) => c.group.toLowerCase()));
}

/**
 * Product properties mapped to Shopware option IDs ("group::value", lowercase); unknown
 * ones are dropped. A variant parent leaves out its own variant groups: the variants
 * inherit the parent's properties, so "Color: Navy" would show on the Black variant.
 */
function resolveProductOptions(
    p: HydratedProduct,
    propertyOptionMap: Map<string, { id: string; name: string }>
): { options: Array<{ id: string; name: string }>; removedOptionIds: string[] } {
    const variantGroups = variantGroupNames(p);
    const resolved = p.metadata.properties
        .map((prop) => ({
            isVariantGroup: variantGroups.has(prop.group.toLowerCase()),
            option: propertyOptionMap.get(
                `${prop.group.toLowerCase()}::${prop.value.toLowerCase()}`
            ),
        }))
        .filter(
            (r): r is { isVariantGroup: boolean; option: { id: string; name: string } } =>
                r.option !== undefined
        );
    return {
        options: resolved.filter((r) => !r.isVariantGroup).map((r) => r.option),
        removedOptionIds: resolved.filter((r) => r.isVariantGroup).map((r) => r.option.id),
    };
}

/** Blueprint category IDs mapped to Shopware category IDs via their paths */
function resolveCategoryIds(p: HydratedProduct, lookups: ProductLookups): string[] {
    return p.categoryIds
        .map((catId) => findCategoryPathById(lookups.categories, catId))
        .filter((path): path is string => path !== undefined)
        .map((path) => lookups.categoryIdMap.get(path))
        .filter((id): id is string => id !== undefined);
}

/** Purchase limits, SEO texts, delivery time and packaging, only when set */
function purchaseAndSeoFields(p: HydratedProduct): Partial<ProductToCreate> {
    const { metadata } = p;
    return {
        ...(metadata.minPurchase && {
            minPurchase: metadata.minPurchase,
            purchaseSteps: metadata.purchaseSteps,
        }),
        ...(metadata.maxPurchase && { maxPurchase: metadata.maxPurchase }),
        ...(p.metaTitle && { metaTitle: p.metaTitle }),
        ...(p.metaDescription && { metaDescription: p.metaDescription }),
        ...(p.deliveryTimeIndex !== undefined && { deliveryTimeIndex: p.deliveryTimeIndex }),
        ...(metadata.packaging && { packaging: metadata.packaging }),
    };
}

/** Product type, custom fields and Open Graph texts, only for shops that support them */
function versionGatedFields(
    p: HydratedProduct,
    flags: ProductFieldFlags
): Partial<ProductToCreate> {
    return {
        ...(flags.sendProductType && { type: p.type ?? "physical" }),
        ...(flags.sendCustomFields &&
            p.metadata.customFields && { customFields: p.metadata.customFields }),
        ...(flags.sendOpenGraph && openGraphFields(p)),
    };
}

/** Open Graph title (falls back to the name) and description */
function openGraphFields(p: HydratedProduct): Partial<ProductToCreate> {
    return {
        ogTitle: p.metaTitle ?? p.name,
        ...(p.metaDescription && { ogDescription: p.metaDescription }),
    };
}

/**
 * Create the product custom field set when any product carries custom field values.
 * A failure is logged and products are uploaded without custom fields.
 *
 * @returns Whether products should send their custom field values
 */
async function ensureCustomFieldSet(
    dataHydrator: DataHydrator,
    blueprint: HydratedBlueprint,
    shopware: ShopwareCapabilities
): Promise<boolean> {
    if (!blueprint.products.some((p) => p.metadata.customFields)) return false;

    try {
        await dataHydrator.ensureProductCustomFieldSet(shopware.supports("customFieldSearchable"));
        return true;
    } catch (error) {
        logger.warn("Could not create custom field set - products are uploaded without it", {
            cli: true,
            data: error,
        });
        return false;
    }
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
