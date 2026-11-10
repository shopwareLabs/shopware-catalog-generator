import { describe, expect, test } from "bun:test";

import type { CostEstimateInput } from "../../../src/blueprint/cost-estimator.js";
import type { ModelSelection, TranslationSource } from "../../../src/types/index.js";

import {
    estimateHydrationCost,
    estimateTranslationCost,
    estimateTranslationSource,
    formatCostEstimate,
    formatTranslationEstimate,
    priceTokenUsage,
} from "../../../src/blueprint/cost-estimator.js";
import { createTestCategory, createTestProduct } from "../../helpers/blueprint-factory.js";

const OPENAI_SELECTION: ModelSelection = {
    textProvider: "openai",
    textModel: "gpt-6-luna",
    imageProvider: "openai",
    imageModel: "gpt-image-1-mini",
    imageQuality: "low",
    imageFreeTier: false,
};

function createProducts(count: number, branchId: string): ReturnType<typeof createTestProduct>[] {
    return Array.from({ length: count }, (_, i) =>
        createTestProduct({ id: `${branchId}-p${i}`, primaryCategoryId: branchId })
    );
}

function createInput(overrides: Partial<CostEstimateInput> = {}): CostEstimateInput {
    return {
        scope: "full",
        blueprint: {
            categories: [
                createTestCategory({
                    id: "a",
                    hasImage: true,
                    children: [createTestCategory({ id: "a1" })],
                }),
                createTestCategory({ id: "b" }),
            ],
            products: [...createProducts(25, "a"), ...createProducts(5, "b")],
        },
        selection: OPENAI_SELECTION,
        cms: { pages: 8, slots: 20 },
        pendingImages: { cms: 20, product: 60, category: 1, theme: 3, variantColor: 0 },
        hasInspirationColors: false,
        ...overrides,
    };
}

describe("estimateHydrationCost", () => {
    test("counts product batches per branch (ceil per branch, not overall)", () => {
        const estimate = estimateHydrationCost(createInput());
        const products = estimate.text.items.find((i) => i.label === "Products");

        // Branch a: 25 -> 3 batches, branch b: 5 -> 1 batch
        expect(products?.calls).toBe(4);
    });

    test("full scope includes categories, brand colors, products, properties and CMS", () => {
        const labels = estimateHydrationCost(createInput()).text.items.map((i) => i.label);

        expect(labels).toEqual([
            "Categories",
            "Brand colors",
            "Products",
            "Property options",
            "CMS pages",
        ]);
    });

    test("skips the brand colors call when inspiration provides colors", () => {
        const estimate = estimateHydrationCost(createInput({ hasInspirationColors: true }));

        expect(estimate.text.items.map((i) => i.label)).not.toContain("Brand colors");
    });

    test("categories scope only estimates the category call and no images", () => {
        const estimate = estimateHydrationCost(createInput({ scope: "categories" }));

        expect(estimate.text.items.map((i) => i.label)).toEqual(["Categories"]);
        expect(estimate.text.calls).toBe(1);
        expect(estimate.images.count).toBe(0);
    });

    test("cms scope only counts CMS text and CMS images", () => {
        const estimate = estimateHydrationCost(createInput({ scope: "cms" }));

        expect(estimate.text.items.map((i) => i.label)).toEqual(["CMS pages"]);
        expect(estimate.images.count).toBe(20);
    });

    test("properties scope uses property batches instead of product content", () => {
        const labels = estimateHydrationCost(createInput({ scope: "properties" })).text.items.map(
            (i) => i.label
        );

        expect(labels).toEqual(["Product properties", "Property options"]);
    });

    test("prices images with the per-image list price for model and quality", () => {
        const estimate = estimateHydrationCost(createInput());

        expect(estimate.images.count).toBe(84);
        expect(estimate.images.unitUsd).toBe(0.006);
        expect(estimate.images.usd).toBeCloseTo(84 * 0.006, 6);
    });

    test("uses the higher price for medium quality", () => {
        const estimate = estimateHydrationCost(
            createInput({ selection: { ...OPENAI_SELECTION, imageQuality: "medium" } })
        );

        expect(estimate.images.unitUsd).toBe(0.015);
    });

    test("prices gpt-image-2.6 above 2.5 at medium quality (more output tokens)", () => {
        const priceFor = (imageModel: string): number | null =>
            estimateHydrationCost(
                createInput({
                    selection: { ...OPENAI_SELECTION, imageModel, imageQuality: "medium" },
                })
            ).images.unitUsd;

        expect(priceFor("gpt-image-2.5-flare")).toBe(0.0103);
        expect(priceFor("gpt-image-2.6-flare")).toBe(0.034);
        expect(priceFor("gpt-image-2.6-sunburst")).toBe(0.034);
    });

    test("has no price for the shut down gpt-image-1", () => {
        const estimate = estimateHydrationCost(
            createInput({ selection: { ...OPENAI_SELECTION, imageModel: "gpt-image-1" } })
        );

        expect(estimate.images.unitUsd).toBeNull();
    });

    test("total is the sum of text and image cost", () => {
        const estimate = estimateHydrationCost(createInput());

        expect(estimate.text.usd).not.toBeNull();
        expect(estimate.totalUsd).toBeCloseTo(
            (estimate.text.usd ?? 0) + (estimate.images.usd ?? 0),
            10
        );
    });

    test("scales the category call with the number of categories", () => {
        const small = estimateHydrationCost(createInput({ scope: "categories" }));
        const large = estimateHydrationCost(
            createInput({
                scope: "categories",
                blueprint: {
                    categories: Array.from({ length: 20 }, (_, i) =>
                        createTestCategory({ id: `c${i}` })
                    ),
                    products: [],
                },
            })
        );

        expect(large.text.inputTokens).toBeGreaterThan(small.text.inputTokens);
        expect(large.text.outputTokens).toBeGreaterThan(small.text.outputTokens);
    });

    test("prices dated snapshots like their base model", () => {
        const dated = estimateHydrationCost(
            createInput({
                selection: { ...OPENAI_SELECTION, textModel: "gpt-4.1-2025-04-14" },
            })
        );
        const base = estimateHydrationCost(
            createInput({ selection: { ...OPENAI_SELECTION, textModel: "gpt-4.1" } })
        );

        expect(dated.text.usd).toBe(base.text.usd);
    });

    test("reports unknown cost instead of guessing for models without price data", () => {
        const estimate = estimateHydrationCost(
            createInput({ selection: { ...OPENAI_SELECTION, textModel: "some-future-model" } })
        );

        expect(estimate.text.usd).toBeNull();
        expect(estimate.totalUsd).toBeNull();
        expect(estimate.notes.join(" ")).toContain("some-future-model");
    });

    test("Pollinations free tier images cost nothing", () => {
        const estimate = estimateHydrationCost(
            createInput({
                selection: {
                    textProvider: "pollinations",
                    textModel: "openai",
                    imageProvider: "pollinations",
                    imageModel: "flux",
                    imageFreeTier: true,
                },
            })
        );

        expect(estimate.images.usd).toBe(0);
        expect(estimate.text.usd).toBeNull();
    });

    test("disabled images produce no image items", () => {
        const estimate = estimateHydrationCost(
            createInput({
                selection: { ...OPENAI_SELECTION, imageProvider: "none", imageModel: undefined },
            })
        );

        expect(estimate.images.count).toBe(0);
        expect(estimate.images.usd).toBe(0);
    });
});

describe("estimateHydrationCost - variants", () => {
    const settings = { colors: 4, options: 3, maxVariants: 24, share: 0.5 };

    function variantProduct(id: string, colors: string[]): ReturnType<typeof createTestProduct> {
        return createTestProduct({
            id,
            metadata: {
                isVariant: true,
                properties: [],
                variantConfigs: [{ group: "Color", selectedOptions: colors, priceModifiers: {} }],
            },
        });
    }

    test("variants scope counts one call per 25 products missing colours", () => {
        const products = [
            ...Array.from({ length: 30 }, (_, i) => variantProduct(`v${i}`, ["Red"])),
            variantProduct("full", ["Red", "Navy", "Olive", "Sand"]),
        ];
        const estimate = estimateHydrationCost(
            createInput({
                scope: "variants",
                variants: settings,
                blueprint: { categories: [], products },
            })
        );

        expect(estimate.text.items.map((i) => i.label)).toEqual(["Variant colours"]);
        expect(estimate.text.items[0]?.calls).toBe(2);
        expect(estimate.images.count).toBe(0);
    });

    test("variants scope has no AI calls when every product has enough colours", () => {
        const estimate = estimateHydrationCost(
            createInput({
                scope: "variants",
                variants: { ...settings, colors: 2 },
                blueprint: { categories: [], products: [variantProduct("a", ["Red", "Navy"])] },
            })
        );

        expect(estimate.text.items).toHaveLength(0);
    });

    test("full scope notes the variant product count from the share", () => {
        const estimate = estimateHydrationCost(createInput({ variants: settings }));

        expect(estimate.notes).toContain(
            "Variants: 15 variant products (50% variant products, 4 colours, 3 options per other group, max 24 variants)."
        );
    });

    test("categories scope has no variant note", () => {
        const estimate = estimateHydrationCost(
            createInput({ scope: "categories", variants: settings })
        );

        expect(estimate.notes.some((n) => n.startsWith("Variants:"))).toBe(false);
    });
});

describe("estimateHydrationCost - variant colour images", () => {
    const withColors = (overrides: Partial<CostEstimateInput> = {}): CostEstimateInput =>
        createInput({
            pendingImages: { cms: 0, product: 0, category: 0, theme: 0, variantColor: 12 },
            ...overrides,
        });
    const variantItem = (input: CostEstimateInput) =>
        estimateHydrationCost(input).images.items.find((i) => i.label === "Variant colour images");

    test("counts colour images as edits in the full and variant-images scopes", () => {
        expect(variantItem(withColors())).toEqual({
            label: "Variant colour images",
            count: 12,
            edit: true,
        });
        expect(variantItem(withColors({ scope: "variant-images" }))?.count).toBe(12);
        expect(variantItem(withColors({ scope: "variants" }))?.count).toBe(0);
        expect(variantItem(withColors({ scope: "cms" }))?.count).toBe(0);
    });

    test("prices colour images with the edit price", () => {
        const estimate = estimateHydrationCost(withColors({ scope: "variant-images" }));

        expect(estimate.images.count).toBe(12);
        expect(estimate.images.editUnitUsd).not.toBeNull();
        expect(estimate.images.usd).toBeCloseTo(12 * (estimate.images.editUnitUsd ?? NaN), 6);
        expect(estimate.notes).toContain(
            "Variant colour images are priced like new images; edits also pay for the input image."
        );
    });

    test("shows the edit price per image in the formatted estimate", () => {
        const output = formatCostEstimate(
            estimateHydrationCost(withColors({ scope: "variant-images" }))
        ).join("\n");

        expect(output).toContain("Variant colour images");
        expect(output).toContain("(edits x $");
    });

    test("notes the upper bound in the full scope", () => {
        expect(estimateHydrationCost(withColors()).notes).toContain(
            "Variant colour images are an upper bound: not every variant product has colours."
        );
        expect(
            estimateHydrationCost(withColors({ scope: "variant-images" })).notes.some((n) =>
                n.includes("upper bound")
            )
        ).toBe(false);
    });

    test("notes that Pollinations skips colour images", () => {
        const estimate = estimateHydrationCost(
            withColors({
                pendingImages: { cms: 0, product: 0, category: 0, theme: 0, variantColor: 0 },
                selection: {
                    ...OPENAI_SELECTION,
                    imageProvider: "pollinations",
                    imageModel: "flux",
                    imageFreeTier: true,
                },
            })
        );

        expect(estimate.notes).toContain(
            "Variant colour images need image editing (OpenAI); skipped with Pollinations."
        );
    });
});

describe("priceTokenUsage", () => {
    test("prices actual usage with the model list price", () => {
        const usd = priceTokenUsage(OPENAI_SELECTION, {
            calls: 1,
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            reasoningTokens: 0,
        });

        expect(usd).toBeCloseTo(0.1 + 0.5, 10);
    });

    test("returns null for providers without price data", () => {
        const usd = priceTokenUsage(
            { ...OPENAI_SELECTION, textProvider: "pollinations", textModel: "openai" },
            { calls: 1, inputTokens: 10, outputTokens: 10, reasoningTokens: 0 }
        );

        expect(usd).toBeNull();
    });
});

describe("formatCostEstimate", () => {
    test("renders models, totals and the pricing date", () => {
        const output = formatCostEstimate(estimateHydrationCost(createInput())).join("\n");

        expect(output).toContain("gpt-6-luna");
        expect(output).toContain("gpt-image-1-mini (low quality)");
        expect(output).toContain("Estimated total: $");
        expect(output).toContain("List prices as of");
    });

    test("shows unknown instead of a dollar amount when prices are missing", () => {
        const estimate = estimateHydrationCost(
            createInput({ selection: { ...OPENAI_SELECTION, textModel: "mystery" } })
        );

        expect(formatCostEstimate(estimate).join("\n")).toContain("unknown (no price data)");
    });
});

describe("estimateTranslationCost", () => {
    const source: TranslationSource = {
        categories: { A: { name: "A", description: "Category A" } },
        products: Object.fromEntries(
            Array.from({ length: 25 }, (_, i) => [
                `p${i}`,
                { name: `Product ${i}`, description: "x".repeat(400) },
            ])
        ),
        propertyGroups: { Color: { name: "Color", options: ["Red"] } },
        reviews: { p0: [{ title: "Nice", content: "Works well" }] },
        cms: { Page: { "0.0.content": "<p>Hi</p>" } },
        fixtures: { "manufacturer.description": "{name} makes things." },
    };

    test("counts calls per content type and repeats them per locale", () => {
        const estimate = estimateTranslationCost(source, ["de-DE", "fr-FR"], OPENAI_SELECTION);

        // formality + terms + categories + 3 product batches + reviews + 1 CMS page + fixtures
        expect(estimate.locales.map((l) => l.calls)).toEqual([9, 9]);
        expect(estimate.inputTokens).toBe(2 * (estimate.locales[0]?.inputTokens ?? 0));
        expect(estimate.outputTokens).toBeGreaterThan(0);
        expect(estimate.usd).toBeGreaterThan(0);
    });

    test("unpriced models report unknown cost", () => {
        const estimate = estimateTranslationCost(source, ["de-DE"], {
            ...OPENAI_SELECTION,
            textModel: "some-future-model",
        });
        expect(estimate.usd).toBeNull();
    });

    test("formatTranslationEstimate prints one line per locale plus a total", () => {
        const lines = formatTranslationEstimate(
            estimateTranslationCost(source, ["de-DE"], OPENAI_SELECTION)
        );
        expect(lines[0]).toContain("Translation forecast");
        expect(lines.some((l) => l.includes("de-DE"))).toBe(true);
        expect(lines.at(-1)).toContain("Total");
        expect(
            formatTranslationEstimate(estimateTranslationCost(source, [], OPENAI_SELECTION))
        ).toEqual([]);
    });
});

describe("estimateTranslationSource", () => {
    test("builds typical texts for an unhydrated blueprint", () => {
        const products = createProducts(10, "cat-1");
        const source = estimateTranslationSource(
            {
                categories: [createTestCategory({ children: [createTestCategory({ id: "c2" })] })],
                products,
            },
            { cms: {}, fixtures: {}, reviews: {} }
        );

        expect(Object.keys(source.products)).toHaveLength(10);
        expect(Object.keys(source.categories)).toHaveLength(2);
        expect(source.products["cat-1-p0"]?.description.length).toBe(800);
        expect(source.propertyGroups.terms?.options).toHaveLength(7);
    });
});
