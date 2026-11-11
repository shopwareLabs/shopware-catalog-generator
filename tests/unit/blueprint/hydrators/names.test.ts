import { describe, expect, test } from "bun:test";

import type { BlueprintProduct } from "../../../../src/types/index.js";

import {
    findDuplicateNameProducts,
    hydrateProductNames,
    NAME_BATCH_SIZE,
    productNameKey,
    stripVariantValues,
} from "../../../../src/blueprint/hydrators/index.js";
import { createTestCategory, createTestProduct } from "../../../helpers/blueprint-factory.js";
import { MockTextProvider } from "../../../mocks/index.js";

const STORE = { name: "test-store", description: "Test store" };

function promptOf(provider: MockTextProvider, call = 0): string {
    return (
        provider
            .getCalls()
            [call]?.messages.map((m) => m.content)
            .join("\n") ?? ""
    );
}

function variantParent(name: string): BlueprintProduct {
    return createTestProduct({
        id: "parent",
        name,
        metadata: {
            isVariant: true,
            variantConfigs: [
                { group: "Color", selectedOptions: ["Black", "Burgundy"], priceModifiers: {} },
                { group: "Size", selectedOptions: ["500ml", "1L"], priceModifiers: {} },
            ],
            properties: [
                { group: "Color", value: "Black" },
                { group: "Size", value: "100 ml" },
                { group: "Material", value: "Leather" },
            ],
        },
    });
}

describe("productNameKey", () => {
    test("ignores spacing, punctuation, case and a (2) suffix", () => {
        expect(productNameKey("Cleaner - 750 ml")).toBe(productNameKey("cleaner - 750ml"));
        expect(productNameKey("Cream - Fragrance-Free")).toBe(
            productNameKey("Cream - Fragrance Free")
        );
        expect(productNameKey("Detergent (3)")).toBe(productNameKey("Detergent"));
        expect(productNameKey("Cleaner - 750ml")).not.toBe(productNameKey("Cleaner - 500ml"));
    });
});

describe("stripVariantValues", () => {
    test("drops options and the parent's own value of a variant group", () => {
        expect(stripVariantValues(variantParent("Ankle Boots - Black - Block Heel"))).toBe(
            "Ankle Boots - Block Heel"
        );
        expect(stripVariantValues(variantParent("Lotion - SPF 30 - 100ml"))).toBe(
            "Lotion - SPF 30"
        );
    });

    test("keeps the product type and values of other groups", () => {
        expect(stripVariantValues(variantParent("Black - Leather"))).toBe("Black - Leather");
    });

    test("leaves products without variants alone", () => {
        const product = createTestProduct({ name: "Ankle Boots - Black" });
        expect(stripVariantValues(product)).toBe("Ankle Boots - Black");
    });
});

describe("findDuplicateNameProducts", () => {
    test("returns every product after the first of each name", () => {
        const products = [
            createTestProduct({ id: "a", name: "Cleaner - 750 ml" }),
            createTestProduct({ id: "b", name: "Cleaner - 750ml" }),
            createTestProduct({ id: "c", name: "Sponge" }),
            createTestProduct({ id: "d", name: "Cleaner - 750ml" }),
        ];
        expect(findDuplicateNameProducts(products).map((p) => p.id)).toEqual(["b", "d"]);
    });
});

describe("hydrateProductNames", () => {
    const leaf = createTestCategory({ id: "leaf", name: "Guitars", level: 2 });
    const categories = [createTestCategory({ id: "top", name: "Instruments", children: [leaf] })];

    test("renames duplicates and sends the taken names, properties and description", async () => {
        const provider = new MockTextProvider();
        provider.setResponse("ProductNames", {
            names: [{ index: 1, name: "Acoustic Guitar - Full Size" }],
        });
        const products = [
            createTestProduct({ id: "a", name: "Acoustic Guitar - Dreadnought" }),
            createTestProduct({
                id: "b",
                name: "Acoustic Guitar - Dreadnought",
                categoryIds: ["top", "leaf"],
                description: "<p>A full size guitar.</p>",
                metadata: { properties: [{ group: "Size", value: "Full Size" }] },
            }),
        ];

        const result = await hydrateProductNames(provider, { categories, products }, STORE);

        expect(result.products.map((p) => p.name)).toEqual([
            "Acoustic Guitar - Dreadnought",
            "Acoustic Guitar - Full Size",
        ]);
        expect(result).toMatchObject({ cleaned: 0, renamed: 1, stillDuplicate: 0 });
        const prompt = promptOf(provider);
        expect(prompt).toContain("- Acoustic Guitar - Dreadnought");
        expect(prompt).toContain(
            "1. Acoustic Guitar - Dreadnought | category: Guitars | properties: Size: Full Size"
        );
        expect(prompt).toContain("description: A full size guitar.");
    });

    test("cleans variant parents without an AI call when no name is taken", async () => {
        const provider = new MockTextProvider();

        const result = await hydrateProductNames(
            provider,
            { categories, products: [variantParent("Ankle Boots - Black - Block Heel")] },
            STORE
        );

        expect(result.products[0]?.name).toBe("Ankle Boots - Block Heel");
        expect(result.cleaned).toBe(1);
        expect(provider.callCount).toBe(0);
    });

    test("keeps the old name when the AI proposes a taken one or fails", async () => {
        const provider = new MockTextProvider();
        provider.setResponse("ProductNames", { names: [{ index: 1, name: "Sponge" }] });
        const products = [
            createTestProduct({ id: "a", name: "Cleaner" }),
            createTestProduct({ id: "b", name: "Cleaner" }),
            createTestProduct({ id: "c", name: "Sponge" }),
        ];

        const taken = await hydrateProductNames(provider, { categories, products }, STORE);
        expect(taken.products[1]?.name).toBe("Cleaner");
        expect(taken).toMatchObject({ renamed: 0, stillDuplicate: 1 });

        const failing = new MockTextProvider();
        failing.setRawResponse("ProductNames", "not json");
        const failed = await hydrateProductNames(failing, { categories, products }, STORE);
        expect(failed.products.map((p) => p.name)).toEqual(["Cleaner", "Cleaner", "Sponge"]);
    });

    test("makes one call per batch of duplicates", async () => {
        const provider = new MockTextProvider();
        provider.setResponse("ProductNames", { names: [] });
        const products = Array.from({ length: NAME_BATCH_SIZE + 2 }, (_, i) =>
            createTestProduct({ id: `p-${i}`, name: "Same Name" })
        );

        await hydrateProductNames(provider, { categories, products }, STORE);

        expect(provider.callCount).toBe(2);
    });
});
