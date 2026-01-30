import { describe, expect, test } from "bun:test";

import {
    ProductDefinition,
    ProductReviewDefinition,
    PropertyGroupDefinition,
    PropertyOptionDefinition,
} from "../../src/types/index.js";

describe("ProductDefinition", () => {
    test("validates a valid product", () => {
        const product = {
            name: "Test Product",
            description: "A test product description",
            price: 29.99,
            stock: 100,
        };

        const result = ProductDefinition.safeParse(product);
        expect(result.success).toBe(true);
    });

    test("rejects product without name", () => {
        const product = {
            description: "A test product description",
            price: 29.99,
            stock: 100,
        };

        const result = ProductDefinition.safeParse(product);
        expect(result.success).toBe(false);
    });

    test("rejects product without description", () => {
        const product = {
            name: "Test Product",
            price: 29.99,
            stock: 100,
        };

        const result = ProductDefinition.safeParse(product);
        expect(result.success).toBe(false);
    });

    test("rejects product with non-numeric price", () => {
        const product = {
            name: "Test Product",
            description: "A test product description",
            price: "29.99",
            stock: 100,
        };

        const result = ProductDefinition.safeParse(product);
        expect(result.success).toBe(false);
    });

    test("rejects product with non-numeric stock", () => {
        const product = {
            name: "Test Product",
            description: "A test product description",
            price: 29.99,
            stock: "100",
        };

        const result = ProductDefinition.safeParse(product);
        expect(result.success).toBe(false);
    });

    test("accepts product with zero price", () => {
        const product = {
            name: "Free Product",
            description: "A free product",
            price: 0,
            stock: 50,
        };

        const result = ProductDefinition.safeParse(product);
        expect(result.success).toBe(true);
    });

    test("accepts product with decimal stock (coerced to number)", () => {
        const product = {
            name: "Test Product",
            description: "A test product description",
            price: 29.99,
            stock: 10.5,
        };

        const result = ProductDefinition.safeParse(product);
        expect(result.success).toBe(true);
    });
});

describe("PropertyOptionDefinition", () => {
    test("validates option with name only", () => {
        const option = { name: "Small" };

        const result = PropertyOptionDefinition.safeParse(option);
        expect(result.success).toBe(true);
    });

    test("validates option with name and colorHexCode", () => {
        const option = { name: "Red", colorHexCode: "#FF0000" };

        const result = PropertyOptionDefinition.safeParse(option);
        expect(result.success).toBe(true);
    });

    test("rejects option without name", () => {
        const option = { colorHexCode: "#FF0000" };

        const result = PropertyOptionDefinition.safeParse(option);
        expect(result.success).toBe(false);
    });
});

describe("PropertyGroupDefinition", () => {
    test("validates a complete property group", () => {
        const group = {
            name: "Color",
            description: "Product color options",
            displayType: "color",
            options: [
                { name: "Red", colorHexCode: "#FF0000" },
                { name: "Blue", colorHexCode: "#0000FF" },
            ],
        };

        const result = PropertyGroupDefinition.safeParse(group);
        expect(result.success).toBe(true);
    });

    test("validates a text display type group", () => {
        const group = {
            name: "Size",
            description: "Product size options",
            displayType: "text",
            options: [{ name: "Small" }, { name: "Medium" }, { name: "Large" }],
        };

        const result = PropertyGroupDefinition.safeParse(group);
        expect(result.success).toBe(true);
    });

    test("rejects invalid displayType", () => {
        const group = {
            name: "Invalid",
            description: "Invalid display type",
            displayType: "invalid",
            options: [{ name: "Option" }],
        };

        const result = PropertyGroupDefinition.safeParse(group);
        expect(result.success).toBe(false);
    });

    test("validates group with empty options array", () => {
        const group = {
            name: "Empty",
            description: "No options",
            displayType: "text",
            options: [],
        };

        const result = PropertyGroupDefinition.safeParse(group);
        expect(result.success).toBe(true);
    });

    test("rejects group without options", () => {
        const group = {
            name: "No Options",
            description: "Missing options array",
            displayType: "text",
        };

        const result = PropertyGroupDefinition.safeParse(group);
        expect(result.success).toBe(false);
    });
});

describe("ProductReviewDefinition", () => {
    test("validates a complete review", () => {
        const review = {
            externalUser: "John Doe",
            externalEmail: "john@example.com",
            title: "Great product",
            content: "Really enjoyed this product. Would recommend!",
            points: 5,
            status: true,
        };

        const result = ProductReviewDefinition.safeParse(review);
        expect(result.success).toBe(true);
    });

    test("rejects review with non-integer points", () => {
        const review = {
            externalUser: "John Doe",
            externalEmail: "john@example.com",
            title: "Great product",
            content: "Really enjoyed this product.",
            points: 4.5,
            status: true,
        };

        const result = ProductReviewDefinition.safeParse(review);
        expect(result.success).toBe(false);
    });

    test("accepts review with minimum points", () => {
        const review = {
            externalUser: "Jane Doe",
            externalEmail: "jane@example.com",
            title: "Not great",
            content: "Did not enjoy this product.",
            points: 1,
            status: true,
        };

        const result = ProductReviewDefinition.safeParse(review);
        expect(result.success).toBe(true);
    });

    test("rejects review without required fields", () => {
        const review = {
            title: "Incomplete review",
            content: "Missing fields",
        };

        const result = ProductReviewDefinition.safeParse(review);
        expect(result.success).toBe(false);
    });
});
