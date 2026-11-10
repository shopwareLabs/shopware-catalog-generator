import { describe, expect, test } from "bun:test";

import type { HydratedBlueprint, ProductProperty } from "../../../src/types/index.js";

import {
    applyColorSystem,
    collectShadeNames,
    isFamilyGroupName,
    isShadeGroupName,
    normalizeProductColors,
} from "../../../src/blueprint/index.js";
import {
    COLOR_FAMILY_GROUP_ID,
    COLOR_FAMILY_GROUP_NAME,
    colorFamilyOptionId,
} from "../../../src/fixtures/index.js";
import { createTestBlueprint, createTestProduct } from "../../helpers/blueprint-factory.js";

function blueprintWith(
    products: Array<{ id: string; properties: ProductProperty[]; variantColors?: string[] }>
): HydratedBlueprint {
    return createTestBlueprint({
        products: products.map((p) =>
            createTestProduct({
                id: p.id,
                metadata: {
                    properties: p.properties,
                    ...(p.variantColors && {
                        isVariant: true,
                        variantConfigs: [
                            {
                                group: "Colour",
                                selectedOptions: p.variantColors,
                                priceModifiers: Object.fromEntries(
                                    p.variantColors.map((c) => [c, 1])
                                ),
                            },
                        ],
                    }),
                },
            })
        ),
    });
}

function familyValues(blueprint: HydratedBlueprint, productId: string): string[] {
    const product = blueprint.products.find((p) => p.id === productId);
    return (product?.metadata.properties ?? [])
        .filter((p) => p.group === COLOR_FAMILY_GROUP_NAME)
        .map((p) => p.value);
}

describe("group name helpers", () => {
    test("shade group spellings", () => {
        expect(isShadeGroupName(" Colour ")).toBe(true);
        expect(isShadeGroupName("colors")).toBe(true);
        expect(isShadeGroupName("Color family")).toBe(false);
        expect(isFamilyGroupName("color FAMILY")).toBe(true);
    });
});

describe("normalizeProductColors", () => {
    test("renames the group, normalises and dedupes values", () => {
        const blueprint = blueprintWith([
            {
                id: "p1",
                properties: [
                    { group: "Colour", value: "grey" },
                    { group: "Color", value: "Gray" },
                    { group: "Size", value: "L" },
                ],
            },
        ]);
        normalizeProductColors(blueprint);
        expect(blueprint.products[0]?.metadata.properties).toEqual([
            { group: "Color", value: "Gray" },
            { group: "Size", value: "L" },
        ]);
    });

    test("normalises variant options and price modifier keys", () => {
        const blueprint = blueprintWith([
            { id: "p1", properties: [], variantColors: ["navy blue", "Navy", "off-white"] },
        ]);
        normalizeProductColors(blueprint);
        const config = blueprint.products[0]?.metadata.variantConfigs?.[0];
        expect(config?.group).toBe("Color");
        expect(config?.selectedOptions).toEqual(["Navy", "Off White"]);
        expect(Object.keys(config?.priceModifiers ?? {})).toEqual(["Navy", "Off White"]);
    });
});

describe("collectShadeNames", () => {
    test("collects unique names from properties and colour variants", () => {
        const blueprint = blueprintWith([
            {
                id: "p1",
                properties: [{ group: "Color", value: "Red" }],
                variantColors: ["red", "Blue"],
            },
        ]);
        expect(collectShadeNames(blueprint)).toEqual(["red", "Blue"]);
    });
});

describe("applyColorSystem", () => {
    test("does nothing for blueprints without colours", () => {
        const blueprint = blueprintWith([
            { id: "p1", properties: [{ group: "Size", value: "L" }] },
        ]);
        applyColorSystem(blueprint);
        expect(blueprint.propertyGroups).toEqual([]);
        expect(blueprint.products[0]?.metadata.properties).toEqual([{ group: "Size", value: "L" }]);
    });

    test("creates the shade group hidden from the filter, with hex and family", () => {
        const blueprint = blueprintWith([
            { id: "p1", properties: [{ group: "Color", value: "navy blue" }] },
        ]);
        applyColorSystem(blueprint);

        const shades = blueprint.propertyGroups.find((g) => g.name === "Color");
        expect(shades).toMatchObject({ displayType: "color", filterable: false });
        expect(shades?.options).toEqual([
            expect.objectContaining({ name: "Navy", colorHexCode: "#1e3a5f", family: "blue" }),
        ]);
    });

    test("adds the filterable family group with stable IDs", () => {
        const blueprint = blueprintWith([
            { id: "p1", properties: [{ group: "Color", value: "Navy" }] },
            { id: "p2", properties: [{ group: "Color", value: "Crimson" }] },
        ]);
        applyColorSystem(blueprint);

        const families = blueprint.propertyGroups.find((g) => g.name === COLOR_FAMILY_GROUP_NAME);
        expect(families).toMatchObject({ id: COLOR_FAMILY_GROUP_ID, filterable: true });
        expect(families?.options.map((o) => [o.id, o.name])).toEqual([
            [colorFamilyOptionId("red"), "Red"],
            [colorFamilyOptionId("blue"), "Blue"],
        ]);
    });

    test("assigns families from properties and colour variants", () => {
        const blueprint = blueprintWith([
            {
                id: "p1",
                properties: [{ group: "Color", value: "Navy" }],
                variantColors: ["Black", "Crimson"],
            },
        ]);
        applyColorSystem(blueprint);
        expect(familyValues(blueprint, "p1")).toEqual(["Black", "Red", "Blue"]);
    });

    test("uses learned shades, else the estimate", () => {
        const blueprint = blueprintWith([
            { id: "p1", properties: [{ group: "Color", value: "Dusty Rose" }] },
            { id: "p2", properties: [{ group: "Color", value: "Xyzzy" }] },
        ]);
        applyColorSystem(blueprint, {
            "dusty rose": { name: "Dusty Rose", hex: "#c48b8b", family: "pink" },
        });
        const options = blueprint.propertyGroups.find((g) => g.name === "Color")?.options ?? [];
        expect(options.find((o) => o.name === "Dusty Rose")).toMatchObject({
            colorHexCode: "#c48b8b",
            family: "pink",
        });
        expect(options.find((o) => o.name === "Xyzzy")).toMatchObject({ family: "gray" });
    });

    test("keeps an existing hex for unknown names and derives the family from it", () => {
        const blueprint = blueprintWith([
            { id: "p1", properties: [{ group: "Color", value: "Moss" }] },
        ]);
        blueprint.propertyGroups.push({
            id: "shade-group",
            name: "Colour",
            displayType: "text",
            options: [{ id: "moss", name: "Moss", colorHexCode: "#4a6b2a" }],
        });
        applyColorSystem(blueprint);
        const group = blueprint.propertyGroups[0];
        expect(group).toMatchObject({ id: "shade-group", name: "Color", displayType: "color" });
        expect(group?.options[0]).toEqual({
            id: "moss",
            name: "Moss",
            colorHexCode: "#4a6b2a",
            family: "green",
        });
    });

    test("image colours get no hex", () => {
        const blueprint = blueprintWith([
            { id: "p1", properties: [{ group: "Color", value: "3 colors" }] },
        ]);
        applyColorSystem(blueprint);
        const option = blueprint.propertyGroups.find((g) => g.name === "Color")?.options[0];
        expect(option).toMatchObject({ name: "Multicolor", family: "multicolor" });
        expect(option?.colorHexCode).toBeUndefined();
    });

    test("is idempotent", () => {
        const blueprint = blueprintWith([
            {
                id: "p1",
                properties: [{ group: "Color", value: "grey" }],
                variantColors: ["Red", "Navy"],
            },
        ]);
        applyColorSystem(blueprint);
        const first = structuredClone(blueprint);
        applyColorSystem(blueprint);
        expect(blueprint).toEqual(first);
        expect(blueprint.propertyGroups.filter((g) => isFamilyGroupName(g.name))).toHaveLength(1);
    });

    test("replaces stale family properties", () => {
        const blueprint = blueprintWith([
            {
                id: "p1",
                properties: [
                    { group: "Color", value: "Red" },
                    { group: COLOR_FAMILY_GROUP_NAME, value: "Green" },
                ],
            },
        ]);
        applyColorSystem(blueprint);
        expect(familyValues(blueprint, "p1")).toEqual(["Red"]);
    });
});
