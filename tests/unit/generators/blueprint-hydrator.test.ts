/**
 * Unit tests for BlueprintHydrator
 *
 * Uses mock providers to test hydration logic without real AI calls.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { BlueprintHydrator } from "../../../src/generators/blueprint-hydrator.js";
import type {
    Blueprint,
    BlueprintCategory,
    BlueprintProduct,
    ChatMessage,
    HydratedBlueprint,
    TextProvider,
} from "../../../src/types/index.js";

// Test cache directory
const TEST_CACHE_DIR = "./test-generated-hydrator";

// =============================================================================
// Mock Text Provider
// =============================================================================

/**
 * Mock TextProvider that returns predefined responses based on prompt content
 */
class MockTextProvider implements TextProvider {
    readonly name = "mock";
    readonly isSequential = false;
    readonly maxConcurrency = 10;
    readonly tokenLimit = 100000;

    private callCount = 0;

    async generateCompletion(messages: ChatMessage[]): Promise<string> {
        this.callCount++;
        const userMessage = messages.find((m) => m.role === "user")?.content || "";

        // Category hydration response - matches both "Generate creative, SEO-friendly" and general category prompts
        if (
            userMessage.includes("categories") &&
            (userMessage.includes("SEO-friendly") || userMessage.includes("Generate names"))
        ) {
            return JSON.stringify({
                salesChannelDescription: "Your one-stop shop for quality furniture",
                categories: [
                    {
                        id: "cat1",
                        name: "Living Room Furniture",
                        description: "Comfortable furniture for your living space",
                        imageDescription: "Modern living room with elegant furniture",
                    },
                    {
                        id: "cat2",
                        name: "Bedroom Furniture",
                        description: "Cozy furniture for restful nights",
                        imageDescription: "Peaceful bedroom setting",
                    },
                    {
                        id: "cat1-1",
                        name: "Sofas",
                        description: "Comfortable sofas for lounging",
                        imageDescription: null,
                    },
                    {
                        id: "cat2-1",
                        name: "Beds",
                        description: "Quality beds for better sleep",
                        imageDescription: null,
                    },
                ],
            });
        }

        // Product hydration response
        if (
            userMessage.includes("Generate product content") ||
            userMessage.includes("Products to fill")
        ) {
            return JSON.stringify({
                products: [
                    {
                        id: "prod1",
                        name: "Oak Coffee Table - Natural Finish",
                        description: "<p>Beautiful oak coffee table with natural finish.</p>",
                        properties: [
                            { group: "Material", value: "Oak" },
                            { group: "Color", value: "Natural" },
                        ],
                        manufacturerName: "Nordic Furniture Co",
                        imageDescriptions: [
                            { view: "front", prompt: "Oak coffee table front view" },
                        ],
                        suggestedVariantGroups: null,
                        assignedCategories: ["Sofas"],
                    },
                    {
                        id: "prod2",
                        name: "Velvet Sofa - Gray - 3 Seater",
                        description: "<p>Luxurious velvet sofa in elegant gray.</p>",
                        properties: [
                            { group: "Material", value: "Velvet" },
                            { group: "Color", value: "Gray" },
                            { group: "Size", value: "3 Seater" },
                        ],
                        manufacturerName: "Nordic Furniture Co",
                        imageDescriptions: [
                            { view: "front", prompt: "Gray velvet sofa front view" },
                            { view: "lifestyle", prompt: "Gray velvet sofa in living room" },
                        ],
                        suggestedVariantGroups: null,
                        assignedCategories: ["Sofas"],
                    },
                ],
            });
        }

        // Properties-only hydration response
        if (userMessage.includes("Generate properties for existing products")) {
            return JSON.stringify({
                products: [
                    {
                        id: "prod1",
                        properties: [
                            { group: "Material", value: "Oak" },
                            { group: "Style", value: "Modern" },
                        ],
                        suggestedVariantGroups: null,
                    },
                    {
                        id: "prod2",
                        properties: [
                            { group: "Material", value: "Velvet" },
                            { group: "Color", value: "Gray" },
                        ],
                        suggestedVariantGroups: ["Color"],
                    },
                ],
            });
        }

        // Default response for unknown prompts - log for debugging
        console.log("[MockTextProvider] Unknown prompt:", userMessage.slice(0, 200));
        return JSON.stringify({ error: "Unknown prompt type" });
    }

    getCallCount(): number {
        return this.callCount;
    }

    resetCallCount(): void {
        this.callCount = 0;
    }
}

// =============================================================================
// Test Fixtures
// =============================================================================

function createTestBlueprint(): Blueprint {
    return {
        version: "1.0",
        salesChannel: {
            name: "test-furniture",
            description: "A test furniture store",
        },
        categories: [
            {
                id: "cat1",
                name: "Category 1",
                description: "",
                level: 1,
                hasImage: true,
                children: [
                    {
                        id: "cat1-1",
                        name: "Category 1.1",
                        description: "",
                        level: 2,
                        hasImage: false,
                        parentId: "cat1",
                        children: [],
                    },
                ],
            },
            {
                id: "cat2",
                name: "Category 2",
                description: "",
                level: 1,
                hasImage: true,
                children: [
                    {
                        id: "cat2-1",
                        name: "Category 2.1",
                        description: "",
                        level: 2,
                        hasImage: false,
                        parentId: "cat2",
                        children: [],
                    },
                ],
            },
        ],
        products: [
            {
                id: "prod1",
                name: "Product 1",
                description: "",
                price: 99.99,
                stock: 50,
                primaryCategoryId: "cat1",
                categoryIds: ["cat1", "cat1-1"],
                metadata: {
                    imageCount: 1,
                    imageDescriptions: [{ view: "front", prompt: "" }],
                    isVariant: false,
                    properties: [],
                    reviewCount: 3,
                    hasSalesPrice: false,
                },
            },
            {
                id: "prod2",
                name: "Product 2",
                description: "",
                price: 199.99,
                stock: 25,
                primaryCategoryId: "cat1",
                categoryIds: ["cat1", "cat1-1"],
                metadata: {
                    imageCount: 2,
                    imageDescriptions: [
                        { view: "front", prompt: "" },
                        { view: "lifestyle", prompt: "" },
                    ],
                    isVariant: true,
                    properties: [],
                    reviewCount: 5,
                    hasSalesPrice: false,
                },
            },
        ],
        createdAt: new Date().toISOString(),
    };
}

function createTestHydratedBlueprint(): HydratedBlueprint {
    return {
        version: "1.0",
        salesChannel: {
            name: "test-furniture",
            description: "A hydrated furniture store",
        },
        categories: [
            {
                id: "cat1",
                name: "Living Room",
                description: "Living room furniture",
                level: 1,
                hasImage: true,
                imageDescription: "Living room banner",
                children: [
                    {
                        id: "cat1-1",
                        name: "Sofas",
                        description: "Comfortable sofas",
                        level: 2,
                        hasImage: false,
                        parentId: "cat1",
                        children: [],
                    },
                ],
            },
            {
                id: "cat2",
                name: "Bedroom",
                description: "Bedroom furniture",
                level: 1,
                hasImage: true,
                imageDescription: "Bedroom banner",
                children: [
                    {
                        id: "cat2-1",
                        name: "Beds",
                        description: "Quality beds",
                        level: 2,
                        hasImage: false,
                        parentId: "cat2",
                        children: [],
                    },
                ],
            },
        ],
        products: [
            {
                id: "prod1",
                name: "Oak Coffee Table - Natural",
                description: "<p>A beautiful oak coffee table</p>",
                price: 99.99,
                stock: 50,
                primaryCategoryId: "cat1",
                categoryIds: ["cat1", "cat1-1"],
                metadata: {
                    imageCount: 1,
                    imageDescriptions: [
                        { view: "front", prompt: "Oak coffee table front view" },
                    ],
                    isVariant: false,
                    properties: [
                        { group: "Material", value: "Oak" },
                        { group: "Color", value: "Natural" },
                    ],
                    manufacturerName: "Nordic Furniture Co",
                    reviewCount: 3,
                    hasSalesPrice: false,
                    baseImagePrompt: "Oak Coffee Table - Natural, Oak construction",
                },
            },
            {
                id: "prod2",
                name: "Velvet Sofa - Gray",
                description: "<p>Luxurious velvet sofa</p>",
                price: 199.99,
                stock: 25,
                primaryCategoryId: "cat1",
                categoryIds: ["cat1", "cat1-1"],
                metadata: {
                    imageCount: 2,
                    imageDescriptions: [
                        { view: "front", prompt: "Gray velvet sofa front" },
                        { view: "lifestyle", prompt: "Gray velvet sofa in room" },
                    ],
                    isVariant: true,
                    properties: [
                        { group: "Material", value: "Velvet" },
                        { group: "Color", value: "Gray" },
                    ],
                    manufacturerName: "Nordic Furniture Co",
                    reviewCount: 5,
                    hasSalesPrice: false,
                    baseImagePrompt: "Velvet Sofa - Gray, Velvet construction",
                },
            },
        ],
        propertyGroups: [
            {
                id: "prop-group-material",
                name: "Material",
                displayType: "text",
                options: [
                    { id: "prop-option-oak", name: "Oak" },
                    { id: "prop-option-velvet", name: "Velvet" },
                ],
            },
            {
                id: "prop-group-color",
                name: "Color",
                displayType: "color",
                options: [
                    { id: "prop-option-natural", name: "Natural", colorHexCode: "#D2B48C" },
                    { id: "prop-option-gray", name: "Gray", colorHexCode: "#808080" },
                ],
            },
        ],
        createdAt: new Date().toISOString(),
        hydratedAt: new Date().toISOString(),
    };
}

// =============================================================================
// Tests
// =============================================================================

describe("BlueprintHydrator", () => {
    let mockProvider: MockTextProvider;
    let hydrator: BlueprintHydrator;

    beforeEach(() => {
        mockProvider = new MockTextProvider();
        hydrator = new BlueprintHydrator(mockProvider, TEST_CACHE_DIR);

        // Clean up test cache
        if (fs.existsSync(TEST_CACHE_DIR)) {
            fs.rmSync(TEST_CACHE_DIR, { recursive: true });
        }
    });

    afterEach(() => {
        // Clean up test cache
        if (fs.existsSync(TEST_CACHE_DIR)) {
            fs.rmSync(TEST_CACHE_DIR, { recursive: true });
        }
    });

    describe("hydrate", () => {
        test("hydrates blueprint with AI-generated content", async () => {
            const blueprint = createTestBlueprint();
            const result = await hydrator.hydrate(blueprint);

            // Should have hydrated categories
            expect(result.categories.length).toBe(2);
            expect(result.categories[0]?.name).toBe("Living Room Furniture");
            expect(result.categories[0]?.description).toContain("living");

            // Should have hydrated products
            expect(result.products.length).toBe(2);
            expect(result.products[0]?.name).toBe("Oak Coffee Table - Natural Finish");
            expect(result.products[0]?.metadata.properties.length).toBeGreaterThan(0);

            // Should have hydratedAt timestamp
            expect(result.hydratedAt).toBeDefined();
        });

        test("makes AI calls for categories and products", async () => {
            const blueprint = createTestBlueprint();
            mockProvider.resetCallCount();

            await hydrator.hydrate(blueprint);

            // Should have made at least 2 calls: categories + products
            expect(mockProvider.getCallCount()).toBeGreaterThanOrEqual(2);
        });
    });

    describe("hydrateCategoriesOnly", () => {
        test("updates only categories, preserves products", async () => {
            const existingBlueprint = createTestHydratedBlueprint();
            const originalProducts = JSON.parse(JSON.stringify(existingBlueprint.products));

            const result = await hydrator.hydrateCategoriesOnly(existingBlueprint);

            // Categories should be updated
            expect(result.categories[0]?.name).toBe("Living Room Furniture");
            expect(result.categories[0]?.description).toContain("living");

            // Products should be preserved exactly
            expect(result.products).toEqual(originalProducts);

            // Property groups should be preserved
            expect(result.propertyGroups).toEqual(existingBlueprint.propertyGroups);

            // Should have hydratedAt timestamp (may be same if test runs fast)
            expect(result.hydratedAt).toBeDefined();
        });

        test("preserves product names for image stability", async () => {
            const existingBlueprint = createTestHydratedBlueprint();

            const result = await hydrator.hydrateCategoriesOnly(existingBlueprint);

            // Product names should be identical
            for (let i = 0; i < existingBlueprint.products.length; i++) {
                expect(result.products[i]?.name).toBe(existingBlueprint.products[i]?.name);
                expect(result.products[i]?.metadata.baseImagePrompt).toBe(
                    existingBlueprint.products[i]?.metadata.baseImagePrompt
                );
            }
        });

        test("only makes category AI call, not product calls", async () => {
            const existingBlueprint = createTestHydratedBlueprint();
            mockProvider.resetCallCount();

            await hydrator.hydrateCategoriesOnly(existingBlueprint);

            // Should only make 1 call for categories
            expect(mockProvider.getCallCount()).toBe(1);
        });
    });

    describe("hydratePropertiesOnly", () => {
        test("updates only properties, preserves product names", async () => {
            const existingBlueprint = createTestHydratedBlueprint();
            const originalNames = existingBlueprint.products.map((p) => p.name);
            const originalDescriptions = existingBlueprint.products.map((p) => p.description);
            const originalImagePrompts = existingBlueprint.products.map(
                (p) => p.metadata.baseImagePrompt
            );

            const result = await hydrator.hydratePropertiesOnly(existingBlueprint);

            // Product names should be preserved
            for (let i = 0; i < result.products.length; i++) {
                expect(result.products[i]?.name).toBe(originalNames[i]);
            }

            // Product descriptions should be preserved
            for (let i = 0; i < result.products.length; i++) {
                expect(result.products[i]?.description).toBe(originalDescriptions[i]);
            }

            // Base image prompts should be preserved
            for (let i = 0; i < result.products.length; i++) {
                expect(result.products[i]?.metadata.baseImagePrompt).toBe(originalImagePrompts[i]);
            }

            // Properties should be updated
            expect(result.products[0]?.metadata.properties).toBeDefined();
            expect(result.products[0]?.metadata.properties.length).toBeGreaterThan(0);
        });

        test("preserves categories unchanged", async () => {
            const existingBlueprint = createTestHydratedBlueprint();
            const originalCategories = JSON.parse(JSON.stringify(existingBlueprint.categories));

            const result = await hydrator.hydratePropertiesOnly(existingBlueprint);

            // Categories should be identical
            expect(result.categories).toEqual(originalCategories);
        });

        test("sets hydratedAt timestamp", async () => {
            const existingBlueprint = createTestHydratedBlueprint();

            const result = await hydrator.hydratePropertiesOnly(existingBlueprint);

            // Should have hydratedAt timestamp
            expect(result.hydratedAt).toBeDefined();
            expect(new Date(result.hydratedAt).getTime()).toBeGreaterThan(0);
        });
    });

    describe("findPlaceholderCategories", () => {
        test("finds categories with placeholder names", () => {
            // Use actual placeholder patterns: "Top Category 1", "Category L1-1", etc.
            const categories: BlueprintCategory[] = [
                {
                    id: "1",
                    name: "Top Category 1", // Placeholder pattern
                    description: "Real description",
                    level: 1,
                    hasImage: false,
                    children: [
                        {
                            id: "1-1",
                            name: "Category L1-1", // Placeholder pattern
                            description: "",
                            level: 2,
                            hasImage: false,
                            parentId: "1",
                            children: [],
                        },
                    ],
                },
                {
                    id: "2",
                    name: "Living Room Furniture", // Real name
                    description: "Another description",
                    level: 1,
                    hasImage: false,
                    children: [],
                },
            ];

            const placeholders = hydrator.findPlaceholderCategories(categories);

            expect(placeholders.length).toBe(2);
            expect(placeholders.map((p) => p.id)).toContain("1");
            expect(placeholders.map((p) => p.id)).toContain("1-1");
        });

        test("returns empty array when no placeholders", () => {
            const categories: BlueprintCategory[] = [
                {
                    id: "1",
                    name: "Living Room",
                    description: "Real description",
                    level: 1,
                    hasImage: false,
                    children: [],
                },
            ];

            const placeholders = hydrator.findPlaceholderCategories(categories);
            expect(placeholders.length).toBe(0);
        });
    });

    describe("findPlaceholderProducts", () => {
        test("finds products with placeholder names", () => {
            // Use actual placeholder pattern: "Product 1", "Product 2", etc.
            const products: BlueprintProduct[] = [
                {
                    id: "1",
                    name: "Product 1", // Placeholder pattern
                    description: "",
                    price: 10,
                    stock: 10,
                    primaryCategoryId: "",
                    categoryIds: [],
                    metadata: {
                        imageCount: 1,
                        imageDescriptions: [],
                        isVariant: false,
                        properties: [],
                        reviewCount: 0,
                        hasSalesPrice: false,
                    },
                },
                {
                    id: "2",
                    name: "Oak Table - Natural", // Real name
                    description: "",
                    price: 20,
                    stock: 20,
                    primaryCategoryId: "",
                    categoryIds: [],
                    metadata: {
                        imageCount: 1,
                        imageDescriptions: [],
                        isVariant: false,
                        properties: [],
                        reviewCount: 0,
                        hasSalesPrice: false,
                    },
                },
            ];

            const placeholders = hydrator.findPlaceholderProducts(products);

            expect(placeholders.length).toBe(1);
            expect(placeholders[0]?.id).toBe("1");
        });

        test("returns empty array when no placeholders", () => {
            const products: BlueprintProduct[] = [
                {
                    id: "1",
                    name: "Oak Chair - Walnut Finish",
                    description: "",
                    price: 10,
                    stock: 10,
                    primaryCategoryId: "",
                    categoryIds: [],
                    metadata: {
                        imageCount: 1,
                        imageDescriptions: [],
                        isVariant: false,
                        properties: [],
                        reviewCount: 0,
                        hasSalesPrice: false,
                    },
                },
            ];

            const placeholders = hydrator.findPlaceholderProducts(products);
            expect(placeholders.length).toBe(0);
        });
    });
});
