/**
 * Unit tests for utils/blueprint-validation module
 */

import { describe, expect, test } from "bun:test";
import type { HydratedBlueprint } from "../../src/types/index.js";
import { hasValidationIssues, validateBlueprint } from "../../src/utils/blueprint-validation.js";

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockCategory(overrides: Partial<HydratedBlueprint["categories"][0]> = {}): HydratedBlueprint["categories"][0] {
    return {
        id: "cat-1",
        name: "Category One",
        description: "Description",
        level: 0,
        hasImage: false,
        children: [],
        ...overrides,
    };
}

function createMockProduct(overrides: Partial<HydratedBlueprint["products"][0]> = {}): HydratedBlueprint["products"][0] {
    return {
        id: "prod-1",
        name: "Product One",
        description: "Description",
        price: 99.99,
        stock: 10,
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
        ...overrides,
    };
}

function createMockBlueprint(overrides: Partial<HydratedBlueprint> = {}): HydratedBlueprint {
    return {
        version: "1.0",
        createdAt: "2024-01-01T00:00:00Z",
        hydratedAt: "2024-01-01T00:00:00Z",
        salesChannel: {
            name: "test-store",
            description: "Test store",
        },
        categories: [createMockCategory()],
        products: [createMockProduct()],
        propertyGroups: [],
        ...overrides,
    };
}

// =============================================================================
// Tests
// =============================================================================

describe("validateBlueprint", () => {
    describe("valid blueprints", () => {
        test("returns valid for well-formed blueprint", () => {
            const blueprint = createMockBlueprint();
            const result = validateBlueprint(blueprint);

            expect(result.valid).toBe(true);
            expect(result.issues).toHaveLength(0);
            expect(result.fixesApplied).toBe(0);
        });

        test("returns valid with multiple products and categories", () => {
            const blueprint = createMockBlueprint({
                products: [
                    createMockProduct({ id: "p1", name: "Product A" }),
                    createMockProduct({ id: "p2", name: "Product B" }),
                    createMockProduct({ id: "p3", name: "Product C" }),
                ],
                categories: [
                    createMockCategory({ id: "c1", name: "Cat A" }),
                    createMockCategory({ id: "c2", name: "Cat B" }),
                ],
            });
            const result = validateBlueprint(blueprint);

            expect(result.valid).toBe(true);
        });
    });

    describe("duplicate product names", () => {
        test("detects duplicate product names", () => {
            const blueprint = createMockBlueprint({
                products: [
                    createMockProduct({ id: "p1", name: "Same Name" }),
                    createMockProduct({ id: "p2", name: "Same Name" }),
                ],
            });
            const result = validateBlueprint(blueprint, { autoFix: false });

            expect(result.valid).toBe(false);
            expect(result.issues).toHaveLength(1);
            const issue = result.issues[0];
            if (issue) {
                expect(issue.code).toBe("DUPLICATE_PRODUCT_NAME");
                const affectedIds = issue.affectedIds;
                if (affectedIds) {
                    expect(affectedIds).toContain("p1");
                    expect(affectedIds).toContain("p2");
                }
            }
        });

        test("auto-fixes duplicate product names", () => {
            const blueprint = createMockBlueprint({
                products: [
                    createMockProduct({ id: "p1", name: "Same Name" }),
                    createMockProduct({ id: "p2", name: "Same Name" }),
                ],
            });
            const result = validateBlueprint(blueprint, { autoFix: true, logFixes: false });

            expect(result.valid).toBe(true);
            expect(result.fixesApplied).toBe(1);
            const p0 = blueprint.products[0];
            const p1 = blueprint.products[1];
            if (p0 && p1) {
                expect(p0.name).toBe("Same Name");
                expect(p1.name).toBe("Same Name (2)");
            }
        });

        test("auto-fixes multiple duplicates", () => {
            const blueprint = createMockBlueprint({
                products: [
                    createMockProduct({ id: "p1", name: "Same Name" }),
                    createMockProduct({ id: "p2", name: "Same Name" }),
                    createMockProduct({ id: "p3", name: "Same Name" }),
                ],
            });
            const result = validateBlueprint(blueprint, { autoFix: true, logFixes: false });

            expect(result.valid).toBe(true);
            expect(result.fixesApplied).toBe(2);
            const p0 = blueprint.products[0];
            const p1 = blueprint.products[1];
            const p2 = blueprint.products[2];
            if (p0 && p1 && p2) {
                expect(p0.name).toBe("Same Name");
                expect(p1.name).toBe("Same Name (2)");
                expect(p2.name).toBe("Same Name (3)");
            }
        });
    });

    describe("placeholder detection", () => {
        test("detects placeholder product names", () => {
            const blueprint = createMockBlueprint({
                products: [
                    createMockProduct({ id: "p1", name: "Product 1" }),
                    createMockProduct({ id: "p2", name: "Product 2" }),
                ],
            });
            const result = validateBlueprint(blueprint);

            expect(result.valid).toBe(false);
            expect(result.issues.some((i) => i.code === "PLACEHOLDER_PRODUCT_NAME")).toBe(true);
        });

        test("detects placeholder category names", () => {
            const blueprint = createMockBlueprint({
                categories: [
                    createMockCategory({ id: "c1", name: "Top Category 1" }),
                ],
            });
            const result = validateBlueprint(blueprint);

            expect(result.valid).toBe(false);
            expect(result.issues.some((i) => i.code === "PLACEHOLDER_CATEGORY_NAME")).toBe(true);
        });

        test("detects nested placeholder category names", () => {
            const blueprint = createMockBlueprint({
                categories: [
                    createMockCategory({
                        id: "c1",
                        name: "Valid Name",
                        children: [
                            createMockCategory({ id: "c2", name: "Category L2-1", level: 1 }),
                        ],
                    }),
                ],
            });
            const result = validateBlueprint(blueprint);

            expect(result.valid).toBe(false);
            expect(result.issues.some((i) => i.code === "PLACEHOLDER_CATEGORY_NAME")).toBe(true);
        });
    });

    describe("missing required fields", () => {
        test("detects missing sales channel name", () => {
            const blueprint = createMockBlueprint({
                salesChannel: { name: "", description: "Desc" },
            });
            const result = validateBlueprint(blueprint);

            expect(result.valid).toBe(false);
            expect(result.issues.some((i) => i.code === "MISSING_SALES_CHANNEL_NAME")).toBe(true);
        });

        test("detects empty products array", () => {
            const blueprint = createMockBlueprint({ products: [] });
            const result = validateBlueprint(blueprint);

            expect(result.valid).toBe(false);
            expect(result.issues.some((i) => i.code === "NO_PRODUCTS")).toBe(true);
        });

        test("detects empty categories array", () => {
            const blueprint = createMockBlueprint({ categories: [] });
            const result = validateBlueprint(blueprint);

            expect(result.valid).toBe(false);
            expect(result.issues.some((i) => i.code === "NO_CATEGORIES")).toBe(true);
        });
    });

    describe("warnings", () => {
        test("warns about duplicate category names at same level", () => {
            const blueprint = createMockBlueprint({
                categories: [
                    createMockCategory({ id: "c1", name: "Same Name" }),
                    createMockCategory({ id: "c2", name: "Same Name" }),
                ],
            });
            const result = validateBlueprint(blueprint);

            // Should be a warning, not an error
            expect(result.issues.some((i) => i.code === "DUPLICATE_CATEGORY_NAME")).toBe(true);
            const issue = result.issues.find((i) => i.code === "DUPLICATE_CATEGORY_NAME");
            expect(issue?.type).toBe("warning");
        });
    });
});

describe("hasValidationIssues", () => {
    test("returns false for valid blueprint", () => {
        const blueprint = createMockBlueprint();
        expect(hasValidationIssues(blueprint)).toBe(false);
    });

    test("returns true for blueprint with issues", () => {
        const blueprint = createMockBlueprint({
            products: [
                createMockProduct({ id: "p1", name: "Product 1" }),
            ],
        });
        expect(hasValidationIssues(blueprint)).toBe(true);
    });
});
