import { describe, expect, test } from "bun:test";

import type { BlueprintPropertyGroup, HydratedBlueprint } from "../../../src/types/index.js";

import {
    mergeSynonymPropertyGroups,
    propertyGroupKey,
    singleOptionGroupNames,
} from "../../../src/blueprint/index.js";
import { createTestBlueprint, createTestProduct } from "../../helpers/blueprint-factory.js";

function group(name: string, options: string[]): BlueprintPropertyGroup {
    return {
        id: `g-${name}`,
        name,
        displayType: "text",
        options: options.map((o) => ({ id: `o-${name}-${o}`, name: o })),
    };
}

function product(id: string, properties: Array<[string, string]>) {
    return createTestProduct({
        id,
        metadata: { properties: properties.map(([g, value]) => ({ group: g, value })) },
    });
}

function blueprintWith(
    products: ReturnType<typeof product>[],
    groups: BlueprintPropertyGroup[]
): HydratedBlueprint {
    return { ...createTestBlueprint(), products, propertyGroups: groups };
}

describe("propertyGroupKey", () => {
    test("matches plural, Count and Type forms", () => {
        expect(propertyGroupKey("Outlets")).toBe("outlet");
        expect(propertyGroupKey("Outlet Count")).toBe("outlet");
        expect(propertyGroupKey("Varieties")).toBe("variety");
        expect(propertyGroupKey("Connector Type")).toBe("connector");
        expect(propertyGroupKey("Type")).toBe("type");
        expect(propertyGroupKey("Glass")).toBe("glass");
    });
});

describe("mergeSynonymPropertyGroups", () => {
    test("merges into the name most products use and unions the options", () => {
        const bp = blueprintWith(
            [
                product("a", [["Outlets", "2"]]),
                product("b", [["Outlets", "3"]]),
                product("c", [["Outlet Count", "4"]]),
            ],
            [group("Outlets", ["2", "3"]), group("Outlet Count", ["4", "3"])]
        );

        const merges = mergeSynonymPropertyGroups(bp);

        expect(merges).toEqual([{ from: "Outlet Count", to: "Outlets" }]);
        expect(bp.propertyGroups.map((g) => g.name)).toEqual(["Outlets"]);
        expect(bp.propertyGroups[0]?.options.map((o) => o.name)).toEqual(["2", "3", "4"]);
        expect(bp.products[2]?.metadata.properties).toEqual([{ group: "Outlets", value: "4" }]);
    });

    test("keeps the first value when a product had both names", () => {
        const bp = blueprintWith(
            [
                product("a", [
                    ["Feature", "Waterproof"],
                    ["Features", "Foldable"],
                ]),
                product("b", [["Feature", "Light"]]),
            ],
            [group("Feature", ["Waterproof", "Light"]), group("Features", ["Foldable"])]
        );

        mergeSynonymPropertyGroups(bp);

        expect(bp.products[0]?.metadata.properties).toEqual([
            { group: "Feature", value: "Waterproof" },
        ]);
    });

    test("never renames colour or variant groups and leaves unrelated groups alone", () => {
        const variantParent = createTestProduct({
            id: "v",
            metadata: {
                isVariant: true,
                variantConfigs: [
                    { group: "Sizes", selectedOptions: ["S", "M"], priceModifiers: {} },
                ],
                properties: [{ group: "Sizes", value: "S" }],
            },
        });
        const bp = blueprintWith(
            [
                variantParent,
                product("a", [["Size", "L"]]),
                product("b", [["Size", "M"]]),
                product("c", [["Material", "Wood"]]),
            ],
            [group("Sizes", ["S"]), group("Size", ["L", "M"]), group("Material", ["Wood"])]
        );

        expect(mergeSynonymPropertyGroups(bp)).toEqual([]);
        expect(bp.propertyGroups).toHaveLength(3);
    });
});

describe("singleOptionGroupNames", () => {
    test("lists groups whose products all use the same option", () => {
        const bp = blueprintWith(
            [
                product("a", [
                    ["Use", "Daily"],
                    ["Material", "Wood"],
                ]),
                product("b", [
                    ["Use", "daily"],
                    ["Material", "Metal"],
                ]),
            ],
            []
        );

        expect([...singleOptionGroupNames(bp)]).toEqual(["use"]);
    });
});
