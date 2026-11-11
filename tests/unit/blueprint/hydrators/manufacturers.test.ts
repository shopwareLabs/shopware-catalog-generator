import { describe, expect, test } from "bun:test";

import type { BlueprintProduct } from "../../../../src/types/index.js";

import { hydrateManufacturers } from "../../../../src/blueprint/hydrators/index.js";
import { createTestCategory, createTestProduct } from "../../../helpers/blueprint-factory.js";
import { MockTextProvider } from "../../../mocks/index.js";

const STORE = { name: "music", description: "Musical instruments" };

const categories = [
    createTestCategory({ id: "guitars", name: "Guitars" }),
    createTestCategory({ id: "drums", name: "Drums" }),
];

function product(id: string, branch: string, brand: string): BlueprintProduct {
    return createTestProduct({
        id,
        name: `Product ${id}`,
        primaryCategoryId: branch,
        categoryIds: [branch],
        metadata: { manufacturerName: brand },
    });
}

const products = [
    product("a", "guitars", "Artisan Home"),
    product("b", "guitars", "Premium Craft"),
    product("c", "guitars", "Artisan Home"),
    product("d", "drums", "Modern Works"),
];

function brandsOf(result: { products: BlueprintProduct[] }): Array<string | undefined> {
    return result.products.map((p) => p.metadata.manufacturerName);
}

describe("hydrateManufacturers", () => {
    test("maps each placeholder brand of a branch to one new brand", async () => {
        const provider = new MockTextProvider();
        provider.setResponse("Manufacturers", {
            branches: [
                { index: 1, brands: ["Fretwood", "Maple & String"] },
                { index: 2, brands: ["Thunderskin"] },
            ],
        });

        const result = await hydrateManufacturers(provider, { categories, products }, STORE);

        expect(brandsOf(result)).toEqual(["Fretwood", "Maple & String", "Fretwood", "Thunderskin"]);
        expect(result.branches).toBe(2);
        expect(result.manufacturers).toEqual(["Fretwood", "Maple & String", "Thunderskin"]);
        const prompt =
            provider
                .getCalls()[0]
                ?.messages.map((m) => m.content)
                .join("\n") ?? "";
        expect(prompt).toContain(
            "1. Guitars | 2 brands | products: Product a; Product b; Product c"
        );
        expect(prompt).toContain("2. Drums | 1 brands");
        expect(provider.callCount).toBe(1);
    });

    test("keeps a branch's brands when the AI returns too few unique ones", async () => {
        const provider = new MockTextProvider();
        provider.setResponse("Manufacturers", {
            branches: [
                { index: 1, brands: ["Fretwood", "fretwood"] },
                { index: 2, brands: ["Fretwood"] },
            ],
        });

        const result = await hydrateManufacturers(provider, { categories, products }, STORE);

        expect(brandsOf(result)).toEqual([
            "Artisan Home",
            "Premium Craft",
            "Artisan Home",
            "Fretwood",
        ]);
        expect(result.branches).toBe(1);
    });

    test("keeps all brands when the AI call fails", async () => {
        const provider = new MockTextProvider();
        provider.setRawResponse("Manufacturers", "not json");

        const result = await hydrateManufacturers(provider, { categories, products }, STORE);

        expect(brandsOf(result)).toEqual(brandsOf({ products }));
        expect(result.branches).toBe(0);
    });

    test("makes no call when no product has a brand", async () => {
        const provider = new MockTextProvider();
        const plain = [createTestProduct({ id: "x", metadata: { manufacturerName: undefined } })];

        const result = await hydrateManufacturers(provider, { categories, products: plain }, STORE);

        expect(provider.callCount).toBe(0);
        expect(result.products).toBe(plain);
    });
});
