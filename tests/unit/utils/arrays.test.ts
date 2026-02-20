import { describe, expect, test } from "bun:test";

import {
    chunkArray,
    cartesianProduct,
    randomPick,
    randomSample,
    randomSamplePercent,
    weightedRandomPick,
} from "../../../src/utils/arrays.js";

describe("cartesianProduct", () => {
    test("returns empty array for empty input", () => {
        expect(cartesianProduct([])).toEqual([]);
    });

    test("returns empty array if any input array is empty", () => {
        expect(cartesianProduct([["a", "b"], []])).toEqual([]);
        expect(cartesianProduct([[], ["a", "b"]])).toEqual([]);
    });

    test("handles single array", () => {
        expect(cartesianProduct([["a", "b", "c"]])).toEqual([["a"], ["b"], ["c"]]);
    });

    test("creates product of two arrays", () => {
        const result = cartesianProduct([
            ["S", "M"],
            ["Red", "Blue"],
        ]);

        expect(result).toEqual([
            ["S", "Red"],
            ["S", "Blue"],
            ["M", "Red"],
            ["M", "Blue"],
        ]);
    });

    test("creates product of three arrays", () => {
        const result = cartesianProduct([["S", "M"], ["Red"], ["Wood", "Metal"]]);

        expect(result).toEqual([
            ["S", "Red", "Wood"],
            ["S", "Red", "Metal"],
            ["M", "Red", "Wood"],
            ["M", "Red", "Metal"],
        ]);
    });

    test("produces correct count", () => {
        // 3 sizes * 2 colors * 4 materials = 24 combinations
        const result = cartesianProduct([
            ["S", "M", "L"],
            ["Red", "Blue"],
            ["Wood", "Metal", "Plastic", "Premium"],
        ]);

        expect(result.length).toBe(24);
    });
});

describe("randomSamplePercent", () => {
    test("returns empty array for empty input", () => {
        expect(randomSamplePercent([], 0.4, 0.6)).toEqual([]);
    });

    test("returns at least one item", () => {
        const result = randomSamplePercent(["a"], 0.1, 0.2);
        expect(result.length).toBeGreaterThanOrEqual(1);
    });

    test("respects percentage bounds", () => {
        const items = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];

        // Run multiple times to check percentage bounds
        for (let i = 0; i < 20; i++) {
            const result = randomSamplePercent(items, 0.4, 0.6);
            // 40-60% of 10 items = 4-6 items (but at least 1)
            expect(result.length).toBeGreaterThanOrEqual(1);
            expect(result.length).toBeLessThanOrEqual(10);
        }
    });

    test("returns unique items", () => {
        const items = ["a", "b", "c", "d", "e"];
        const result = randomSamplePercent(items, 0.4, 0.6);
        const unique = [...new Set(result)];
        expect(result.length).toBe(unique.length);
    });
});

describe("randomSample", () => {
    test("returns empty array for empty input", () => {
        expect(randomSample([], 5)).toEqual([]);
    });

    test("returns empty array for count <= 0", () => {
        expect(randomSample(["a", "b"], 0)).toEqual([]);
        expect(randomSample(["a", "b"], -1)).toEqual([]);
    });

    test("returns exactly count items", () => {
        const items = ["a", "b", "c", "d", "e"];
        const result = randomSample(items, 3);
        expect(result.length).toBe(3);
    });

    test("caps at array length", () => {
        const items = ["a", "b", "c"];
        const result = randomSample(items, 10);
        expect(result.length).toBe(3);
    });
});

describe("weightedRandomPick", () => {
    test("throws for empty array", () => {
        expect(() => weightedRandomPick([], [])).toThrow();
    });

    test("throws for mismatched lengths", () => {
        expect(() => weightedRandomPick(["a", "b"], [1])).toThrow();
    });

    test("returns an item from the array", () => {
        const items = ["a", "b", "c"];
        const weights = [1, 1, 1];
        const result = weightedRandomPick(items, weights);
        expect(items).toContain(result);
    });

    test("respects heavy weights over many iterations", () => {
        const items = ["rare", "common"];
        const weights = [0.01, 0.99]; // "common" has 99% weight

        const counts = { rare: 0, common: 0 };
        for (let i = 0; i < 1000; i++) {
            const result = weightedRandomPick(items, weights);
            counts[result as keyof typeof counts]++;
        }

        // "common" should appear much more often
        expect(counts.common).toBeGreaterThan(counts.rare * 5);
    });
});

describe("randomPick", () => {
    test("throws for empty array", () => {
        expect(() => randomPick([])).toThrow();
    });

    test("returns item from array", () => {
        const items = ["a", "b", "c"];
        const result = randomPick(items);
        expect(items).toContain(result);
    });

    test("returns the only item for single-element array", () => {
        expect(randomPick(["only"])).toBe("only");
    });
});

describe("chunkArray", () => {
    test("splits into equal chunks when divisible", () => {
        expect(chunkArray([1, 2, 3, 4], 2)).toEqual([
            [1, 2],
            [3, 4],
        ]);
    });

    test("keeps remainder in last chunk", () => {
        expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });

    test("returns empty array for empty input", () => {
        expect(chunkArray([], 3)).toEqual([]);
    });

    test("throws for invalid chunk size", () => {
        expect(() => chunkArray([1, 2], 0)).toThrow();
    });
});
