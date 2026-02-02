/**
 * Unit tests for shopware/sync module
 */

import { describe, expect, test } from "bun:test";

import type { BlueprintPropertyGroup, HydratedBlueprint } from "../../../src/types/index.js";

import { buildPropertyMaps, syncPropertyIdsToBlueprint } from "../../../src/shopware/sync.js";

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockBlueprint(
    propertyGroups: BlueprintPropertyGroup[],
    products: Array<{
        id: string;
        properties: Array<{ group: string; value: string }>;
    }>
): HydratedBlueprint {
    return {
        version: "1.0",
        createdAt: "2024-01-01T00:00:00Z",
        hydratedAt: "2024-01-01T00:00:00Z",
        salesChannel: {
            name: "test",
            description: "Test store",
        },
        categories: [],
        products: products.map((p) => ({
            id: p.id,
            name: `Product ${p.id}`,
            description: "Test product",
            price: 99.99,
            stock: 10,
            primaryCategoryId: "cat-1",
            categoryIds: ["cat-1"],
            metadata: {
                imageCount: 1,
                imageDescriptions: [],
                isVariant: false,
                properties: p.properties.map((prop) => ({
                    group: prop.group,
                    value: prop.value,
                })),
                reviewCount: 0,
                hasSalesPrice: false,
            },
        })),
        propertyGroups,
    };
}

// =============================================================================
// Tests
// =============================================================================

describe("buildPropertyMaps", () => {
    test("builds correct maps from blueprint property groups", () => {
        const blueprint = createMockBlueprint(
            [
                {
                    id: "pg-color",
                    name: "Color",
                    displayType: "color",
                    options: [
                        { id: "opt-red", name: "Red", colorHexCode: "#FF0000" },
                        { id: "opt-blue", name: "Blue", colorHexCode: "#0000FF" },
                    ],
                },
                {
                    id: "pg-size",
                    name: "Size",
                    displayType: "text",
                    options: [
                        { id: "opt-s", name: "Small" },
                        { id: "opt-m", name: "Medium" },
                        { id: "opt-l", name: "Large" },
                    ],
                },
            ],
            []
        );

        const maps = buildPropertyMaps(blueprint);

        // Check groupIdMap
        expect(maps.groupIdMap.get("color")).toBe("pg-color");
        expect(maps.groupIdMap.get("size")).toBe("pg-size");
        expect(maps.groupIdMap.size).toBe(2);

        // Check optionIdMap
        expect(maps.optionIdMap.get("color::red")).toBe("opt-red");
        expect(maps.optionIdMap.get("color::blue")).toBe("opt-blue");
        expect(maps.optionIdMap.get("size::small")).toBe("opt-s");
        expect(maps.optionIdMap.get("size::medium")).toBe("opt-m");
        expect(maps.optionIdMap.get("size::large")).toBe("opt-l");
        expect(maps.optionIdMap.size).toBe(5);

        // Check propertyOptionMap
        expect(maps.propertyOptionMap.get("color::red")).toEqual({
            id: "opt-red",
            name: "Red",
        });
        expect(maps.propertyOptionMap.get("size::large")).toEqual({
            id: "opt-l",
            name: "Large",
        });
    });

    test("handles empty property groups", () => {
        const blueprint = createMockBlueprint([], []);

        const maps = buildPropertyMaps(blueprint);

        expect(maps.groupIdMap.size).toBe(0);
        expect(maps.optionIdMap.size).toBe(0);
        expect(maps.propertyOptionMap.size).toBe(0);
    });

    test("uses lowercase keys for lookups", () => {
        const blueprint = createMockBlueprint(
            [
                {
                    id: "pg-1",
                    name: "Material",
                    displayType: "text",
                    options: [{ id: "opt-1", name: "Oak Wood" }],
                },
            ],
            []
        );

        const maps = buildPropertyMaps(blueprint);

        // Keys should be lowercase
        expect(maps.groupIdMap.get("material")).toBe("pg-1");
        expect(maps.groupIdMap.get("Material")).toBeUndefined();
        expect(maps.optionIdMap.get("material::oak wood")).toBe("opt-1");
    });
});

describe("syncPropertyIdsToBlueprint", () => {
    test("syncs property IDs to product metadata", () => {
        const blueprint = createMockBlueprint(
            [
                {
                    id: "pg-color",
                    name: "Color",
                    displayType: "color",
                    options: [{ id: "opt-red", name: "Red" }],
                },
                {
                    id: "pg-size",
                    name: "Size",
                    displayType: "text",
                    options: [{ id: "opt-l", name: "Large" }],
                },
            ],
            [
                {
                    id: "prod-1",
                    properties: [
                        { group: "Color", value: "Red" },
                        { group: "Size", value: "Large" },
                    ],
                },
            ]
        );

        const maps = buildPropertyMaps(blueprint);
        syncPropertyIdsToBlueprint(blueprint, maps);

        const product = blueprint.products[0];
        if (!product) throw new Error("Product not found");

        const colorProp = product.metadata.properties.find((p) => p.group === "Color");
        const sizeProp = product.metadata.properties.find((p) => p.group === "Size");

        expect(colorProp?.groupId).toBe("pg-color");
        expect(colorProp?.optionId).toBe("opt-red");
        expect(sizeProp?.groupId).toBe("pg-size");
        expect(sizeProp?.optionId).toBe("opt-l");
    });

    test("handles missing property groups gracefully", () => {
        const blueprint = createMockBlueprint(
            [
                {
                    id: "pg-color",
                    name: "Color",
                    displayType: "color",
                    options: [{ id: "opt-red", name: "Red" }],
                },
            ],
            [
                {
                    id: "prod-1",
                    properties: [
                        { group: "Color", value: "Red" },
                        { group: "Unknown", value: "Value" }, // Group doesn't exist
                    ],
                },
            ]
        );

        const maps = buildPropertyMaps(blueprint);
        syncPropertyIdsToBlueprint(blueprint, maps);

        const product = blueprint.products[0];
        if (!product) throw new Error("Product not found");

        const colorProp = product.metadata.properties.find((p) => p.group === "Color");
        const unknownProp = product.metadata.properties.find((p) => p.group === "Unknown");

        expect(colorProp?.groupId).toBe("pg-color");
        expect(colorProp?.optionId).toBe("opt-red");
        expect(unknownProp?.groupId).toBeUndefined();
        expect(unknownProp?.optionId).toBeUndefined();
    });

    test("handles case insensitive matching", () => {
        const blueprint = createMockBlueprint(
            [
                {
                    id: "pg-1",
                    name: "COLOR",
                    displayType: "color",
                    options: [{ id: "opt-1", name: "RED" }],
                },
            ],
            [
                {
                    id: "prod-1",
                    properties: [{ group: "color", value: "red" }],
                },
            ]
        );

        const maps = buildPropertyMaps(blueprint);
        syncPropertyIdsToBlueprint(blueprint, maps);

        const product = blueprint.products[0];
        if (!product) throw new Error("Product not found");

        const prop = product.metadata.properties[0];
        expect(prop?.groupId).toBe("pg-1");
        expect(prop?.optionId).toBe("opt-1");
    });
});
