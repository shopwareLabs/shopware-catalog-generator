/**
 * Property Collector - Collects and deduplicates properties from products
 *
 * After AI hydration, products have properties like:
 *   { group: "Color", value: "Oak" }
 *
 * This collector:
 * 1. Collects all unique properties from all products
 * 2. Groups them by property group name
 * 3. Deduplicates values within each group
 * 4. Merges with existing Shopware properties
 * 5. Generates UUIDs for Shopware creation
 * 6. Applies HEX color codes from the color palette
 */

import type {
    BlueprintPropertyGroup,
    BlueprintPropertyOption,
    HydratedBlueprint,
} from "../types/index.js";

import { colorHasImage } from "../fixtures/index.js";
import { getColorHex } from "./color-palette.js";
import { generateUUID } from "./uuid.js";

/**
 * Existing property option from Shopware
 */
export interface ExistingPropertyOption {
    id: string;
    name: string;
    colorHexCode?: string;
}

/**
 * Existing property group from Shopware with IDs for reuse
 */
export interface ExistingProperty {
    id: string;
    name: string;
    displayType: string;
    /** Shown in the listing filter */
    filterable?: boolean;
    options: ExistingPropertyOption[];
}

/** Add a value keyed by its lowercase form, keeping the first casing seen */
function addCaseInsensitive(values: Map<string, string>, value: string): void {
    const key = value.toLowerCase();
    if (!values.has(key)) values.set(key, value);
}

/** A property group collected from products: first casing seen + values by lowercase key */
interface CollectedGroup {
    name: string;
    values: Map<string, string>;
}

/**
 * Collect all property values from products, keyed by lowercase group name.
 * Group names and values are matched case-insensitively ("Multicolor Floral" =
 * "Multicolor floral"), the first casing wins. Otherwise both spellings would map
 * to the same Shopware option ID.
 */
function collectProductPropertyValues(blueprint: HydratedBlueprint): Map<string, CollectedGroup> {
    const groups = new Map<string, CollectedGroup>();
    const properties = blueprint.products
        .flatMap((product) => product.metadata.properties)
        .map((prop) => ({ group: prop.group.trim(), value: prop.value.trim() }))
        .filter((prop) => prop.group && prop.value);

    for (const prop of properties) {
        const key = prop.group.toLowerCase();
        const group = groups.get(key) ?? { name: prop.group, values: new Map<string, string>() };
        groups.set(key, group);
        addCaseInsensitive(group.values, prop.value);
    }
    return groups;
}

/** Build one property group, reusing the IDs and casing of an existing Shopware group */
function buildPropertyGroup(
    normalizedName: string,
    collected: CollectedGroup,
    existingGroup: ExistingProperty | undefined
): BlueprintPropertyGroup {
    const isColorType = isColorGroup(normalizedName, existingGroup);
    const existingOptions = existingGroup?.options ?? [];
    const existingOptionByName = new Map(existingOptions.map((o) => [o.name.toLowerCase(), o]));
    // Keep the options Shopware already has, even if no product uses them now
    for (const option of existingOptions) addCaseInsensitive(collected.values, option.name);

    return {
        ...groupIdentity(collected.name, existingGroup),
        displayType: isColorType ? "color" : "text",
        options: [...collected.values.values()].map((value) =>
            buildPropertyOption(value, existingOptionByName.get(value.toLowerCase()), isColorType)
        ),
    };
}

/**
 * Color type: inherited from an existing group OR if the group name is "Color".
 * This ensures fresh stores get color hex codes too
 */
function isColorGroup(
    normalizedName: string,
    existingGroup: ExistingProperty | undefined
): boolean {
    return existingGroup?.displayType === "color" || normalizedName === "color";
}

/** ID and name of an existing group (its casing wins), or a new ID */
function groupIdentity(
    name: string,
    existingGroup: ExistingProperty | undefined
): Pick<BlueprintPropertyGroup, "id" | "name"> {
    if (!existingGroup) return { id: generateUUID(), name };
    return { id: existingGroup.id, name: existingGroup.name };
}

function buildPropertyOption(
    value: string,
    existingOption: ExistingPropertyOption | undefined,
    isColorType: boolean
): BlueprintPropertyOption {
    return {
        id: existingOption?.id ?? generateUUID(),
        name: existingOption?.name ?? value, // Prefer existing name casing
        colorHexCode: optionHexCode(value, existingOption, isColorType),
    };
}

/** Hex codes are generated for colour groups only; colours with images (Multicolor, ...) get none */
function optionHexCode(
    value: string,
    existingOption: ExistingPropertyOption | undefined,
    isColorType: boolean
): string | undefined {
    if (!isColorType) return existingOption?.colorHexCode;
    if (colorHasImage(value)) return undefined;
    return existingOption?.colorHexCode ?? getColorHex(value);
}

/**
 * Property Collector class
 */
export class PropertyCollector {
    /**
     * Collect and deduplicate properties from a hydrated blueprint.
     * Reuses existing property group and option IDs from Shopware when available.
     */
    collectFromBlueprint(
        blueprint: HydratedBlueprint,
        existingProperties: ExistingProperty[] = []
    ): BlueprintPropertyGroup[] {
        const existingGroupByName = new Map(
            existingProperties.map((prop) => [prop.name.toLowerCase(), prop])
        );
        return [...collectProductPropertyValues(blueprint)].map(([normalizedName, collected]) =>
            buildPropertyGroup(normalizedName, collected, existingGroupByName.get(normalizedName))
        );
    }

    /**
     * Collect unique manufacturer names from a hydrated blueprint
     */
    collectManufacturers(blueprint: HydratedBlueprint): string[] {
        const manufacturers = new Set<string>();

        for (const product of blueprint.products) {
            const name = product.metadata.manufacturerName?.trim();
            if (name) {
                manufacturers.add(name);
            }
        }

        return Array.from(manufacturers);
    }

    /**
     * Create a mapping from property option name to ID for Shopware
     */
    createOptionIdMap(groups: BlueprintPropertyGroup[]): Map<string, string> {
        const map = new Map<string, string>();

        for (const group of groups) {
            for (const option of group.options) {
                // Key: "GroupName:OptionValue" for uniqueness
                const key = `${group.name.toLowerCase()}:${option.name.toLowerCase()}`;
                map.set(key, option.id);
            }
        }

        return map;
    }

    /**
     * Get property option ID for a product property
     */
    getOptionId(
        optionIdMap: Map<string, string>,
        groupName: string,
        optionValue: string
    ): string | undefined {
        const key = `${groupName.toLowerCase()}:${optionValue.toLowerCase()}`;
        return optionIdMap.get(key);
    }
}
