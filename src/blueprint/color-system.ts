/**
 * Colour system - two colour levels on a hydrated blueprint (no AI)
 *
 * - Shades live in "Color" (product detail page, variant options). Hidden from the filter.
 * - Families live in "Color family" (listing filter). Every product gets the family of
 *   each of its shades, variant products also the families of their colour variants.
 *
 * All functions are idempotent and work on old blueprints too, so `generate` can apply
 * them to blueprints that were hydrated before the colour system existed.
 */

import type {
    BlueprintPropertyGroup,
    BlueprintPropertyOption,
    BlueprintProduct,
    ColorFamily,
    HydratedBlueprint,
    LearnedColorShades,
    ProductProperty,
    VariantConfig,
} from "../types/index.js";

import {
    COLOR_FAMILY_GROUP_ID,
    COLOR_FAMILY_GROUP_NAME,
    COLOR_SHADE_GROUP_NAME,
    colorFamilyOptionId,
    colorHasImage,
    getColorFamily,
} from "../fixtures/index.js";
import { COLOR_FAMILY_KEYS } from "../types/index.js";
import {
    estimateShade,
    familyFromHex,
    generateUUID,
    normalizeColorName,
    resolveShade,
} from "../utils/index.js";

const FAMILY_GROUP_KEY = COLOR_FAMILY_GROUP_NAME.toLowerCase();

/** Group names the AI uses for the shade group */
const SHADE_GROUP_SPELLINGS = new Set(["color", "colour", "colors", "colours"]);

/** Check if a property group name means the shade group ("Color", "Colour", ...) */
export function isShadeGroupName(name: string): boolean {
    return SHADE_GROUP_SPELLINGS.has(name.trim().toLowerCase());
}

/** Check if a property group name is the family group */
export function isFamilyGroupName(name: string): boolean {
    return name.trim().toLowerCase() === FAMILY_GROUP_KEY;
}

// =============================================================================
// Step 1: normalise product colour values (before property collection)
// =============================================================================

function normalizeProperties(properties: ProductProperty[]): ProductProperty[] {
    const seen = new Set<string>();
    return properties
        .map((prop) => {
            if (!isShadeGroupName(prop.group)) return prop;
            return {
                ...prop,
                group: COLOR_SHADE_GROUP_NAME,
                value: normalizeColorName(prop.value),
            };
        })
        .filter((prop) => {
            const key = `${prop.group.toLowerCase()}::${prop.value.toLowerCase()}`;
            if (!prop.value || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function normalizeVariantConfig(config: VariantConfig): VariantConfig {
    if (!isShadeGroupName(config.group)) return config;
    const selectedOptions = [...new Set(config.selectedOptions.map(normalizeColorName))].filter(
        Boolean
    );
    const priceModifiers = Object.fromEntries(
        Object.entries(config.priceModifiers).map(([name, modifier]) => [
            normalizeColorName(name),
            modifier,
        ])
    );
    return { ...config, group: COLOR_SHADE_GROUP_NAME, selectedOptions, priceModifiers };
}

/**
 * Normalise colour group names and shade names on all products (in place):
 * "Colour" → "Color", "grey" → "Gray", "navy blue" → "Navy", "3 colours" → "Multicolor".
 */
export function normalizeProductColors(blueprint: HydratedBlueprint): void {
    for (const product of blueprint.products) {
        product.metadata.properties = normalizeProperties(product.metadata.properties);
        const configs = product.metadata.variantConfigs;
        if (configs) product.metadata.variantConfigs = configs.map(normalizeVariantConfig);
    }
}

/** All shade names used by products (properties and colour variant options) */
export function collectShadeNames(blueprint: HydratedBlueprint): string[] {
    const names = blueprint.products.flatMap((product) => [
        ...product.metadata.properties.filter((p) => isShadeGroupName(p.group)).map((p) => p.value),
        ...(product.metadata.variantConfigs ?? [])
            .filter((c) => isShadeGroupName(c.group))
            .flatMap((c) => c.selectedOptions),
    ]);
    const unique = new Map(names.filter(Boolean).map((n) => [n.toLowerCase(), n]));
    return [...unique.values()];
}

// =============================================================================
// Step 2: shade group, family group and product families (after collection)
// =============================================================================

function annotateShadeOption(
    option: BlueprintPropertyOption,
    learned: LearnedColorShades
): BlueprintPropertyOption {
    // Colours with images (Multicolor, Rainbow, ...) show their image, not a hex swatch
    const withoutHex = colorHasImage(option.name);
    const known = resolveShade(option.name, learned);
    if (known) {
        return {
            ...option,
            colorHexCode: withoutHex ? undefined : known.hex,
            family: known.family,
        };
    }
    // Unknown name: an existing hex (e.g. set in the Shopware admin) beats a guess
    const existingHex = option.colorHexCode;
    if (existingHex && !withoutHex) {
        return { ...option, family: familyFromHex(existingHex) };
    }
    const estimate = estimateShade(option.name);
    return {
        ...option,
        colorHexCode: withoutHex ? undefined : estimate.hex,
        family: estimate.family,
    };
}

/** Find the shade group, or create it when products use colours but no group exists */
function ensureShadeGroup(blueprint: HydratedBlueprint): BlueprintPropertyGroup | undefined {
    const existing = blueprint.propertyGroups.find((g) => isShadeGroupName(g.name));
    if (existing) return existing;
    if (collectShadeNames(blueprint).length === 0) return undefined;
    const group: BlueprintPropertyGroup = {
        id: generateUUID(),
        name: COLOR_SHADE_GROUP_NAME,
        displayType: "color",
        options: [],
    };
    blueprint.propertyGroups.push(group);
    return group;
}

/** Add options for shade names used by products but missing in the group */
function addMissingShadeOptions(group: BlueprintPropertyGroup, names: string[]): void {
    const known = new Set(group.options.map((o) => o.name.toLowerCase()));
    const missing = names.filter((n) => !known.has(n.toLowerCase()));
    group.options.push(...missing.map((name) => ({ id: generateUUID(), name })));
}

/** Families of the shades a product uses, in fixture order */
function productFamilies(
    product: BlueprintProduct,
    familyByShade: Map<string, ColorFamily>
): ColorFamily[] {
    const shades = [
        ...product.metadata.properties
            .filter((p) => p.group === COLOR_SHADE_GROUP_NAME)
            .map((p) => p.value),
        ...(product.metadata.variantConfigs ?? [])
            .filter((c) => c.group === COLOR_SHADE_GROUP_NAME)
            .flatMap((c) => c.selectedOptions),
    ];
    const families = new Set(
        shades
            .map((s) => familyByShade.get(s.toLowerCase()))
            .filter((f): f is ColorFamily => f !== undefined)
    );
    return COLOR_FAMILY_KEYS.filter((f) => families.has(f));
}

/** Replace the product's family properties with the families of its shades */
function assignProductFamilies(
    product: BlueprintProduct,
    familyByShade: Map<string, ColorFamily>
): ColorFamily[] {
    const families = productFamilies(product, familyByShade);
    const withoutFamilies = product.metadata.properties.filter((p) => !isFamilyGroupName(p.group));
    const familyProps = families.map((family) => ({
        group: COLOR_FAMILY_GROUP_NAME,
        value: getColorFamily(family).name,
    }));
    product.metadata.properties = [...withoutFamilies, ...familyProps];
    return families;
}

function buildFamilyGroup(families: Set<ColorFamily>): BlueprintPropertyGroup {
    const options = COLOR_FAMILY_KEYS.filter((f) => families.has(f)).map((family) => {
        const fixture = getColorFamily(family);
        return {
            id: colorFamilyOptionId(family),
            name: fixture.name,
            colorHexCode: fixture.hex,
            family,
        };
    });
    return {
        id: COLOR_FAMILY_GROUP_ID,
        name: COLOR_FAMILY_GROUP_NAME,
        displayType: "color",
        filterable: true,
        options,
    };
}

/**
 * Apply the colour system to a hydrated blueprint (in place, idempotent, no AI):
 *
 * 1. Normalise colour values on products and variant configs
 * 2. Give every "Color" option its family and hex (curated → learned → estimate)
 * 3. Hide "Color" from the listing filter
 * 4. Add the "Color family" group with the families in use (shown in the filter)
 * 5. Assign each product the families of its shades
 *
 * @param learned - Store-specific shades classified by the AI (`color-shades.json`)
 */
export function applyColorSystem(
    blueprint: HydratedBlueprint,
    learned: LearnedColorShades = {}
): void {
    normalizeProductColors(blueprint);
    blueprint.propertyGroups = blueprint.propertyGroups.filter((g) => !isFamilyGroupName(g.name));

    const shadeGroup = ensureShadeGroup(blueprint);
    if (!shadeGroup) return;

    shadeGroup.name = COLOR_SHADE_GROUP_NAME;
    shadeGroup.displayType = "color";
    shadeGroup.filterable = false;
    addMissingShadeOptions(shadeGroup, collectShadeNames(blueprint));
    shadeGroup.options = shadeGroup.options.map((o) => annotateShadeOption(o, learned));

    const familyByShade = new Map(
        shadeGroup.options.flatMap((o) =>
            o.family ? [[o.name.toLowerCase(), o.family] as const] : []
        )
    );
    const usedFamilies = new Set(
        blueprint.products.flatMap((p) => assignProductFamilies(p, familyByShade))
    );
    if (usedFamilies.size === 0) return;

    blueprint.propertyGroups.push(buildFamilyGroup(usedFamilies));
}
