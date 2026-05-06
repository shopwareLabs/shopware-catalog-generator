import { describe, expect, test } from "bun:test";

import type { BlueprintCategory, BlueprintProduct } from "../../../src/types/index.js";

import {
    findPlaceholderCategories,
    findPlaceholderProducts,
} from "../../../src/blueprint/fix-placeholders.js";

function makeCategory(name: string, children: BlueprintCategory[] = []): BlueprintCategory {
    return { id: name, name, description: "", level: 1, hasImage: false, children };
}

function makeProduct(name: string): BlueprintProduct {
    return {
        id: name,
        name,
        description: "",
        price: 0,
        stock: 0,
        primaryCategoryId: "",
        categoryIds: [],
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
            weight: 1,
            width: 1,
            height: 1,
            length: 1,
            ean: "",
            manufacturerNumber: "",
        },
    };
}

describe("findPlaceholderCategories", () => {
    test("detects Top Category N pattern", () => {
        const cats = [makeCategory("Top Category 1"), makeCategory("Sofas")];
        const result = findPlaceholderCategories(cats);
        expect(result).toHaveLength(1);
        expect(result[0]?.name).toBe("Top Category 1");
    });

    test("detects Category L2-1 pattern", () => {
        const cats = [makeCategory("Category L2-1"), makeCategory("Chairs")];
        const result = findPlaceholderCategories(cats);
        expect(result[0]?.name).toBe("Category L2-1");
    });

    test("detects Category L3-4 pattern", () => {
        const cats = [makeCategory("Category L3-4")];
        expect(findPlaceholderCategories(cats)).toHaveLength(1);
    });

    test("detects Product N pattern", () => {
        const cats = [makeCategory("Product 42")];
        expect(findPlaceholderCategories(cats)).toHaveLength(1);
    });

    test("detects Top Level Category variants", () => {
        const cats = [
            makeCategory("Top Level Category"),
            makeCategory("First Top Level Category"),
            makeCategory("Second Top Level Category"),
        ];
        expect(findPlaceholderCategories(cats)).toHaveLength(3);
    });

    test("detects Subcategory A–Z pattern", () => {
        const cats = [makeCategory("Subcategory A"), makeCategory("Subcategory Z")];
        expect(findPlaceholderCategories(cats)).toHaveLength(2);
    });

    test("returns empty array when no placeholders", () => {
        const cats = [makeCategory("Sofas"), makeCategory("Outdoor Chairs")];
        expect(findPlaceholderCategories(cats)).toHaveLength(0);
    });

    test("traverses nested children", () => {
        const child = makeCategory("Category L3-1");
        const parent = makeCategory("Sofas", [child]);
        const result = findPlaceholderCategories([parent]);
        expect(result).toHaveLength(1);
        expect(result[0]?.name).toBe("Category L3-1");
    });

    test("finds placeholders at multiple nesting levels", () => {
        const deep = makeCategory("Top Category 99");
        const mid = makeCategory("Category L2-2", [deep]);
        const root = makeCategory("Real Category", [mid]);
        const result = findPlaceholderCategories([root]);
        expect(result.map((c) => c.name)).toContain("Top Category 99");
        expect(result.map((c) => c.name)).toContain("Category L2-2");
    });

    test("returns empty when categories array is empty", () => {
        expect(findPlaceholderCategories([])).toHaveLength(0);
    });
});

describe("findPlaceholderProducts", () => {
    test("detects Product N pattern", () => {
        const products = [makeProduct("Product 1"), makeProduct("Oslo Sofa")];
        const result = findPlaceholderProducts(products);
        expect(result).toHaveLength(1);
        expect(result[0]?.name).toBe("Product 1");
    });

    test("returns all placeholders", () => {
        const products = [
            makeProduct("Product 1"),
            makeProduct("Product 2"),
            makeProduct("Real Name"),
        ];
        expect(findPlaceholderProducts(products)).toHaveLength(2);
    });

    test("returns empty when no placeholders", () => {
        const products = [makeProduct("Trail Runner X"), makeProduct("Canvas Backpack")];
        expect(findPlaceholderProducts(products)).toHaveLength(0);
    });

    test("returns empty for empty array", () => {
        expect(findPlaceholderProducts([])).toHaveLength(0);
    });

    test("does not match partial placeholder name", () => {
        const products = [makeProduct("Product 1 Special Edition")];
        expect(findPlaceholderProducts(products)).toHaveLength(0);
    });
});
