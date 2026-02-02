import { describe, expect, test } from "bun:test";

import type { HydratedBlueprint } from "../../../src/types/index.js";
import { validateBlueprint } from "../../../src/utils/blueprint-validation.js";

/**
 * Helper to create a minimal valid blueprint for testing
 */
function createTestBlueprint(overrides: Partial<HydratedBlueprint> = {}): HydratedBlueprint {
    return {
        version: "1.0",
        salesChannel: {
            name: "test-store",
            description: "Test store",
        },
        categories: [
            {
                id: "cat1",
                name: "Test Category",
                description: "Test description",
                level: 1,
                hasImage: false,
                parentId: undefined,
                children: [],
            },
        ],
        products: [
            {
                id: "prod1",
                name: "Test Product",
                description: "Test product description",
                price: 29.99,
                stock: 10,
                primaryCategoryId: "cat1",
                categoryIds: ["cat1"],
                metadata: {
                    imageCount: 1 as const,
                    imageDescriptions: [],
                    isVariant: false,
                    properties: [],
                    reviewCount: 0 as const,
                    hasSalesPrice: false,
                },
            },
        ],
        propertyGroups: [],
        createdAt: new Date().toISOString(),
        hydratedAt: new Date().toISOString(),
        ...overrides,
    };
}

describe("Property Validation", () => {
    describe("validatePropertyGroups", () => {
        test("valid property groups pass validation", () => {
            const blueprint = createTestBlueprint({
                propertyGroups: [
                    {
                        id: "group1",
                        name: "Color",
                        displayType: "color",
                        options: [
                            { id: "opt1", name: "Red", colorHexCode: "#dc2626" },
                            { id: "opt2", name: "Blue", colorHexCode: "#2563eb" },
                        ],
                    },
                    {
                        id: "group2",
                        name: "Size",
                        displayType: "text",
                        options: [
                            { id: "opt3", name: "S" },
                            { id: "opt4", name: "M" },
                            { id: "opt5", name: "L" },
                        ],
                    },
                ],
                products: [
                    {
                        id: "prod1",
                        name: "Test Product",
                        description: "Test",
                        price: 29.99,
                        stock: 10,
                        primaryCategoryId: "cat1",
                        categoryIds: ["cat1"],
                        metadata: {
                            imageCount: 1 as const,
                            imageDescriptions: [],
                            isVariant: false,
                            properties: [
                                { group: "Color", value: "Red" },
                                { group: "Size", value: "M" },
                            ],
                            reviewCount: 0 as const,
                            hasSalesPrice: false,
                        },
                    },
                ],
            });

            const result = validateBlueprint(blueprint);
            expect(result.valid).toBe(true);
            expect(result.issues.length).toBe(0);
        });

        test("property group without name is an error", () => {
            const blueprint = createTestBlueprint({
                propertyGroups: [
                    {
                        id: "group1",
                        name: "", // Empty name
                        displayType: "text",
                        options: [
                            { id: "opt1", name: "A" },
                            { id: "opt2", name: "B" },
                        ],
                    },
                ],
            });

            const result = validateBlueprint(blueprint);
            expect(result.valid).toBe(false);

            const nameError = result.issues.find((i) => i.code === "MISSING_PROPERTY_GROUP_NAME");
            expect(nameError).toBeDefined();
            expect(nameError?.type).toBe("error");
        });

        test("property group without options is an error", () => {
            const blueprint = createTestBlueprint({
                propertyGroups: [
                    {
                        id: "group1",
                        name: "Empty Group",
                        displayType: "text",
                        options: [], // No options
                    },
                ],
            });

            const result = validateBlueprint(blueprint);
            expect(result.valid).toBe(false);

            const optionsError = result.issues.find((i) => i.code === "EMPTY_PROPERTY_OPTIONS");
            expect(optionsError).toBeDefined();
            expect(optionsError?.type).toBe("error");
            expect(optionsError?.message).toContain("Empty Group");
        });

        test("color property without hex codes is a warning", () => {
            const blueprint = createTestBlueprint({
                propertyGroups: [
                    {
                        id: "group1",
                        name: "Color",
                        displayType: "color",
                        options: [
                            { id: "opt1", name: "Red" }, // Missing colorHexCode
                            { id: "opt2", name: "Blue", colorHexCode: "#2563eb" },
                        ],
                    },
                ],
            });

            const result = validateBlueprint(blueprint);
            // Should still be valid (warnings don't fail validation)
            expect(result.valid).toBe(true);

            const hexWarning = result.issues.find((i) => i.code === "MISSING_COLOR_HEX");
            expect(hexWarning).toBeDefined();
            expect(hexWarning?.type).toBe("warning");
            expect(hexWarning?.message).toContain("Red");
        });

        test("product referencing non-existent property group is a warning", () => {
            const blueprint = createTestBlueprint({
                propertyGroups: [
                    {
                        id: "group1",
                        name: "Color",
                        displayType: "color",
                        options: [{ id: "opt1", name: "Red", colorHexCode: "#dc2626" }],
                    },
                ],
                products: [
                    {
                        id: "prod1",
                        name: "Test Product",
                        description: "Test",
                        price: 29.99,
                        stock: 10,
                        primaryCategoryId: "cat1",
                        categoryIds: ["cat1"],
                        metadata: {
                            imageCount: 1 as const,
                            imageDescriptions: [],
                            isVariant: false,
                            properties: [
                                { group: "Color", value: "Red" }, // Valid
                                { group: "Material", value: "Wood" }, // Non-existent group
                            ],
                            reviewCount: 0 as const,
                            hasSalesPrice: false,
                        },
                    },
                ],
            });

            const result = validateBlueprint(blueprint);
            // Should still be valid (warnings don't fail validation)
            expect(result.valid).toBe(true);

            const orphanWarning = result.issues.find((i) => i.code === "ORPHAN_PROPERTY_REFERENCE");
            expect(orphanWarning).toBeDefined();
            expect(orphanWarning?.type).toBe("warning");
            expect(orphanWarning?.message).toContain("Material");
            expect(orphanWarning?.message).toContain("Test Product");
        });

        test("case-insensitive property group matching", () => {
            const blueprint = createTestBlueprint({
                propertyGroups: [
                    {
                        id: "group1",
                        name: "Color",
                        displayType: "color",
                        options: [{ id: "opt1", name: "Red", colorHexCode: "#dc2626" }],
                    },
                ],
                products: [
                    {
                        id: "prod1",
                        name: "Test Product",
                        description: "Test",
                        price: 29.99,
                        stock: 10,
                        primaryCategoryId: "cat1",
                        categoryIds: ["cat1"],
                        metadata: {
                            imageCount: 1 as const,
                            imageDescriptions: [],
                            isVariant: false,
                            properties: [
                                { group: "color", value: "Red" }, // Lowercase should match
                            ],
                            reviewCount: 0 as const,
                            hasSalesPrice: false,
                        },
                    },
                ],
            });

            const result = validateBlueprint(blueprint);
            expect(result.valid).toBe(true);

            // Should not have orphan warning (case-insensitive match)
            const orphanWarning = result.issues.find((i) => i.code === "ORPHAN_PROPERTY_REFERENCE");
            expect(orphanWarning).toBeUndefined();
        });

        test("empty property groups array passes validation", () => {
            const blueprint = createTestBlueprint({
                propertyGroups: [],
            });

            const result = validateBlueprint(blueprint);
            expect(result.valid).toBe(true);
        });

        test("multiple validation errors are collected", () => {
            const blueprint = createTestBlueprint({
                propertyGroups: [
                    {
                        id: "group1",
                        name: "", // Error: missing name
                        displayType: "text",
                        options: [], // Error: no options
                    },
                    {
                        id: "group2",
                        name: "Valid Group",
                        displayType: "text",
                        options: [{ id: "opt1", name: "A" }], // This one is fine
                    },
                ],
            });

            const result = validateBlueprint(blueprint);
            expect(result.valid).toBe(false);

            // Should have both errors
            expect(result.issues.filter((i) => i.type === "error").length).toBeGreaterThanOrEqual(2);
        });
    });
});
