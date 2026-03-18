import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";

import type { HydratedBlueprint } from "../../src/types/index.js";

import { BlueprintGenerator } from "../../src/blueprint/generator.js";
import { DataCache } from "../../src/cache.js";
import { isIncompleteHydration, validateBlueprint } from "../../src/utils/blueprint-validation.js";
import { PropertyCollector } from "../../src/utils/property-collector.js";

// Test cache directory
const TEST_CACHE_DIR = "./test-generated-blueprint";

describe("Blueprint Integration", () => {
    let cache: DataCache;

    beforeEach(() => {
        // Create test cache
        cache = new DataCache({
            enabled: true,
            cacheDir: TEST_CACHE_DIR,
            useCache: true,
            saveToCache: true,
        });
    });

    afterEach(() => {
        // Cleanup test cache
        if (fs.existsSync(TEST_CACHE_DIR)) {
            fs.rmSync(TEST_CACHE_DIR, { recursive: true });
        }
    });

    describe("BlueprintGenerator + Cache", () => {
        test("generates and saves blueprint to cache", () => {
            const generator = new BlueprintGenerator();
            const blueprint = generator.generateBlueprint("test-store", "A test furniture store");

            cache.saveBlueprint("test-store", blueprint);

            expect(cache.hasBlueprint("test-store")).toBe(true);

            const loaded = cache.loadBlueprint("test-store");
            expect(loaded).not.toBeNull();
            expect(loaded?.salesChannel.name).toBe("test-store");
            expect(loaded?.products.length).toBe(90);
        });

        test("blueprint structure is complete", () => {
            const generator = new BlueprintGenerator({
                topLevelCategories: 3,
                totalProducts: 90,
            });
            const blueprint = generator.generateBlueprint("complete-test", "Complete test");

            expect(blueprint.version).toBe("1.0");
            expect(blueprint.salesChannel).toBeDefined();
            expect(blueprint.categories.length).toBe(3);
            expect(blueprint.products.length).toBe(90);
            expect(blueprint.createdAt).toBeDefined();

            for (const cat of blueprint.categories) {
                expect(cat.id).toMatch(/^[0-9a-f]{32}$/);
                expect(cat.level).toBe(1);
                expect(cat.children.length).toBeGreaterThan(0);
            }

            for (const product of blueprint.products) {
                expect(product.id).toMatch(/^[0-9a-f]{32}$/);
                expect(product.primaryCategoryId).toBeDefined();
                expect(product.categoryIds.length).toBeGreaterThanOrEqual(1);
                expect(product.metadata).toBeDefined();
            }
        });
    });

    describe("HydratedBlueprint + Cache", () => {
        test("saves and loads hydrated blueprint", () => {
            const hydratedBlueprint: HydratedBlueprint = {
                version: "1.0",
                salesChannel: {
                    name: "hydrated-test",
                    description: "A hydrated test store",
                },
                categories: [
                    {
                        id: "a".repeat(32),
                        name: "Furniture",
                        description: "All furniture items",
                        level: 1,
                        hasImage: true,
                        imageDescription: "Beautiful furniture banner",
                        children: [],
                    },
                ],
                products: [
                    {
                        id: "b".repeat(32),
                        name: "Oak Chair - Modern Style",
                        description: "<p>A beautiful oak chair</p>",
                        price: 99.99,
                        stock: 50,
                        primaryCategoryId: "a".repeat(32),
                        categoryIds: ["a".repeat(32)],
                        metadata: {
                            imageCount: 2,
                            imageDescriptions: [
                                { view: "front", prompt: "Oak chair from front" },
                                { view: "lifestyle", prompt: "Oak chair in living room" },
                            ],
                            isVariant: false,
                            properties: [
                                { group: "Material", value: "Oak" },
                                { group: "Style", value: "Modern" },
                            ],
                            manufacturerName: "Nordic Furniture Co",
                            reviewCount: 5,
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
                createdAt: new Date().toISOString(),
                hydratedAt: new Date().toISOString(),
            };

            cache.saveHydratedBlueprint("hydrated-test", hydratedBlueprint);

            expect(cache.hasHydratedBlueprint("hydrated-test")).toBe(true);

            const loaded = cache.loadHydratedBlueprint("hydrated-test");
            expect(loaded).not.toBeNull();
            expect(loaded?.salesChannel.name).toBe("hydrated-test");
            expect(loaded?.products[0]?.metadata.manufacturerName).toBe("Nordic Furniture Co");
        });

        test("saves product metadata separately", () => {
            const productId = "c".repeat(32);
            const hydratedBlueprint: HydratedBlueprint = {
                version: "1.0",
                salesChannel: { name: "meta-test", description: "" },
                categories: [],
                products: [
                    {
                        id: productId,
                        name: "Test Product",
                        description: "",
                        price: 10,
                        stock: 10,
                        primaryCategoryId: "",
                        categoryIds: [],
                        metadata: {
                            imageCount: 1,
                            imageDescriptions: [{ view: "front", prompt: "Test" }],
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
                createdAt: new Date().toISOString(),
                hydratedAt: new Date().toISOString(),
            };

            cache.saveHydratedBlueprint("meta-test", hydratedBlueprint);

            const metadata = cache.loadProductMetadata("meta-test", productId);
            expect(metadata).not.toBeNull();
            expect(metadata?.imageCount).toBe(1);
        });
    });

    describe("PropertyCollector Integration", () => {
        test("collects and deduplicates properties from hydrated blueprint", () => {
            const hydratedBlueprint: HydratedBlueprint = {
                version: "1.0",
                salesChannel: { name: "prop-test", description: "" },
                categories: [],
                products: [
                    {
                        id: "1".repeat(32),
                        name: "Product 1",
                        description: "",
                        price: 10,
                        stock: 10,
                        primaryCategoryId: "",
                        categoryIds: [],
                        metadata: {
                            imageCount: 1,
                            imageDescriptions: [],
                            isVariant: false,
                            properties: [
                                { group: "Color", value: "Red" },
                                { group: "Material", value: "Wood" },
                            ],
                            manufacturerName: "Acme Corp",
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
                    {
                        id: "2".repeat(32),
                        name: "Product 2",
                        description: "",
                        price: 20,
                        stock: 20,
                        primaryCategoryId: "",
                        categoryIds: [],
                        metadata: {
                            imageCount: 1,
                            imageDescriptions: [],
                            isVariant: false,
                            properties: [
                                { group: "Color", value: "Blue" },
                                { group: "Material", value: "Wood" },
                            ],
                            manufacturerName: "Acme Corp",
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
                createdAt: new Date().toISOString(),
                hydratedAt: new Date().toISOString(),
            };

            const collector = new PropertyCollector();
            const groups = collector.collectFromBlueprint(hydratedBlueprint);

            expect(groups.length).toBe(2);

            // Color group is automatically "color" type with hex codes
            const colorGroup = groups.find((g) => g.name === "Color");
            expect(colorGroup).toBeDefined();
            expect(colorGroup?.options.length).toBe(2);
            expect(colorGroup?.displayType).toBe("color");
            expect(colorGroup?.options.find((o) => o.name === "Red")?.colorHexCode).toBe("#dc2626");

            // Other groups are "text" type
            const materialGroup = groups.find((g) => g.name === "Material");
            expect(materialGroup).toBeDefined();
            expect(materialGroup?.options.length).toBe(1);
            expect(materialGroup?.displayType).toBe("text");

            const manufacturers = collector.collectManufacturers(hydratedBlueprint);
            expect(manufacturers.length).toBe(1);
            expect(manufacturers[0]).toBe("Acme Corp");
        });
    });

    describe("Incomplete Hydration Detection", () => {
        test("detects blueprint with no products as incomplete", () => {
            const incomplete: HydratedBlueprint = {
                version: "1.0",
                salesChannel: { name: "broken-store", description: "A broken store" },
                categories: [
                    {
                        id: "a".repeat(32),
                        name: "Furniture",
                        description: "All furniture items",
                        level: 1,
                        hasImage: false,
                        children: [],
                    },
                ],
                products: [],
                propertyGroups: [],
                createdAt: new Date().toISOString(),
                hydratedAt: new Date().toISOString(),
            };

            cache.saveHydratedBlueprint("broken-store", incomplete);
            expect(cache.hasHydratedBlueprint("broken-store")).toBe(true);

            const loaded = cache.loadHydratedBlueprint("broken-store");
            expect(loaded).not.toBeNull();
            if (!loaded) return;

            const result = validateBlueprint(loaded, { autoFix: true, logFixes: false });
            expect(result.valid).toBe(false);
            expect(isIncompleteHydration(result)).toBe(true);
        });

        test("incomplete blueprint can be deleted for re-hydration", () => {
            const incomplete: HydratedBlueprint = {
                version: "1.0",
                salesChannel: { name: "retry-store", description: "" },
                categories: [],
                products: [],
                propertyGroups: [],
                createdAt: new Date().toISOString(),
                hydratedAt: new Date().toISOString(),
            };

            cache.saveHydratedBlueprint("retry-store", incomplete);
            expect(cache.hasHydratedBlueprint("retry-store")).toBe(true);

            cache.deleteHydratedBlueprint("retry-store");
            expect(cache.hasHydratedBlueprint("retry-store")).toBe(false);
        });

        test("valid blueprint is not detected as incomplete", () => {
            const valid: HydratedBlueprint = {
                version: "1.0",
                salesChannel: { name: "good-store", description: "A good store" },
                categories: [
                    {
                        id: "a".repeat(32),
                        name: "Furniture",
                        description: "All furniture",
                        level: 1,
                        hasImage: false,
                        children: [
                            {
                                id: "b".repeat(32),
                                name: "Chairs",
                                description: "All chairs",
                                level: 2,
                                hasImage: false,
                                parentId: "a".repeat(32),
                                children: [],
                            },
                        ],
                    },
                ],
                products: [
                    {
                        id: "c".repeat(32),
                        name: "Oak Chair - Modern Style",
                        description: "<p>A beautiful oak chair</p>",
                        price: 99.99,
                        stock: 50,
                        primaryCategoryId: "b".repeat(32),
                        categoryIds: ["b".repeat(32)],
                        metadata: {
                            imageCount: 1,
                            imageDescriptions: [{ view: "front", prompt: "Oak chair front view" }],
                            isVariant: false,
                            properties: [{ group: "Material", value: "Oak" }],
                            manufacturerName: "Nordic Furniture Co",
                            reviewCount: 3,
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
                createdAt: new Date().toISOString(),
                hydratedAt: new Date().toISOString(),
            };

            cache.saveHydratedBlueprint("good-store", valid);
            const loaded = cache.loadHydratedBlueprint("good-store");
            expect(loaded).not.toBeNull();
            if (!loaded) return;

            const result = validateBlueprint(loaded, { autoFix: true, logFixes: false });
            expect(isIncompleteHydration(result)).toBe(false);
        });
    });
});
