/**
 * Unit tests for shopware/sync module
 */

import { describe, expect, mock, test } from "bun:test";

import type { DataHydrator } from "../../../src/shopware/index.js";
import type {
    BlueprintPropertyGroup,
    HydratedBlueprint,
    PropertyGroup,
    SalesChannelFull,
} from "../../../src/types/index.js";

import {
    buildPropertyMaps,
    syncCategories,
    syncProducts,
    syncPropertyGroups,
    syncPropertyIdsToBlueprint,
} from "../../../src/shopware/sync.js";
import { ShopwareCapabilities } from "../../../src/shopware/version.js";
import { logger } from "../../../src/utils/index.js";
import { createTestBlueprint, createTestProduct } from "../../helpers/blueprint-factory.js";

const SHOPWARE_67 = ShopwareCapabilities.fromVersion("6.7.16.0");

// Suppress console output during tests

// =============================================================================
// Mock DataHydrator
// =============================================================================

function createMockDataHydrator(): DataHydrator {
    return {
        createCategoryTree: mock(async () => new Map([["Root / Child", "cat-123"]])),
        getExistingCategoryMap: mock(async () => new Map()),
        getExistingPropertyGroups: mock(async () => []),
        hydrateEnvWithPropertyGroups: mock(async () => {}),
        hydrateEnvWithProductsDirect: mock(async (products: unknown[]) => products.length),
        ensureProductCustomFieldSet: mock(async () => "set-1"),
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
                hasTieredPricing: false,
                isTopseller: false,
                isNew: false,
                isShippingFree: false,
                weight: 1.0,
                width: 100,
                height: 100,
                length: 100,
                ean: "1234567890128",
                manufacturerNumber: "MPN-TEST0001",
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
        logger.setMcpMode(true);

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

        logger.setMcpMode(false);
    });

    test("syncs existing categories for existing SalesChannel", async () => {
        logger.setMcpMode(true);

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
                        hasTieredPricing: false,
                        isTopseller: false,
                        isNew: false,
                        isShippingFree: false,
                        weight: 1.0,
                        width: 100,
                        height: 100,
                        length: 100,
                        ean: "1234567890128",
                        manufacturerNumber: "MPN-TEST0001",
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

        logger.setMcpMode(false);
    });
});

describe("syncPropertyGroups", () => {
    test("creates new property groups", async () => {
        logger.setMcpMode(true);

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

        logger.setMcpMode(false);
    });

    test("skips existing property groups with no missing options", async () => {
        logger.setMcpMode(true);

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

        logger.setMcpMode(false);
    });

    test("adds missing options to existing property groups", async () => {
        logger.setMcpMode(true);

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

        logger.setMcpMode(false);
    });

    describe("filterable", () => {
        const blueprintWithShades = (): HydratedBlueprint => ({
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
                    filterable: false,
                    options: [{ id: "opt-red", name: "Red" }],
                },
            ],
        });

        const mockExisting = (dataHydrator: DataHydrator, filterable: boolean): void => {
            (dataHydrator.getExistingPropertyGroups as ReturnType<typeof mock>).mockImplementation(
                async () => [
                    {
                        id: "existing-pg",
                        name: "Color",
                        displayType: "color",
                        filterable,
                        options: [{ id: "existing-red", name: "Red" }],
                    },
                ]
            );
        };

        const syncedGroups = (dataHydrator: DataHydrator): PropertyGroup[] => {
            const calls = (dataHydrator.hydrateEnvWithPropertyGroups as ReturnType<typeof mock>)
                .mock.calls;
            return calls[0]?.[0] ?? [];
        };

        test("sends filterable for new groups", async () => {
            logger.setMcpMode(true);
            const dataHydrator = createMockDataHydrator();

            await syncPropertyGroups(dataHydrator, blueprintWithShades());

            expect(syncedGroups(dataHydrator)[0]?.filterable).toBe(false);
            logger.setMcpMode(false);
        });

        test("updates an existing group when filterable differs", async () => {
            logger.setMcpMode(true);
            const dataHydrator = createMockDataHydrator();
            mockExisting(dataHydrator, true);

            await syncPropertyGroups(dataHydrator, blueprintWithShades());

            expect(syncedGroups(dataHydrator)[0]).toMatchObject({
                id: "existing-pg",
                filterable: false,
                options: [],
            });
            logger.setMcpMode(false);
        });

        test("skips an existing group when filterable already matches", async () => {
            logger.setMcpMode(true);
            const dataHydrator = createMockDataHydrator();
            mockExisting(dataHydrator, false);

            await syncPropertyGroups(dataHydrator, blueprintWithShades());

            expect(dataHydrator.hydrateEnvWithPropertyGroups).not.toHaveBeenCalled();
            logger.setMcpMode(false);
        });
    });
});

describe("syncProducts", () => {
    test("syncs products to Shopware", async () => {
        logger.setMcpMode(true);

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
                        hasTieredPricing: false,
                        isTopseller: false,
                        isNew: false,
                        isShippingFree: false,
                        weight: 1.0,
                        width: 100,
                        height: 100,
                        length: 100,
                        ean: "1234567890128",
                        manufacturerNumber: "MPN-TEST0001",
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
            propertyOptionMap,
            SHOPWARE_67
        );

        expect(dataHydrator.hydrateEnvWithProductsDirect).toHaveBeenCalled();

        logger.setMcpMode(false);
    });

    test("resolves category IDs via paths", async () => {
        logger.setMcpMode(true);

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
                        hasTieredPricing: false,
                        isTopseller: false,
                        isNew: false,
                        isShippingFree: false,
                        weight: 1.0,
                        width: 100,
                        height: 100,
                        length: 100,
                        ean: "1234567890128",
                        manufacturerNumber: "MPN-TEST0001",
                    },
                },
            ],
            propertyGroups: [],
        };

        const categoryIdMap = new Map([
            ["Electronics", "sw-electronics"],
            ["Electronics > Phones", "sw-phones"],
        ]);

        await syncProducts(
            dataHydrator,
            blueprint,
            salesChannel,
            categoryIdMap,
            new Map(),
            SHOPWARE_67
        );

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

        logger.setMcpMode(false);
    });

    test("passes sale price data to hydrator", async () => {
        logger.setMcpMode(true);

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
                    id: "prod-sale",
                    name: "Sale Product",
                    description: "On sale",
                    price: 79.99,
                    stock: 10,
                    primaryCategoryId: "cat-1",
                    categoryIds: ["cat-1"],
                    metadata: {
                        imageCount: 1,
                        imageDescriptions: [],
                        isVariant: false,
                        properties: [],
                        reviewCount: 0,
                        hasSalesPrice: true,
                        salePercentage: 0.2,
                        hasTieredPricing: false,
                        isTopseller: false,
                        isNew: false,
                        isShippingFree: false,
                        weight: 1.5,
                        width: 200,
                        height: 150,
                        length: 300,
                        ean: "4006381333931",
                        manufacturerNumber: "MPN-SALE001",
                    },
                },
            ],
            propertyGroups: [],
        };

        await syncProducts(
            dataHydrator,
            blueprint,
            salesChannel,
            new Map(),
            new Map(),
            SHOPWARE_67
        );

        expect(dataHydrator.hydrateEnvWithProductsDirect).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({
                    id: "prod-sale",
                    hasSalesPrice: true,
                    salePercentage: 0.2,
                    hasTieredPricing: false,
                }),
            ]),
            salesChannel.id,
            salesChannel.navigationCategoryId
        );

        logger.setMcpMode(false);
    });

    test("passes storefront flags and physical attributes to hydrator", async () => {
        logger.setMcpMode(true);

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
                    id: "prod-flags",
                    name: "Featured Product",
                    description: "A featured item",
                    price: 149.99,
                    stock: 5,
                    primaryCategoryId: "cat-1",
                    categoryIds: ["cat-1"],
                    metaTitle: "Featured Product",
                    metaDescription: "A featured item",
                    metadata: {
                        imageCount: 1,
                        imageDescriptions: [],
                        isVariant: false,
                        properties: [],
                        reviewCount: 0,
                        hasSalesPrice: false,
                        hasTieredPricing: false,
                        isTopseller: true,
                        isNew: true,
                        isShippingFree: true,
                        weight: 3.5,
                        width: 400,
                        height: 250,
                        length: 600,
                        ean: "5901234123457",
                        manufacturerNumber: "MPN-FEAT001",
                        minPurchase: 2,
                        purchaseSteps: 2,
                        maxPurchase: 10,
                    },
                },
            ],
            propertyGroups: [],
        };

        await syncProducts(
            dataHydrator,
            blueprint,
            salesChannel,
            new Map(),
            new Map(),
            SHOPWARE_67
        );

        expect(dataHydrator.hydrateEnvWithProductsDirect).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({
                    id: "prod-flags",
                    isTopseller: true,
                    isNew: true,
                    isShippingFree: true,
                    weight: 3.5,
                    width: 400,
                    height: 250,
                    length: 600,
                    ean: "5901234123457",
                    manufacturerNumber: "MPN-FEAT001",
                    minPurchase: 2,
                    purchaseSteps: 2,
                    maxPurchase: 10,
                    metaTitle: "Featured Product",
                    metaDescription: "A featured item",
                }),
            ]),
            salesChannel.id,
            salesChannel.navigationCategoryId
        );

        logger.setMcpMode(false);
    });

    test("handles products without properties", async () => {
        logger.setMcpMode(true);

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
                        hasTieredPricing: false,
                        isTopseller: false,
                        isNew: false,
                        isShippingFree: false,
                        weight: 1.0,
                        width: 100,
                        height: 100,
                        length: 100,
                        ean: "1234567890128",
                        manufacturerNumber: "MPN-TEST0001",
                    },
                },
            ],
            propertyGroups: [],
        };

        await syncProducts(
            dataHydrator,
            blueprint,
            salesChannel,
            new Map(),
            new Map(),
            SHOPWARE_67
        );

        expect(dataHydrator.hydrateEnvWithProductsDirect).toHaveBeenCalled();

        logger.setMcpMode(false);
    });
});

describe("syncProducts — product type", () => {
    const categoryIdMap = new Map<string, string>();

    function syncedTypes(dataHydrator: DataHydrator): Array<string | undefined> {
        const mockFn = dataHydrator.hydrateEnvWithProductsDirect as ReturnType<typeof mock>;
        const products = mockFn.mock.calls[0]?.[0] as Array<{ type?: string }>;
        return products.map((p) => p.type);
    }

    test("sends the blueprint type and defaults missing types to physical", async () => {
        const dataHydrator = createMockDataHydrator();
        const blueprint = createTestBlueprint({
            products: [
                createTestProduct({ id: "p-digital", type: "digital" }),
                createTestProduct({ id: "p-legacy", type: undefined }),
            ],
        });

        await syncProducts(
            dataHydrator,
            blueprint,
            createMockSalesChannel(),
            categoryIdMap,
            new Map(),
            SHOPWARE_67
        );

        expect(syncedTypes(dataHydrator)).toEqual(["digital", "physical"]);
    });

    test("leaves the type out for shops older than 6.7.7", async () => {
        const dataHydrator = createMockDataHydrator();
        const blueprint = createTestBlueprint({
            products: [createTestProduct({ type: "physical" })],
        });

        await syncProducts(
            dataHydrator,
            blueprint,
            createMockSalesChannel(),
            categoryIdMap,
            new Map(),
            ShopwareCapabilities.fromVersion("6.7.6.2")
        );

        expect(syncedTypes(dataHydrator)).toEqual([undefined]);
    });
});

describe("syncProducts — version-gated product fields", () => {
    const categoryIdMap = new Map<string, string>();
    const customFields = { cg_featured: true, cg_launch_year: 2024, cg_internal_note: "Batch A" };

    function createProduct(): ReturnType<typeof createTestProduct> {
        const product = createTestProduct({
            name: "Desk Lamp",
            description: "<p>Bright light. Two settings.</p>",
            metaTitle: "Desk Lamp | Store",
            metaDescription: "Bright desk lamp",
        });
        product.metadata.customFields = customFields;
        product.metadata.packaging = {
            unitShortCode: "pc",
            unitName: "Piece",
            purchaseUnit: 2,
            referenceUnit: 1,
            packUnit: "Pair",
            packUnitPlural: "Pairs",
        };
        return product;
    }

    async function syncOne(
        version: string,
        dataHydrator: DataHydrator = createMockDataHydrator()
    ): Promise<Record<string, unknown>> {
        await syncProducts(
            dataHydrator,
            createTestBlueprint({ products: [createProduct()] }),
            createMockSalesChannel(),
            categoryIdMap,
            new Map(),
            ShopwareCapabilities.fromVersion(version)
        );
        const mockFn = dataHydrator.hydrateEnvWithProductsDirect as ReturnType<typeof mock>;
        const products = mockFn.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
        return products[0] ?? {};
    }

    test("sends Open Graph fields on 6.7.10+", async () => {
        const product = await syncOne("6.7.10.0");

        expect(product.ogTitle).toBe("Desk Lamp | Store");
        expect(product.ogDescription).toBe("Bright desk lamp");
    });

    test("never sends descriptionTeaser (Shopware derives it and rejects writes)", async () => {
        const product = await syncOne("6.7.16.0");

        expect(Object.keys(product)).not.toContain("descriptionTeaser");
    });

    test("leaves Open Graph fields out before 6.7.10", async () => {
        const product = await syncOne("6.6.10.0");

        expect(product.ogTitle).toBeUndefined();
        expect(product.ogDescription).toBeUndefined();
    });

    test("always sends packaging and custom fields (supported since 6.0)", async () => {
        const product = await syncOne("6.6.10.0");

        expect(product.customFields).toEqual(customFields);
        expect(product.packaging).toMatchObject({ unitShortCode: "pc", purchaseUnit: 2 });
    });

    test("creates the custom field set with includeInSearch only on 6.7.7+", async () => {
        const modern = createMockDataHydrator();
        const legacy = createMockDataHydrator();

        await syncOne("6.7.7.0", modern);
        await syncOne("6.7.6.0", legacy);

        const call = (h: DataHydrator): unknown =>
            (h.ensureProductCustomFieldSet as ReturnType<typeof mock>).mock.calls[0]?.[0];
        expect(call(modern)).toBe(true);
        expect(call(legacy)).toBe(false);
    });

    test("uploads products without custom fields when the set cannot be created", async () => {
        const dataHydrator = createMockDataHydrator();
        dataHydrator.ensureProductCustomFieldSet = mock(async () => {
            throw new Error("forbidden");
        });
        logger.setMcpMode(true);

        const product = await syncOne("6.7.16.0", dataHydrator);

        logger.setMcpMode(false);
        expect(product.customFields).toBeUndefined();
    });
});

describe("syncProducts — upload result", () => {
    test("reports every product as synced when Shopware accepts all batches", async () => {
        const dataHydrator = createMockDataHydrator();
        const blueprint = createTestBlueprint({
            products: [createTestProduct({ id: "p-1" }), createTestProduct({ id: "p-2" })],
        });

        const result = await syncProducts(
            dataHydrator,
            blueprint,
            createMockSalesChannel(),
            new Map(),
            new Map(),
            SHOPWARE_67
        );

        expect(result).toEqual({ synced: 2, failed: 0 });
    });

    test("reports products from rejected batches as failed", async () => {
        const dataHydrator = createMockDataHydrator();
        (dataHydrator.hydrateEnvWithProductsDirect as ReturnType<typeof mock>).mockImplementation(
            async () => 1
        );
        const blueprint = createTestBlueprint({
            products: [
                createTestProduct({ id: "p-1" }),
                createTestProduct({ id: "p-2" }),
                createTestProduct({ id: "p-3" }),
            ],
        });

        const result = await syncProducts(
            dataHydrator,
            blueprint,
            createMockSalesChannel(),
            new Map(),
            new Map(),
            SHOPWARE_67
        );

        expect(result).toEqual({ synced: 1, failed: 2 });
    });
});

describe("syncPropertyGroups — sync payload", () => {
    type ExistingGroup = {
        id: string;
        name: string;
        displayType: string;
        filterable?: boolean;
        options: Array<{ id: string; name: string; colorHexCode?: string }>;
    };

    const blueprintWith = (propertyGroups: BlueprintPropertyGroup[]): HydratedBlueprint => ({
        version: "1.0",
        createdAt: "2024-01-01",
        hydratedAt: "2024-01-01",
        salesChannel: { name: "test", description: "Test" },
        categories: [],
        products: [],
        propertyGroups,
    });

    async function runSync(
        existing: ExistingGroup[],
        blueprint: HydratedBlueprint
    ): Promise<PropertyGroup[] | undefined> {
        logger.setMcpMode(true);
        const dataHydrator = createMockDataHydrator();
        (dataHydrator.getExistingPropertyGroups as ReturnType<typeof mock>).mockImplementation(
            async () => existing
        );
        await syncPropertyGroups(dataHydrator, blueprint);
        logger.setMcpMode(false);
        const calls = (dataHydrator.hydrateEnvWithPropertyGroups as ReturnType<typeof mock>).mock
            .calls;
        expect(calls.length).toBeLessThanOrEqual(1);
        return calls[0]?.[0];
    }

    test("creates a new non-colour group with blueprint IDs and without hex codes", async () => {
        const synced = await runSync(
            [],
            blueprintWith([
                {
                    id: "pg-size",
                    name: "Size",
                    displayType: "text",
                    options: [{ id: "opt-s", name: "S", colorHexCode: "#000000" }],
                },
            ])
        );

        expect(synced).toEqual([
            {
                id: "pg-size",
                name: "Size",
                description: "Properties for Size",
                displayType: "text",
                filterable: undefined,
                options: [{ id: "opt-s", name: "S", colorHexCode: undefined }],
            },
        ]);
    });

    test("keeps hex codes for a new colour group", async () => {
        const synced = await runSync(
            [],
            blueprintWith([
                {
                    id: "pg-color",
                    name: "Color",
                    displayType: "color",
                    options: [{ id: "opt-red", name: "Red", colorHexCode: "#FF0000" }],
                },
            ])
        );

        expect(synced?.[0]?.options).toEqual([
            { id: "opt-red", name: "Red", colorHexCode: "#FF0000" },
        ]);
    });

    test("matches existing groups and options case-insensitively", async () => {
        const blueprint = blueprintWith([
            {
                id: "pg-size",
                name: "size",
                displayType: "text",
                options: [
                    { id: "opt-s", name: "s" },
                    { id: "opt-m", name: "M" },
                ],
            },
        ]);

        const synced = await runSync(
            [
                {
                    id: "sw-size",
                    name: "Size",
                    displayType: "text",
                    options: [{ id: "sw-s", name: "S" }],
                },
            ],
            blueprint
        );

        expect(blueprint.propertyGroups[0]?.id).toBe("sw-size");
        expect(blueprint.propertyGroups[0]?.options.map((o) => o.id)).toEqual(["sw-s", "opt-m"]);
        expect(synced).toEqual([
            {
                id: "sw-size",
                name: "Size",
                description: "Properties for Size",
                displayType: "text",
                filterable: undefined,
                options: [{ id: "opt-m", name: "M", colorHexCode: undefined }],
            },
        ]);
    });

    test("drops hex codes of missing options for an existing non-colour group", async () => {
        const synced = await runSync(
            [{ id: "sw-size", name: "Size", displayType: "select", options: [] }],
            blueprintWith([
                {
                    id: "pg-size",
                    name: "Size",
                    displayType: "text",
                    options: [{ id: "opt-s", name: "S", colorHexCode: "#000000" }],
                },
            ])
        );

        expect(synced?.[0]).toMatchObject({
            displayType: "select",
            options: [{ id: "opt-s", name: "S", colorHexCode: undefined }],
        });
    });

    test("updates hex codes of existing colour options that differ or are missing", async () => {
        const synced = await runSync(
            [
                {
                    id: "sw-color",
                    name: "Color",
                    displayType: "color",
                    options: [
                        { id: "sw-red", name: "Red" },
                        { id: "sw-blue", name: "Blue", colorHexCode: "#0000FF" },
                        { id: "sw-green", name: "Green", colorHexCode: "#000000" },
                        { id: "sw-black", name: "Black", colorHexCode: "#111111" },
                    ],
                },
            ],
            blueprintWith([
                {
                    id: "pg-color",
                    name: "Color",
                    displayType: "color",
                    options: [
                        { id: "opt-red", name: "Red", colorHexCode: "#FF0000" },
                        { id: "opt-blue", name: "Blue", colorHexCode: "#0000FF" },
                        { id: "opt-green", name: "Green", colorHexCode: "#00FF00" },
                        { id: "opt-black", name: "Black" },
                        { id: "opt-pink", name: "Pink", colorHexCode: "#FFC0CB" },
                    ],
                },
            ])
        );

        expect(synced).toEqual([
            {
                id: "sw-color",
                name: "Color",
                description: "Properties for Color",
                displayType: "color",
                filterable: undefined,
                options: [
                    { id: "opt-pink", name: "Pink", colorHexCode: "#FFC0CB" },
                    { id: "sw-red", name: "Red", colorHexCode: "#FF0000" },
                    { id: "sw-green", name: "Green", colorHexCode: "#00FF00" },
                ],
            },
        ]);
    });

    test("skips a colour group whose hex codes already match", async () => {
        const synced = await runSync(
            [
                {
                    id: "sw-color",
                    name: "Color",
                    displayType: "color",
                    options: [{ id: "sw-red", name: "Red", colorHexCode: "#FF0000" }],
                },
            ],
            blueprintWith([
                {
                    id: "pg-color",
                    name: "Color",
                    displayType: "color",
                    options: [{ id: "opt-red", name: "Red", colorHexCode: "#FF0000" }],
                },
            ])
        );

        expect(synced).toBeUndefined();
    });

    test("switches an existing group to colour and resends every option with hex codes", async () => {
        const synced = await runSync(
            [
                {
                    id: "sw-color",
                    name: "Color",
                    displayType: "text",
                    options: [{ id: "sw-red", name: "Red", colorHexCode: "#FF0000" }],
                },
            ],
            blueprintWith([
                {
                    id: "pg-color",
                    name: "Color",
                    displayType: "color",
                    options: [
                        { id: "opt-red", name: "Red", colorHexCode: "#FF0000" },
                        { id: "opt-blue", name: "Blue", colorHexCode: "#0000FF" },
                    ],
                },
            ])
        );

        expect(synced?.[0]).toMatchObject({
            id: "sw-color",
            displayType: "color",
            options: [
                { id: "sw-red", name: "Red", colorHexCode: "#FF0000" },
                { id: "opt-blue", name: "Blue", colorHexCode: "#0000FF" },
            ],
        });
    });

    test("does not switch a colour group back to another display type", async () => {
        const synced = await runSync(
            [{ id: "sw-size", name: "Size", displayType: "color", options: [] }],
            blueprintWith([
                {
                    id: "pg-size",
                    name: "Size",
                    displayType: "text",
                    options: [{ id: "opt-s", name: "S" }],
                },
            ])
        );

        expect(synced?.[0]?.displayType).toBe("color");
    });

    test("sends only changed groups, in blueprint order, in one call", async () => {
        const synced = await runSync(
            [
                {
                    id: "sw-size",
                    name: "Size",
                    displayType: "text",
                    options: [{ id: "sw-s", name: "S" }],
                },
            ],
            blueprintWith([
                { id: "pg-material", name: "Material", displayType: "text", options: [] },
                {
                    id: "pg-size",
                    name: "Size",
                    displayType: "text",
                    options: [{ id: "opt-s", name: "S" }],
                },
                { id: "pg-fit", name: "Fit", displayType: "text", options: [] },
            ])
        );

        expect(synced?.map((g) => g.id)).toEqual(["pg-material", "pg-fit"]);
    });

    test("syncs a colour group whose only change is a hex code", async () => {
        const synced = await runSync(
            [
                {
                    id: "sw-color",
                    name: "Color",
                    displayType: "color",
                    options: [{ id: "sw-red", name: "Red", colorHexCode: "#EE0000" }],
                },
            ],
            blueprintWith([
                {
                    id: "pg-color",
                    name: "Color",
                    displayType: "color",
                    options: [{ id: "opt-red", name: "Red", colorHexCode: "#FF0000" }],
                },
            ])
        );

        expect(synced?.[0]?.options).toEqual([
            { id: "sw-red", name: "Red", colorHexCode: "#FF0000" },
        ]);
    });

    test("skips a non-colour group even when its hex codes differ", async () => {
        const synced = await runSync(
            [
                {
                    id: "sw-size",
                    name: "Size",
                    displayType: "text",
                    options: [{ id: "sw-s", name: "S", colorHexCode: "#EE0000" }],
                },
            ],
            blueprintWith([
                {
                    id: "pg-size",
                    name: "Size",
                    displayType: "text",
                    options: [{ id: "opt-s", name: "S", colorHexCode: "#FF0000" }],
                },
            ])
        );

        expect(synced).toBeUndefined();
    });

    test("leaves the filter flag alone when the blueprint does not set it", async () => {
        const synced = await runSync(
            [
                {
                    id: "sw-size",
                    name: "Size",
                    displayType: "text",
                    filterable: true,
                    options: [{ id: "sw-s", name: "S" }],
                },
            ],
            blueprintWith([
                {
                    id: "pg-size",
                    name: "Size",
                    displayType: "text",
                    options: [{ id: "opt-s", name: "S" }],
                },
            ])
        );

        expect(synced).toBeUndefined();
    });

    test("syncs a group whose only change is the filter flag", async () => {
        const synced = await runSync(
            [
                {
                    id: "sw-size",
                    name: "Size",
                    displayType: "text",
                    filterable: true,
                    options: [{ id: "sw-s", name: "S" }],
                },
            ],
            blueprintWith([
                {
                    id: "pg-size",
                    name: "Size",
                    displayType: "text",
                    filterable: false,
                    options: [{ id: "opt-s", name: "S" }],
                },
            ])
        );

        expect(synced?.[0]).toMatchObject({ id: "sw-size", filterable: false, options: [] });
    });
});

describe("syncPropertyGroups — colour images", () => {
    interface ColorImageMocks {
        getOrCreateMediaFolder: ReturnType<typeof mock>;
        createMedia: ReturnType<typeof mock>;
        uploadMediaFile: ReturnType<typeof mock>;
        updatePropertyOptionMedia: ReturnType<typeof mock>;
    }

    function colorImageHydrator(overrides: Partial<ColorImageMocks> = {}): {
        dataHydrator: DataHydrator;
        mocks: ColorImageMocks;
    } {
        let mediaCounter = 0;
        const mocks: ColorImageMocks = {
            getOrCreateMediaFolder: mock(async () => "folder-1"),
            createMedia: mock(async () => `media-${++mediaCounter}`),
            uploadMediaFile: mock(async () => {}),
            updatePropertyOptionMedia: mock(async () => {}),
            ...overrides,
        };
        const dataHydrator = Object.assign(createMockDataHydrator(), mocks);
        return { dataHydrator, mocks };
    }

    function colorBlueprint(groupName: string, optionNames: string[]): HydratedBlueprint {
        return {
            version: "1.0",
            createdAt: "2024-01-01",
            hydratedAt: "2024-01-01",
            salesChannel: { name: "test", description: "Test" },
            categories: [],
            products: [],
            propertyGroups: [
                {
                    id: "pg-color",
                    name: groupName,
                    displayType: "color",
                    options: optionNames.map((name) => ({
                        id: `opt-${name.toLowerCase()}`,
                        name,
                    })),
                },
            ],
        };
    }

    async function sync(dataHydrator: DataHydrator, blueprint: HydratedBlueprint): Promise<void> {
        logger.setMcpMode(true);
        await syncPropertyGroups(dataHydrator, blueprint);
        logger.setMcpMode(false);
    }

    test("does nothing without a colour group", async () => {
        const { dataHydrator, mocks } = colorImageHydrator();
        await sync(dataHydrator, colorBlueprint("Size", ["Rainbow"]));
        expect(mocks.getOrCreateMediaFolder).not.toHaveBeenCalled();
    });

    test("does nothing when no colour option needs an image", async () => {
        const { dataHydrator, mocks } = colorImageHydrator();
        await sync(dataHydrator, colorBlueprint("Color", ["Red", "Blue"]));
        expect(mocks.getOrCreateMediaFolder).not.toHaveBeenCalled();
    });

    test("stops when the media folder cannot be created", async () => {
        const { dataHydrator, mocks } = colorImageHydrator({
            getOrCreateMediaFolder: mock(async () => null),
        });
        await sync(dataHydrator, colorBlueprint("Color", ["Rainbow"]));
        expect(mocks.getOrCreateMediaFolder).toHaveBeenCalledWith("Property Images");
        expect(mocks.createMedia).not.toHaveBeenCalled();
    });

    test("uploads a PNG per image colour and links it to the option", async () => {
        const { dataHydrator, mocks } = colorImageHydrator();
        await sync(dataHydrator, colorBlueprint("COLOR", ["Red", "Rainbow", "Multi-Color"]));

        expect(mocks.createMedia.mock.calls).toEqual([
            ["folder-1", "color-rainbow"],
            ["folder-1", "color-multi-color"],
        ]);
        expect(mocks.uploadMediaFile).toHaveBeenCalledTimes(2);
        const [mediaId, buffer, extension] = mocks.uploadMediaFile.mock.calls[0] ?? [];
        expect(mediaId).toBe("media-1");
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(String(buffer).length).toBeGreaterThan(0);
        expect(extension).toBe("png");
        expect(mocks.updatePropertyOptionMedia.mock.calls).toEqual([
            ["opt-rainbow", "media-1"],
            ["opt-multi-color", "media-2"],
        ]);
    });

    test("skips an option when the media entity cannot be created", async () => {
        const { dataHydrator, mocks } = colorImageHydrator({
            createMedia: mock(async (_folder: string, name: string) =>
                name === "color-rainbow" ? null : "media-x"
            ),
        });
        await sync(dataHydrator, colorBlueprint("Color", ["Rainbow", "Gradient"]));

        expect(mocks.uploadMediaFile).toHaveBeenCalledTimes(1);
        expect(mocks.updatePropertyOptionMedia.mock.calls).toEqual([["opt-gradient", "media-x"]]);
    });

    test("continues with the next option when an upload fails", async () => {
        let call = 0;
        const { dataHydrator, mocks } = colorImageHydrator({
            uploadMediaFile: mock(async () => {
                call++;
                if (call === 1) throw new Error("upload failed");
            }),
        });
        await sync(dataHydrator, colorBlueprint("Color", ["Rainbow", "Gradient"]));

        expect(mocks.uploadMediaFile).toHaveBeenCalledTimes(2);
        expect(mocks.updatePropertyOptionMedia.mock.calls).toEqual([["opt-gradient", "media-2"]]);
    });

    test("continues when an upload throws a non-Error value", async () => {
        const { dataHydrator, mocks } = colorImageHydrator({
            updatePropertyOptionMedia: mock(async () => {
                throw "boom";
            }),
        });
        await sync(dataHydrator, colorBlueprint("Color", ["Rainbow", "Gradient"]));
        expect(mocks.updatePropertyOptionMedia).toHaveBeenCalledTimes(2);
    });
});
