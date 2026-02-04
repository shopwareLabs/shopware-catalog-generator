/**
 * Unit tests for shopware/sync module
 */

import { describe, expect, mock, test } from "bun:test";
import type { DataHydrator } from "../../../src/shopware/index.js";

import {
    buildPropertyMaps,
    syncCategories,
    syncProducts,
    syncPropertyGroups,
    syncPropertyIdsToBlueprint,
} from "../../../src/shopware/sync.js";
import type {
    BlueprintPropertyGroup,
    HydratedBlueprint,
    SalesChannelFull,
} from "../../../src/types/index.js";
import { logger } from "../../../src/utils/index.js";

// Suppress console output during tests
const originalCli = logger.cli.bind(logger);
const mockCli = mock(() => {});

// =============================================================================
// Mock DataHydrator
// =============================================================================

function createMockDataHydrator(): DataHydrator {
    return {
        createCategoryTree: mock(async () => new Map([["Root / Child", "cat-123"]])),
        getExistingCategoryMap: mock(async () => new Map()),
        getExistingPropertyGroups: mock(async () => []),
        hydrateEnvWithPropertyGroups: mock(async () => {}),
        hydrateEnvWithProductsDirect: mock(async () => {}),
    } as unknown as DataHydrator;
}

function createMockSalesChannel(): SalesChannelFull {
    return {
        id: "sc-123",
        name: "test-store",
        navigationCategoryId: "nav-cat-123",
    } as SalesChannelFull;
}

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

describe("syncCategories", () => {
    test("creates categories for new SalesChannel", async () => {
        logger.cli = mockCli;

        const dataHydrator = createMockDataHydrator();
        const salesChannel = createMockSalesChannel();
        const blueprint: HydratedBlueprint = {
            version: "1.0",
            createdAt: "2024-01-01",
            hydratedAt: "2024-01-01",
            salesChannel: { name: "test", description: "Test" },
            categories: [
                {
                    id: "cat-1",
                    name: "Electronics",
                    description: "Electronic products",
                    level: 1,
                    hasImage: false,
                    children: [],
                },
            ],
            products: [],
            propertyGroups: [],
        };

        const result = await syncCategories(dataHydrator, blueprint, salesChannel, true);

        expect(dataHydrator.createCategoryTree).toHaveBeenCalled();
        expect(result.size).toBeGreaterThan(0);

        logger.cli = originalCli;
    });

    test("syncs existing categories for existing SalesChannel", async () => {
        logger.cli = mockCli;

        const dataHydrator = createMockDataHydrator();
        (dataHydrator.getExistingCategoryMap as ReturnType<typeof mock>).mockImplementation(
            async () =>
                new Map([
                    ["Electronics", "existing-cat-id"],
                    ["Electronics > Phones", "existing-phones-id"],
                ])
        );

        const salesChannel = createMockSalesChannel();
        const blueprint: HydratedBlueprint = {
            version: "1.0",
            createdAt: "2024-01-01",
            hydratedAt: "2024-01-01",
            salesChannel: { name: "test", description: "Test" },
            categories: [
                {
                    id: "cat-1",
                    name: "Electronics",
                    description: "Electronic products",
                    level: 1,
                    hasImage: false,
                    children: [
                        {
                            id: "cat-2",
                            name: "Phones",
                            description: "Mobile phones",
                            level: 2,
                            hasImage: false,
                            children: [],
                        },
                    ],
                },
            ],
            products: [
                {
                    id: "prod-1",
                    name: "iPhone",
                    description: "Apple phone",
                    price: 999,
                    stock: 10,
                    primaryCategoryId: "cat-2",
                    categoryIds: ["cat-2"],
                    metadata: {
                        imageCount: 1,
                        imageDescriptions: [],
                        isVariant: false,
                        properties: [],
                        reviewCount: 0,
                        hasSalesPrice: false,
                    },
                },
            ],
            propertyGroups: [],
        };

        await syncCategories(dataHydrator, blueprint, salesChannel, false);

        // Should update category IDs to match existing
        expect(blueprint.categories[0]?.id).toBe("existing-cat-id");
        expect(blueprint.categories[0]?.children[0]?.id).toBe("existing-phones-id");

        // Should update product category references
        expect(blueprint.products[0]?.primaryCategoryId).toBe("existing-phones-id");
        expect(blueprint.products[0]?.categoryIds).toContain("existing-phones-id");

        logger.cli = originalCli;
    });
});

describe("syncPropertyGroups", () => {
    test("creates new property groups", async () => {
        logger.cli = mockCli;

        const dataHydrator = createMockDataHydrator();
        const blueprint: HydratedBlueprint = {
            version: "1.0",
            createdAt: "2024-01-01",
            hydratedAt: "2024-01-01",
            salesChannel: { name: "test", description: "Test" },
            categories: [],
            products: [],
            propertyGroups: [
                {
                    id: "pg-color",
                    name: "Color",
                    displayType: "color",
                    options: [{ id: "opt-red", name: "Red", colorHexCode: "#FF0000" }],
                },
            ],
        };

        await syncPropertyGroups(dataHydrator, blueprint);

        expect(dataHydrator.hydrateEnvWithPropertyGroups).toHaveBeenCalled();

        logger.cli = originalCli;
    });

    test("skips existing property groups with no missing options", async () => {
        logger.cli = mockCli;

        const dataHydrator = createMockDataHydrator();
        (dataHydrator.getExistingPropertyGroups as ReturnType<typeof mock>).mockImplementation(
            async () => [
                {
                    id: "existing-pg",
                    name: "Color",
                    displayType: "color",
                    options: [{ id: "existing-opt", name: "Red" }],
                },
            ]
        );

        const blueprint: HydratedBlueprint = {
            version: "1.0",
            createdAt: "2024-01-01",
            hydratedAt: "2024-01-01",
            salesChannel: { name: "test", description: "Test" },
            categories: [],
            products: [],
            propertyGroups: [
                {
                    id: "pg-color",
                    name: "Color",
                    displayType: "color",
                    options: [{ id: "opt-red", name: "Red" }],
                },
            ],
        };

        await syncPropertyGroups(dataHydrator, blueprint);

        // Should update blueprint ID to match existing
        expect(blueprint.propertyGroups[0]?.id).toBe("existing-pg");
        expect(blueprint.propertyGroups[0]?.options[0]?.id).toBe("existing-opt");

        // Should NOT call hydrateEnvWithPropertyGroups (nothing to sync)
        expect(dataHydrator.hydrateEnvWithPropertyGroups).not.toHaveBeenCalled();

        logger.cli = originalCli;
    });

    test("adds missing options to existing property groups", async () => {
        logger.cli = mockCli;

        const dataHydrator = createMockDataHydrator();
        (dataHydrator.getExistingPropertyGroups as ReturnType<typeof mock>).mockImplementation(
            async () => [
                {
                    id: "existing-pg",
                    name: "Color",
                    displayType: "color",
                    options: [{ id: "existing-red", name: "Red" }],
                },
            ]
        );

        const blueprint: HydratedBlueprint = {
            version: "1.0",
            createdAt: "2024-01-01",
            hydratedAt: "2024-01-01",
            salesChannel: { name: "test", description: "Test" },
            categories: [],
            products: [],
            propertyGroups: [
                {
                    id: "pg-color",
                    name: "Color",
                    displayType: "color",
                    options: [
                        { id: "opt-red", name: "Red" },
                        { id: "opt-blue", name: "Blue" }, // New option
                    ],
                },
            ],
        };

        await syncPropertyGroups(dataHydrator, blueprint);

        // Should call hydrateEnvWithPropertyGroups with missing options
        expect(dataHydrator.hydrateEnvWithPropertyGroups).toHaveBeenCalled();

        logger.cli = originalCli;
    });
});

describe("syncProducts", () => {
    test("syncs products to Shopware", async () => {
        logger.cli = mockCli;

        const dataHydrator = createMockDataHydrator();
        const salesChannel = createMockSalesChannel();
        const blueprint: HydratedBlueprint = {
            version: "1.0",
            createdAt: "2024-01-01",
            hydratedAt: "2024-01-01",
            salesChannel: { name: "test", description: "Test" },
            categories: [
                {
                    id: "cat-1",
                    name: "Electronics",
                    description: "Electronics",
                    level: 1,
                    hasImage: false,
                    children: [],
                },
            ],
            products: [
                {
                    id: "prod-1",
                    name: "Test Product",
                    description: "A test product",
                    price: 99.99,
                    stock: 10,
                    primaryCategoryId: "cat-1",
                    categoryIds: ["cat-1"],
                    metadata: {
                        imageCount: 1,
                        imageDescriptions: [],
                        isVariant: false,
                        properties: [{ group: "Color", value: "Red" }],
                        reviewCount: 0,
                        hasSalesPrice: false,
                    },
                },
            ],
            propertyGroups: [
                {
                    id: "pg-color",
                    name: "Color",
                    displayType: "color",
                    options: [{ id: "opt-red", name: "Red" }],
                },
            ],
        };

        const categoryIdMap = new Map([["Electronics", "sw-cat-123"]]);
        const propertyOptionMap = new Map([["color::red", { id: "opt-red", name: "Red" }]]);

        await syncProducts(
            dataHydrator,
            blueprint,
            salesChannel,
            categoryIdMap,
            propertyOptionMap
        );

        expect(dataHydrator.hydrateEnvWithProductsDirect).toHaveBeenCalled();

        logger.cli = originalCli;
    });

    test("resolves category IDs via paths", async () => {
        logger.cli = mockCli;

        const dataHydrator = createMockDataHydrator();
        const salesChannel = createMockSalesChannel();
        const blueprint: HydratedBlueprint = {
            version: "1.0",
            createdAt: "2024-01-01",
            hydratedAt: "2024-01-01",
            salesChannel: { name: "test", description: "Test" },
            categories: [
                {
                    id: "cat-electronics",
                    name: "Electronics",
                    description: "Electronics",
                    level: 1,
                    hasImage: false,
                    children: [
                        {
                            id: "cat-phones",
                            name: "Phones",
                            description: "Phones",
                            level: 2,
                            hasImage: false,
                            children: [],
                        },
                    ],
                },
            ],
            products: [
                {
                    id: "prod-1",
                    name: "iPhone",
                    description: "Apple phone",
                    price: 999,
                    stock: 5,
                    primaryCategoryId: "cat-phones",
                    categoryIds: ["cat-phones"],
                    metadata: {
                        imageCount: 1,
                        imageDescriptions: [],
                        isVariant: false,
                        properties: [],
                        reviewCount: 0,
                        hasSalesPrice: false,
                    },
                },
            ],
            propertyGroups: [],
        };

        const categoryIdMap = new Map([
            ["Electronics", "sw-electronics"],
            ["Electronics > Phones", "sw-phones"],
        ]);

        await syncProducts(dataHydrator, blueprint, salesChannel, categoryIdMap, new Map());

        // Verify the product was synced with correct arguments
        expect(dataHydrator.hydrateEnvWithProductsDirect).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({
                    id: "prod-1",
                    name: "iPhone",
                    categoryIds: ["sw-phones"],
                }),
            ]),
            salesChannel.id,
            salesChannel.navigationCategoryId
        );

        logger.cli = originalCli;
    });

    test("handles products without properties", async () => {
        logger.cli = mockCli;

        const dataHydrator = createMockDataHydrator();
        const salesChannel = createMockSalesChannel();
        const blueprint: HydratedBlueprint = {
            version: "1.0",
            createdAt: "2024-01-01",
            hydratedAt: "2024-01-01",
            salesChannel: { name: "test", description: "Test" },
            categories: [],
            products: [
                {
                    id: "prod-1",
                    name: "Simple Product",
                    description: "No properties",
                    price: 49.99,
                    stock: 20,
                    primaryCategoryId: "cat-1",
                    categoryIds: ["cat-1"],
                    metadata: {
                        imageCount: 1,
                        imageDescriptions: [],
                        isVariant: false,
                        properties: [],
                        reviewCount: 0,
                        hasSalesPrice: false,
                    },
                },
            ],
            propertyGroups: [],
        };

        await syncProducts(dataHydrator, blueprint, salesChannel, new Map(), new Map());

        expect(dataHydrator.hydrateEnvWithProductsDirect).toHaveBeenCalled();

        logger.cli = originalCli;
    });
});
