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
    options: ExistingPropertyOption[];
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
        // Collect all properties from products
        const propertyMap = new Map<string, Set<string>>();

        for (const product of blueprint.products) {
            for (const prop of product.metadata.properties) {
                const groupName = prop.group.trim();
                const value = prop.value.trim();

                if (!groupName || !value) continue;

                const existing = propertyMap.get(groupName);
                if (existing) {
                    existing.add(value);
                } else {
                    propertyMap.set(groupName, new Set([value]));
                }
            }
        }

        // Build lookup maps for existing groups and options by normalized name
        const existingGroupByName = new Map<string, ExistingProperty>();
        for (const prop of existingProperties) {
            existingGroupByName.set(prop.name.toLowerCase(), prop);
        }

        // Build property groups, reusing existing IDs where available
        const groups: BlueprintPropertyGroup[] = [];

        for (const [groupName, values] of propertyMap) {
            const normalizedGroupName = groupName.toLowerCase();
            const existingGroup = existingGroupByName.get(normalizedGroupName);

            // Color type: inherited from existing groups OR if the group name is "Color"
            // This ensures fresh stores get color hex codes too
            const isColorType =
                existingGroup?.displayType === "color" || normalizedGroupName === "color";

            // Build option ID lookup for this group
            const existingOptionByName = new Map<string, ExistingPropertyOption>();
            if (existingGroup) {
                for (const opt of existingGroup.options) {
                    existingOptionByName.set(opt.name.toLowerCase(), opt);
                }
                // Also add any options from existing that aren't in the new set
                for (const opt of existingGroup.options) {
                    values.add(opt.name);
                }
            }

            // Build options, reusing existing IDs
            const options: BlueprintPropertyOption[] = [...values].map((value: string) => {
                const existingOption = existingOptionByName.get(value.toLowerCase());
                // Colors with images (Multicolor, Rainbow, etc.) don't get hex codes
                const hasImage = isColorType && colorHasImage(value);
                return {
                    id: existingOption?.id ?? generateUUID(),
                    name: existingOption?.name ?? value, // Prefer existing name casing
                    // Only generate hex codes for color-type groups without images
                    colorHexCode: hasImage
                        ? undefined
                        : (existingOption?.colorHexCode ??
                          (isColorType ? getColorHex(value) : undefined)),
                };
            });

            groups.push({
                id: existingGroup?.id ?? generateUUID(),
                name: existingGroup?.name ?? groupName, // Prefer existing name casing
                displayType: isColorType ? "color" : "text",
                options,
            });
        }

        return groups;
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
