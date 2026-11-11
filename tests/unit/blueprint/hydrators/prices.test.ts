import { describe, expect, test } from "bun:test";

import type { BlueprintProduct, ProductPackaging } from "../../../../src/types/index.js";

import {
    hydratePrices,
    normalizePriceRange,
    PRICE_BATCH_SIZE,
    rollPrice,
    toShopPrice,
} from "../../../../src/blueprint/hydrators/index.js";
import { createTestCategory, createTestProduct } from "../../../helpers/blueprint-factory.js";
import { MockTextProvider } from "../../../mocks/index.js";

const STORE = { name: "test-store", description: "Test store" };

const ROLL: ProductPackaging = {
    unitShortCode: "m",
    unitName: "Meter",
    purchaseUnit: 5,
    referenceUnit: 1,
    packUnit: "Roll",
    packUnitPlural: "Rolls",
};

function promptOf(provider: MockTextProvider, call = 0): string {
    return (
        provider
            .getCalls()
            [call]?.messages.map((m) => m.content)
            .join("\n") ?? ""
    );
}

describe("toShopPrice", () => {
    test("ends in .99 below 100", () => {
        expect(toShopPrice(7.4)).toBe(6.99);
        expect(toShopPrice(7.6)).toBe(7.99);
        expect(toShopPrice(0.2)).toBe(0.99);
        expect(toShopPrice(99.4)).toBe(98.99);
    });

    test("uses steps of 5 from 100 and steps of 10 from 1000", () => {
        expect(toShopPrice(148)).toBe(149.99);
        expect(toShopPrice(1243)).toBe(1239.99);
    });
});

describe("normalizePriceRange", () => {
    test("orders min and max and rounds to cents", () => {
        expect(normalizePriceRange(20.456, 5)).toEqual({ min: 5, max: 20.46 });
    });

    test("rejects zero, negative and non-finite ranges", () => {
        expect(normalizePriceRange(0, 10)).toBeNull();
        expect(normalizePriceRange(-5, 10)).toBeNull();
        expect(normalizePriceRange(Number.NaN, 10)).toBeNull();
        expect(normalizePriceRange(5, Number.POSITIVE_INFINITY)).toBeNull();
    });
});

describe("rollPrice", () => {
    test("is deterministic per product and stays near the range", () => {
        const range = { min: 4, max: 12 };
        const prices = Array.from({ length: 200 }, (_, i) => rollPrice(`p-${i}`, range));
        expect(rollPrice("p-1", range)).toBe(rollPrice("p-1", range));
        for (const price of prices) {
            expect(price).toBeGreaterThanOrEqual(2.99);
            expect(price).toBeLessThanOrEqual(11.99);
        }
        expect(new Set(prices).size).toBeGreaterThan(3);
    });
});

describe("hydratePrices", () => {
    const leaf = createTestCategory({ id: "leaf", name: "Ear Protection", level: 2 });
    const top = createTestCategory({ id: "top", name: "Health", children: [leaf] });

    test("prices products inside the AI range and marks products with a pack", async () => {
        const provider = new MockTextProvider();
        provider.setResponse("PriceRanges", {
            prices: [
                { index: 1, min: 3, max: 6 },
                { index: 2, min: 400, max: 900 },
            ],
        });
        const earplugs = createTestProduct({
            id: "a",
            name: "Foam Earplugs",
            price: 243,
            categoryIds: ["top", "leaf"],
            metadata: {
                packaging: {
                    unitShortCode: "pc",
                    unitName: "Piece",
                    purchaseUnit: 20,
                    referenceUnit: 1,
                    packUnit: "Pack",
                    packUnitPlural: "Packs",
                },
            },
        });
        const monitor = createTestProduct({ id: "b", name: "Hearing Monitor", price: 12 });

        const result = await hydratePrices(
            provider,
            { categories: [top], products: [earplugs, monitor] },
            STORE
        );

        expect(result.priced).toBe(2);
        expect(result.products[0]?.price).toBeLessThanOrEqual(5.99);
        expect(result.products[0]?.price).toBe(rollPrice("a", { min: 3, max: 6 }));
        expect(result.products[1]?.price).toBeGreaterThanOrEqual(399.99);
        const prompt = promptOf(provider);
        expect(prompt).toContain('Store: "test-store"');
        expect(prompt).toContain("1. Foam Earplugs | category: Ear Protection | pack?");
        expect(prompt).toContain("2. Hearing Monitor");
        expect(prompt).not.toContain("Hearing Monitor | pack?");
        // The random current pack is not shown, it would anchor the answer
        expect(prompt).not.toContain("pack: Pack");
    });

    test("keeps, switches or drops the pack the AI returns", async () => {
        const provider = new MockTextProvider();
        provider.setResponse("PriceRanges", {
            prices: [
                { index: 1, min: 10, max: 20, pack: "Pair (2 Piece)" },
                { index: 2, min: 10, max: 20, pack: null },
                { index: 3, min: 10, max: 20, pack: "Crate" },
                { index: 4, min: 10, max: 20, pack: "Box" },
                { index: 5, min: 10, max: 20, pack: "none" },
                { index: 6, min: 10, max: 20 },
            ],
        });
        const packed = (id: string): BlueprintProduct =>
            createTestProduct({ id, metadata: { packaging: { ...ROLL } } });
        const products = [
            packed("a"),
            packed("b"),
            packed("c"),
            createTestProduct({ id: "d" }),
            packed("e"),
            packed("f"),
        ];

        const result = await hydratePrices(provider, { categories: [top], products }, STORE);

        const packs = result.products.map((p) => p.metadata.packaging?.packUnit);
        expect(packs).toEqual(["Pair", undefined, "Roll", undefined, undefined, "Roll"]);
        expect(result.products[0]?.metadata.packaging).toMatchObject({
            unitShortCode: "pc",
            unitName: "Piece",
            purchaseUnit: 2,
        });
        expect(result.repacked).toBe(3);
        expect(promptOf(provider)).toContain("Pair (2 Piece), Set (3 Piece)");
    });

    test("keeps the price of products the AI skipped or gave an invalid range", async () => {
        const provider = new MockTextProvider();
        provider.setResponse("PriceRanges", {
            prices: [
                { index: 2, min: 0, max: 10 },
                { index: 9, min: 1, max: 2 },
            ],
        });
        const products = [
            createTestProduct({ id: "a", price: 50 }),
            createTestProduct({ id: "b", price: 60 }),
        ];

        const result = await hydratePrices(provider, { categories: [], products }, STORE);

        expect(result.priced).toBe(0);
        expect(result.products.map((p) => p.price)).toEqual([50, 60]);
    });

    test("keeps all prices when the response is not usable", async () => {
        const provider = new MockTextProvider();
        provider.setRawResponse("PriceRanges", "not json");
        const products = [createTestProduct({ id: "a", price: 50 })];

        const result = await hydratePrices(provider, { categories: [], products }, STORE);

        expect(result.products[0]?.price).toBe(50);
    });

    test("makes one call per batch with indexes local to the batch", async () => {
        const provider = new MockTextProvider();
        provider.setResponse("PriceRanges", { prices: [{ index: 1, min: 10, max: 20 }] });
        const products = Array.from({ length: PRICE_BATCH_SIZE + 1 }, (_, i) =>
            createTestProduct({ id: `p-${i}`, name: `Item ${i}`, price: 500 })
        );

        const result = await hydratePrices(provider, { categories: [], products }, STORE);

        expect(provider.callCount).toBe(2);
        expect(promptOf(provider, 1)).toContain(`1. Item ${PRICE_BATCH_SIZE}`);
        expect(result.priced).toBe(2);
        expect(result.products[0]?.price).toBeLessThan(20);
        expect(result.products[PRICE_BATCH_SIZE]?.price).toBeLessThan(20);
        expect(result.products[1]?.price).toBe(500);
    });
});
