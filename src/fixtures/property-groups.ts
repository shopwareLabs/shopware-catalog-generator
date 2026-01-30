/**
 * Default Property Groups
 *
 * These are the default property groups that get seeded into generated/properties/
 * on first use. Once seeded, they become regular cached property groups.
 *
 * To add new defaults, add them to the DEFAULT_PROPERTY_GROUPS array.
 * They will be created as JSON files in generated/properties/ on next run.
 */

import type { CachedPropertyGroup } from "../types/index.js";

/**
 * Default property groups that are seeded on first use
 */
export const DEFAULT_PROPERTY_GROUPS: CachedPropertyGroup[] = [
    // Common groups
    {
        name: "Size",
        slug: "size",
        displayType: "text",
        options: ["XS", "S", "M", "L", "XL", "XXL", "3XL"],
        priceModifiers: { XS: 0.9, S: 0.95, M: 1.0, L: 1.05, XL: 1.1, XXL: 1.15, "3XL": 1.2 },
        createdAt: "2025-01-01T00:00:00.000Z",
        source: "fixture",
    },
    {
        name: "Color",
        slug: "color",
        displayType: "color",
        options: ["Black", "White", "Red", "Blue", "Green", "Brown", "Gray", "Navy", "Beige", "Pink", "Orange", "Purple", "Yellow"],
        createdAt: "2025-01-01T00:00:00.000Z",
        source: "fixture",
    },
    {
        name: "Material",
        slug: "material",
        displayType: "text",
        options: ["Cotton", "Polyester", "Leather", "Wood", "Metal", "Plastic", "Glass", "Linen", "Silk", "Wool", "Bamboo", "Ceramic"],
        priceModifiers: { Plastic: 0.8, Polyester: 0.9, Cotton: 1.0, Linen: 1.1, Wool: 1.2, Leather: 1.3, Silk: 1.4, Wood: 1.1, Metal: 1.15, Glass: 1.2, Bamboo: 1.1, Ceramic: 1.15 },
        createdAt: "2025-01-01T00:00:00.000Z",
        source: "fixture",
    },
    {
        name: "Finish",
        slug: "finish",
        displayType: "text",
        options: ["Matte", "Glossy", "Satin", "Natural", "Brushed", "Polished", "Antique", "Distressed"],
        createdAt: "2025-01-01T00:00:00.000Z",
        source: "fixture",
    },
    {
        name: "Style",
        slug: "style",
        displayType: "text",
        options: ["Modern", "Classic", "Vintage", "Minimalist", "Industrial", "Bohemian", "Scandinavian", "Traditional"],
        createdAt: "2025-01-01T00:00:00.000Z",
        source: "fixture",
    },
    {
        name: "Pattern",
        slug: "pattern",
        displayType: "text",
        options: ["Solid", "Striped", "Checkered", "Floral", "Abstract", "Geometric", "Paisley", "Polka Dot"],
        createdAt: "2025-01-01T00:00:00.000Z",
        source: "fixture",
    },

    // Music-specific groups
    {
        name: "Body Wood",
        slug: "body-wood",
        displayType: "text",
        options: ["Mahogany", "Maple", "Alder", "Ash", "Basswood", "Poplar", "Walnut", "Spruce"],
        priceModifiers: { Poplar: 0.9, Basswood: 0.95, Alder: 1.0, Ash: 1.05, Maple: 1.1, Mahogany: 1.15, Walnut: 1.2, Spruce: 1.1 },
        createdAt: "2025-01-01T00:00:00.000Z",
        source: "fixture",
    },
    {
        name: "Pickup Configuration",
        slug: "pickup-configuration",
        displayType: "text",
        options: ["SSS", "HSS", "HSH", "HH", "SS", "P90", "Single Coil", "Humbucker"],
        createdAt: "2025-01-01T00:00:00.000Z",
        source: "fixture",
    },
    {
        name: "Neck Wood",
        slug: "neck-wood",
        displayType: "text",
        options: ["Maple", "Mahogany", "Rosewood", "Ebony", "Pau Ferro", "Wenge"],
        createdAt: "2025-01-01T00:00:00.000Z",
        source: "fixture",
    },
    {
        name: "Guitar Finish",
        slug: "guitar-finish",
        displayType: "text",
        options: ["Sunburst", "Natural", "Gloss Black", "Cherry Red", "Vintage White", "Tobacco Burst", "Ocean Blue", "Candy Apple Red"],
        priceModifiers: { Natural: 1.0, "Gloss Black": 1.0, "Vintage White": 1.05, Sunburst: 1.1, "Cherry Red": 1.1, "Tobacco Burst": 1.15, "Ocean Blue": 1.1, "Candy Apple Red": 1.15 },
        createdAt: "2025-01-01T00:00:00.000Z",
        source: "fixture",
    },
    {
        name: "Drum Size",
        slug: "drum-size",
        displayType: "text",
        options: ['10"', '12"', '13"', '14"', '16"', '18"', '20"', '22"', '24"'],
        priceModifiers: { '10"': 0.8, '12"': 0.9, '13"': 0.95, '14"': 1.0, '16"': 1.1, '18"': 1.2, '20"': 1.3, '22"': 1.4, '24"': 1.5 },
        createdAt: "2025-01-01T00:00:00.000Z",
        source: "fixture",
    },

    // Fashion-specific groups
    {
        name: "Shoe Size",
        slug: "shoe-size",
        displayType: "text",
        options: ["36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46"],
        createdAt: "2025-01-01T00:00:00.000Z",
        source: "fixture",
    },
    {
        name: "Waist Size",
        slug: "waist-size",
        displayType: "text",
        options: ["28", "30", "32", "34", "36", "38", "40", "42"],
        createdAt: "2025-01-01T00:00:00.000Z",
        source: "fixture",
    },
    {
        name: "Length",
        slug: "length",
        displayType: "text",
        options: ["Short", "Regular", "Long", "Extra Long"],
        createdAt: "2025-01-01T00:00:00.000Z",
        source: "fixture",
    },
];

/**
 * Get all default property groups
 */
export function getAllPropertyGroups(): CachedPropertyGroup[] {
    return DEFAULT_PROPERTY_GROUPS;
}

/**
 * Get common property groups (Size, Color, Material, etc.)
 */
export function getCommonPropertyGroups(): CachedPropertyGroup[] {
    const commonNames = ["Size", "Color", "Material", "Finish", "Style", "Pattern"];
    return DEFAULT_PROPERTY_GROUPS.filter((g) => commonNames.includes(g.name));
}
