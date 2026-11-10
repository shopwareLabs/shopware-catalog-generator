/**
 * Unit tests for utils/blueprint-validation module
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { HydratedBlueprint } from "../../../src/types/index.js";
import type { BlueprintValidationResult } from "../../../src/utils/blueprint-validation.js";
import type { LogOptions } from "../../../src/utils/index.js";

import {
    hasValidationIssues,
    isIncompleteHydration,
    isPlaceholder,
    validateBlueprint,
} from "../../../src/utils/blueprint-validation.js";
import { logger } from "../../../src/utils/index.js";

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockCategory(
    overrides: Partial<HydratedBlueprint["categories"][0]> = {}
): HydratedBlueprint["categories"][0] {
    return {
        id: "cat-1",
        name: "Category One",
        description: "Description",
        level: 0,
        hasImage: false,
        children: [
            {
                id: "cat-1-sub",
                name: "Subcategory One",
                description: "Sub Description",
                level: 1,
                hasImage: false,
                children: [],
            },
        ],
        ...overrides,
    };
}

function createMockProduct(
    overrides: Partial<HydratedBlueprint["products"][0]> = {}
): HydratedBlueprint["products"][0] {
    return {
        id: "prod-1",
        name: "Product One",
        description: "Description",
        price: 99.99,
        stock: 10,
        primaryCategoryId: "cat-1-sub",
        categoryIds: ["cat-1-sub"],
        metadata: {
            imageCount: 1,
            imageDescriptions: [{ view: "front" as const, prompt: "Product image" }],
            isVariant: false,
            properties: [{ group: "Color", value: "Red" }],
            manufacturerName: "Test Manufacturer",
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
                categories: [createMockCategory({ id: "c1", name: "Top Category 1" })],
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

describe("validateBlueprint — category assignments", () => {
    function issuesFor(products: HydratedBlueprint["products"], code: string) {
        return validateBlueprint(createMockBlueprint({ products })).issues.filter(
            (i) => i.code === code
        );
    }

    test("reports products without categories as one error", () => {
        const issues = issuesFor(
            [
                createMockProduct({ id: "p1", name: "A", categoryIds: [] }),
                createMockProduct({ id: "p2", name: "B" }),
            ],
            "PRODUCTS_NO_CATEGORIES"
        );
        expect(issues).toEqual([
            {
                type: "error",
                code: "PRODUCTS_NO_CATEGORIES",
                message: "1 products have no category assignments",
                field: "products[].categoryIds",
                affectedIds: ["p1"],
            },
        ]);
    });

    test("reports products with unknown category IDs as one error", () => {
        const issues = issuesFor(
            [
                createMockProduct({ id: "p1", name: "A", categoryIds: ["cat-1-sub", "nope"] }),
                createMockProduct({ id: "p2", name: "B", categoryIds: ["gone"] }),
            ],
            "INVALID_CATEGORY_REFERENCE"
        );
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({
            type: "error",
            message: "2 products reference non-existent categories",
            affectedIds: ["p1", "p2"],
        });
    });

    test("warns about products that are only in top-level categories", () => {
        const issues = issuesFor(
            [
                createMockProduct({ id: "p1", name: "A", categoryIds: ["cat-1"] }),
                createMockProduct({ id: "p2", name: "B", categoryIds: ["cat-1", "cat-1-sub"] }),
            ],
            "PRODUCTS_ONLY_TOP_LEVEL"
        );
        expect(issues).toEqual([
            {
                type: "warning",
                code: "PRODUCTS_ONLY_TOP_LEVEL",
                message:
                    "1 products only assigned to top-level categories (missing subcategory assignment)",
                field: "products[].categoryIds",
                affectedIds: ["p1"],
            },
        ]);
    });

    test("does not count a product without categories as top-level only", () => {
        const products = [createMockProduct({ id: "p1", name: "A", categoryIds: [] })];
        expect(issuesFor(products, "PRODUCTS_ONLY_TOP_LEVEL")).toEqual([]);
        expect(issuesFor(products, "INVALID_CATEGORY_REFERENCE")).toEqual([]);
    });
});

describe("validateBlueprint — property groups", () => {
    type Group = NonNullable<HydratedBlueprint["propertyGroups"]>[number];

    function group(overrides: Partial<Group> = {}): Group {
        return {
            id: "g-color",
            name: "Color",
            displayType: "color",
            options: [{ id: "o-red", name: "Red", colorHexCode: "#FF0000" }],
            ...overrides,
        };
    }

    function issuesFor(propertyGroups: Group[], code: string) {
        return validateBlueprint(createMockBlueprint({ propertyGroups })).issues.filter(
            (i) => i.code === code
        );
    }

    test("reports nothing for a complete colour group", () => {
        const codes = validateBlueprint(createMockBlueprint({ propertyGroups: [group()] })).issues;
        expect(codes).toEqual([]);
    });

    test("reports a group without a name", () => {
        expect(issuesFor([group({ id: "g1", name: "  " })], "MISSING_PROPERTY_GROUP_NAME")).toEqual(
            [
                {
                    type: "error",
                    code: "MISSING_PROPERTY_GROUP_NAME",
                    message: "Property group is missing name",
                    field: "propertyGroups[].name",
                    affectedIds: ["g1"],
                },
            ]
        );
    });

    test("reports a group without options", () => {
        expect(
            issuesFor([group({ id: "g1", name: "Size", options: [] })], "EMPTY_PROPERTY_OPTIONS")
        ).toEqual([
            {
                type: "error",
                code: "EMPTY_PROPERTY_OPTIONS",
                message: 'Property group "Size" has no options',
                field: "propertyGroups[].options",
                affectedIds: ["g1"],
            },
        ]);
    });

    test("warns about colour options without hex, except image colours", () => {
        const colors = group({
            name: "Main Color",
            options: [
                { id: "o1", name: "Red" },
                { id: "o2", name: "Multicolor" },
                { id: "o3", name: "Rainbow" },
                { id: "o4", name: "Blue" },
                { id: "o5", name: "Green", colorHexCode: "#00FF00" },
            ],
        });
        expect(issuesFor([colors], "MISSING_COLOR_HEX")).toEqual([
            {
                type: "warning",
                code: "MISSING_COLOR_HEX",
                message: "Color options missing hex codes: Red, Blue",
                field: "propertyGroups[].options[].colorHexCode",
            },
        ]);
    });

    test("does not check hex codes of non-colour groups", () => {
        const size = group({ name: "Size", options: [{ id: "o1", name: "Large" }] });
        expect(issuesFor([size], "MISSING_COLOR_HEX")).toEqual([]);
    });

    test("warns once per product property with an unknown group", () => {
        const product = createMockProduct({
            id: "p1",
            name: "Lamp",
            metadata: {
                ...createMockProduct().metadata,
                properties: [
                    { group: "color", value: "Red" },
                    { group: "Size", value: "L" },
                    { group: "Weight", value: "2kg" },
                ],
            },
        });
        const blueprint = createMockBlueprint({ products: [product], propertyGroups: [group()] });
        const issues = validateBlueprint(blueprint).issues.filter(
            (i) => i.code === "ORPHAN_PROPERTY_REFERENCE"
        );
        expect(issues.map((i) => i.message)).toEqual([
            'Product "Lamp" references non-existent property group "Size"',
            'Product "Lamp" references non-existent property group "Weight"',
        ]);
        expect(issues[0]).toMatchObject({
            type: "warning",
            field: "products[].metadata.properties",
            affectedIds: ["p1"],
        });
    });

    test("skips all property checks when there are no groups", () => {
        const product = createMockProduct({ name: "Lamp" });
        const issues = validateBlueprint(createMockBlueprint({ products: [product] })).issues;
        expect(issues.filter((i) => i.code === "ORPHAN_PROPERTY_REFERENCE")).toEqual([]);
    });
});

describe("isIncompleteHydration", () => {
    test("returns true when blueprint has no products", () => {
        const blueprint = createMockBlueprint({ products: [] });
        const result = validateBlueprint(blueprint, { autoFix: false, logFixes: false });
        expect(isIncompleteHydration(result)).toBe(true);
    });

    test("returns true when blueprint has no categories", () => {
        const blueprint = createMockBlueprint({ categories: [] });
        const result = validateBlueprint(blueprint, { autoFix: false, logFixes: false });
        expect(isIncompleteHydration(result)).toBe(true);
    });

    test("returns true when blueprint has neither products nor categories", () => {
        const blueprint = createMockBlueprint({ products: [], categories: [] });
        const result = validateBlueprint(blueprint, { autoFix: false, logFixes: false });
        expect(isIncompleteHydration(result)).toBe(true);
    });

    test("returns false for duplicate product name errors", () => {
        const blueprint = createMockBlueprint({
            products: [
                createMockProduct({ id: "p1", name: "Same Name" }),
                createMockProduct({ id: "p2", name: "Same Name" }),
            ],
        });
        const result = validateBlueprint(blueprint, { autoFix: false, logFixes: false });
        expect(result.valid).toBe(false);
        expect(isIncompleteHydration(result)).toBe(false);
    });

    test("returns false for valid blueprint", () => {
        const blueprint = createMockBlueprint();
        const result = validateBlueprint(blueprint, { autoFix: false, logFixes: false });
        expect(isIncompleteHydration(result)).toBe(false);
    });
});

describe("hasValidationIssues", () => {
    test("returns false for valid blueprint", () => {
        const blueprint = createMockBlueprint();
        expect(hasValidationIssues(blueprint)).toBe(false);
    });

    test("returns true for blueprint with issues", () => {
        const blueprint = createMockBlueprint({
            products: [createMockProduct({ id: "p1", name: "Product 1" })],
        });
        expect(hasValidationIssues(blueprint)).toBe(true);
    });
});

// =============================================================================
// Issue details (pin codes, messages, fields and affected IDs)
// =============================================================================

function issuesWithCode(blueprint: HydratedBlueprint, code: string) {
    return validateBlueprint(blueprint).issues.filter((i) => i.code === code);
}

/** Blueprints loaded from older cache files can miss fields the types require */
function withoutField<T extends object>(value: T, field: keyof T): T {
    Reflect.deleteProperty(value, field);
    return value;
}

describe("validateBlueprint — product metadata", () => {
    test("warns once about all products without properties", () => {
        const blueprint = createMockBlueprint({
            products: [
                createMockProduct({
                    id: "p1",
                    name: "A",
                    metadata: { ...createMockProduct().metadata, properties: [] },
                }),
                createMockProduct({ id: "p2", name: "B" }),
            ],
        });
        expect(issuesWithCode(blueprint, "PRODUCTS_NO_PROPERTIES")).toEqual([
            {
                type: "warning",
                code: "PRODUCTS_NO_PROPERTIES",
                message: "1 products have no properties defined",
                field: "products[].metadata.properties",
                affectedIds: ["p1"],
            },
        ]);
    });

    test("warns once about all products without a manufacturer", () => {
        const blueprint = createMockBlueprint({
            products: [
                createMockProduct({
                    id: "p1",
                    name: "A",
                    metadata: { ...createMockProduct().metadata, manufacturerName: "" },
                }),
                createMockProduct({
                    id: "p2",
                    name: "B",
                    metadata: withoutField({ ...createMockProduct().metadata }, "manufacturerName"),
                }),
                createMockProduct({ id: "p3", name: "C" }),
            ],
        });
        expect(issuesWithCode(blueprint, "PRODUCTS_NO_MANUFACTURER")).toEqual([
            {
                type: "warning",
                code: "PRODUCTS_NO_MANUFACTURER",
                message: "2 products have no manufacturer assigned",
                field: "products[].metadata.manufacturerName",
                affectedIds: ["p1", "p2"],
            },
        ]);
    });

    test("reports a product without metadata instead of throwing", () => {
        const product = withoutField(createMockProduct({ id: "p1", name: "Lamp" }), "metadata");
        const issues = validateBlueprint(createMockBlueprint({ products: [product] })).issues;

        expect(issues.map((i) => [i.code, i.affectedIds])).toEqual([
            ["PRODUCTS_NO_IMAGE_DESCRIPTIONS", ["p1"]],
            ["PRODUCTS_NO_PROPERTIES", ["p1"]],
            ["PRODUCTS_NO_MANUFACTURER", ["p1"]],
        ]);
    });
});

describe("validateBlueprint — image descriptions", () => {
    type ImageDescription = HydratedBlueprint["products"][0]["metadata"]["imageDescriptions"][0];

    function productWithImages(id: string, imageDescriptions: ImageDescription[]) {
        return createMockProduct({
            id,
            name: `Product ${id.toUpperCase()} Lamp`,
            metadata: { ...createMockProduct().metadata, imageDescriptions },
        });
    }

    test("warns about products without image descriptions and skips their prompt check", () => {
        const blueprint = createMockBlueprint({
            products: [
                productWithImages("p1", []),
                productWithImages("p2", [{ view: "front", prompt: "A lamp" }]),
            ],
        });
        const issues = validateBlueprint(blueprint).issues;

        expect(issues).toEqual([
            {
                type: "warning",
                code: "PRODUCTS_NO_IMAGE_DESCRIPTIONS",
                message: "1 products have no image descriptions",
                field: "products[].metadata.imageDescriptions",
                affectedIds: ["p1"],
            },
        ]);
    });

    test("warns about products with an empty, blank or missing prompt", () => {
        const missingPrompt = withoutField({ view: "side" as const, prompt: "x" }, "prompt");
        const blueprint = createMockBlueprint({
            products: [
                productWithImages("p1", [{ view: "front", prompt: "" }]),
                productWithImages("p2", [
                    { view: "front", prompt: "A lamp" },
                    { view: "side", prompt: "   " },
                ]),
                productWithImages("p3", [missingPrompt]),
                productWithImages("p4", [{ view: "front", prompt: "A lamp" }]),
            ],
        });

        expect(issuesWithCode(blueprint, "PRODUCTS_EMPTY_IMAGE_PROMPTS")).toEqual([
            {
                type: "warning",
                code: "PRODUCTS_EMPTY_IMAGE_PROMPTS",
                message: "3 products have empty image prompts",
                field: "products[].metadata.imageDescriptions[].prompt",
                affectedIds: ["p1", "p2", "p3"],
            },
        ]);
        expect(issuesWithCode(blueprint, "PRODUCTS_NO_IMAGE_DESCRIPTIONS")).toEqual([]);
    });
});

describe("validateBlueprint — product and category issues", () => {
    test("describes duplicate product names", () => {
        const blueprint = createMockBlueprint({
            products: [
                createMockProduct({ id: "p1", name: "Same Name" }),
                createMockProduct({ id: "p2", name: "Other" }),
                createMockProduct({ id: "p3", name: "Same Name" }),
            ],
        });
        expect(issuesWithCode(blueprint, "DUPLICATE_PRODUCT_NAME")).toEqual([
            {
                type: "error",
                code: "DUPLICATE_PRODUCT_NAME",
                message: 'Duplicate product name: "Same Name" (2 products)',
                field: "products[].name",
                affectedIds: ["p1", "p3"],
            },
        ]);
    });

    test("describes placeholder product names", () => {
        const blueprint = createMockBlueprint({
            products: [
                createMockProduct({ id: "p1", name: "Product 1" }),
                createMockProduct({ id: "p2", name: "Real Lamp" }),
                createMockProduct({ id: "p3", name: "Product 3" }),
            ],
        });
        expect(issuesWithCode(blueprint, "PLACEHOLDER_PRODUCT_NAME")).toEqual([
            {
                type: "error",
                code: "PLACEHOLDER_PRODUCT_NAME",
                message: "Found 2 placeholder product names (not hydrated by AI)",
                field: "products[].name",
                affectedIds: ["p1", "p3"],
            },
        ]);
    });

    test("describes a blueprint without products", () => {
        expect(issuesWithCode(createMockBlueprint({ products: [] }), "NO_PRODUCTS")).toEqual([
            {
                type: "error",
                code: "NO_PRODUCTS",
                message: "Blueprint has no products",
                field: "products",
            },
        ]);
    });

    test("describes duplicate category names with the short name", () => {
        const blueprint = createMockBlueprint({
            categories: [
                createMockCategory({ id: "c1", name: "Same Name", children: [] }),
                createMockCategory({ id: "c2", name: "Same Name", children: [] }),
            ],
        });
        expect(issuesWithCode(blueprint, "DUPLICATE_CATEGORY_NAME")).toEqual([
            {
                type: "warning",
                code: "DUPLICATE_CATEGORY_NAME",
                message: 'Duplicate category name at same level: "Same Name" (2 categories)',
                field: "categories[].name",
                affectedIds: ["c1", "c2"],
            },
        ]);
    });

    test("finds duplicate names among children of the same parent only", () => {
        const child = (id: string, name: string) =>
            createMockCategory({ id, name, level: 1, children: [] });
        const blueprint = createMockBlueprint({
            categories: [
                createMockCategory({
                    id: "c1",
                    name: "Lighting",
                    children: [child("c1-a", "Lamps"), child("c1-b", "Lamps")],
                }),
                createMockCategory({
                    id: "c2",
                    name: "Outdoor",
                    children: [child("c2-a", "Lamps"), child("cat-1-sub", "Garden")],
                }),
            ],
        });
        const issues = issuesWithCode(blueprint, "DUPLICATE_CATEGORY_NAME");

        expect(issues.map((i) => [i.message, i.affectedIds])).toEqual([
            ['Duplicate category name at same level: "Lamps" (2 categories)', ["c1-a", "c1-b"]],
        ]);
    });

    test("describes placeholder category names", () => {
        const blueprint = createMockBlueprint({
            categories: [
                createMockCategory({
                    id: "c1",
                    name: "Top Category 1",
                    children: [
                        createMockCategory({ id: "c1-a", name: "Category L2-1", children: [] }),
                        createMockCategory({ id: "cat-1-sub", name: "Lamps", children: [] }),
                    ],
                }),
            ],
        });
        expect(issuesWithCode(blueprint, "PLACEHOLDER_CATEGORY_NAME")).toEqual([
            {
                type: "error",
                code: "PLACEHOLDER_CATEGORY_NAME",
                message: "Found 2 placeholder category names (not hydrated by AI)",
                field: "categories[].name",
                affectedIds: ["c1", "c1-a"],
            },
        ]);
    });

    test("describes a blueprint without categories", () => {
        expect(issuesWithCode(createMockBlueprint({ categories: [] }), "NO_CATEGORIES")).toEqual([
            {
                type: "error",
                code: "NO_CATEGORIES",
                message: "Blueprint has no categories",
                field: "categories",
            },
        ]);
    });

    test("accepts categories without a children array", () => {
        const leaf = withoutField(
            createMockCategory({ id: "cat-1-sub", name: "Lamps", level: 1 }),
            "children"
        );
        const blueprint = createMockBlueprint({
            categories: [createMockCategory({ id: "cat-1", name: "Lighting", children: [leaf] })],
        });
        expect(validateBlueprint(blueprint).issues).toEqual([]);
    });

    test.each([
        ["an empty name", createMockBlueprint({ salesChannel: { name: "", description: "D" } })],
        ["no sales channel", withoutField(createMockBlueprint(), "salesChannel")],
    ])("describes a missing sales channel name (%s)", (_label, blueprint) => {
        expect(issuesWithCode(blueprint, "MISSING_SALES_CHANNEL_NAME")).toEqual([
            {
                type: "error",
                code: "MISSING_SALES_CHANNEL_NAME",
                message: "Blueprint is missing sales channel name",
                field: "salesChannel.name",
            },
        ]);
    });

    test("reports a property group without an options array", () => {
        const size = withoutField(
            { id: "g-size", name: "Size", displayType: "text" as const, options: [] },
            "options"
        );
        const blueprint = createMockBlueprint({
            propertyGroups: [
                size,
                {
                    id: "g-color",
                    name: "Color",
                    displayType: "color",
                    options: [{ id: "o-red", name: "Red", colorHexCode: "#FF0000" }],
                },
            ],
        });
        expect(issuesWithCode(blueprint, "EMPTY_PROPERTY_OPTIONS")).toEqual([
            {
                type: "error",
                code: "EMPTY_PROPERTY_OPTIONS",
                message: 'Property group "Size" has no options',
                field: "propertyGroups[].options",
                affectedIds: ["g-size"],
            },
        ]);
    });
});

describe("isPlaceholder", () => {
    test.each([
        ["Top Category 1", true],
        ["Top Category 12", true],
        ["Top Category 1 Lamps", false],
        ["My Top Category 1", false],
        ["Category L2-1", true],
        ["Category L12-34", true],
        ["Category L2-1 Lamps", false],
        ["Sub Category L2-1", false],
        ["Product 12", true],
        ["Product 1 Lamp", false],
        ["Lamp Product 1", false],
        ["Top Level Category", true],
        ["Second Top Level Category", true],
        ["Top Level Category Lamps", false],
        ["My Top Level Category", false],
        ["Subcategory A", true],
        ["Lamps Subcategory A", false],
        ["placeholder name", true],
        ["Not a Placeholder", false],
    ])("%s → %p", (name, expected) => {
        expect(isPlaceholder(name)).toBe(expected);
    });
});

describe("validateBlueprint — auto-fix options and logging", () => {
    afterEach(() => {
        mock.restore();
    });

    function recordInfos(): string[] {
        const infos: string[] = [];
        spyOn(logger, "info").mockImplementation((message: string, options?: LogOptions) => {
            infos.push(options?.cli === true ? message : `file: ${message}`);
        });
        return infos;
    }

    function duplicateBlueprint(): HydratedBlueprint {
        return createMockBlueprint({
            products: [
                createMockProduct({ id: "p1", name: "Same Name" }),
                createMockProduct({ id: "p2", name: "Same Name" }),
            ],
        });
    }

    test("does not rename duplicates without options", () => {
        const blueprint = duplicateBlueprint();
        const result = validateBlueprint(blueprint);

        expect(result.fixesApplied).toBe(0);
        expect(result.issues.map((i) => i.code)).toEqual(["DUPLICATE_PRODUCT_NAME"]);
        expect(blueprint.products.map((p) => p.name)).toEqual(["Same Name", "Same Name"]);
    });

    test("hasValidationIssues reports duplicates without renaming them", () => {
        const blueprint = duplicateBlueprint();

        expect(hasValidationIssues(blueprint)).toBe(true);
        expect(blueprint.products.map((p) => p.name)).toEqual(["Same Name", "Same Name"]);
    });

    test("logs each fix when auto-fixing (logFixes defaults to true)", () => {
        const infos = recordInfos();
        validateBlueprint(duplicateBlueprint(), { autoFix: true });

        expect(infos).toEqual([
            "Validating blueprint...",
            '  Fixed duplicate: "Same Name" → "Same Name (2)"',
            "  ✓ Fixed 1 duplicate product names",
        ]);
    });

    test("logs no fix summary when there is nothing to fix", () => {
        const infos = recordInfos();
        validateBlueprint(createMockBlueprint(), { autoFix: true });

        expect(infos).toEqual(["Validating blueprint..."]);
    });

    test("logs nothing with logFixes: false", () => {
        const infos = recordInfos();
        const result = validateBlueprint(duplicateBlueprint(), { autoFix: true, logFixes: false });

        expect(result.fixesApplied).toBe(1);
        expect(infos).toEqual([]);
    });

    test("logs nothing without auto-fix", () => {
        const infos = recordInfos();
        validateBlueprint(duplicateBlueprint(), { logFixes: true });

        expect(infos).toEqual([]);
    });
});

describe("isIncompleteHydration — issue type", () => {
    test("ignores incomplete-hydration codes that are only warnings", () => {
        const result: BlueprintValidationResult = {
            valid: true,
            issues: [{ type: "warning", code: "NO_PRODUCTS", message: "No products" }],
            fixesApplied: 0,
        };
        expect(isIncompleteHydration(result)).toBe(false);
    });
});
