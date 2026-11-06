import { describe, expect, test } from "bun:test";

import { buildProductReviews } from "../../../src/fixtures/review-data.js";

describe("buildProductReviews", () => {
    test("is deterministic per product", () => {
        expect(buildProductReviews("p1", "Desk Lamp", 5)).toEqual(
            buildProductReviews("p1", "Desk Lamp", 5)
        );
    });

    test("differs between products", () => {
        expect(buildProductReviews("p1", "Desk Lamp", 5)).not.toEqual(
            buildProductReviews("p2", "Desk Lamp", 5)
        );
    });

    test("returns the requested count, none for zero or negative", () => {
        expect(buildProductReviews("p1", "Desk Lamp", 3)).toHaveLength(3);
        expect(buildProductReviews("p1", "Desk Lamp", 0)).toEqual([]);
        expect(buildProductReviews("p1", "Desk Lamp", -2)).toEqual([]);
    });

    test("fills the product type and keeps ratings in range", () => {
        const reviews = buildProductReviews("p1", "Desk Lamp - Brass", 10);
        for (const review of reviews) {
            expect(review.rating).toBeGreaterThanOrEqual(1);
            expect(review.rating).toBeLessThanOrEqual(5);
            expect(review.content).not.toContain("{productType}");
            expect(review.email).toMatch(/@example\.com$/);
        }
    });

    test("a longer list starts with the shorter list (indexes stay aligned)", () => {
        const short = buildProductReviews("p1", "Desk Lamp", 2);
        const long = buildProductReviews("p1", "Desk Lamp", 4);
        expect(long.slice(0, 2)).toEqual(short);
    });
});
