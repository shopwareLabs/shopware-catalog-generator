import { describe, expect, test } from "bun:test";

import type { ShopwareFilter } from "../../../src/shopware/api-helpers.js";
import type { BlueprintProduct, HydratedBlueprint } from "../../../src/types/index.js";
import type { FeatureCheck, FeatureCheckContext } from "../../e2e/checks/index.js";

import { ShopwareCapabilities } from "../../../src/shopware/index.js";
import { expectedVariantCounts } from "../../e2e/checks/catalog-checks.js";
import { FEATURE_CHECKS, runFeatureChecks, unsupportedReason } from "../../e2e/checks/index.js";
import { pass } from "../../e2e/checks/types.js";
import { createTestBlueprint, createTestProduct } from "../../helpers/blueprint-factory.js";
import { createMockDataCache } from "../../mocks/index.js";

type SearchHandler = (entity: string, filters: ShopwareFilter[]) => unknown[];

function createContext(
    overrides: Partial<FeatureCheckContext> & { search?: SearchHandler } = {}
): FeatureCheckContext {
    const { search = () => [], ...rest } = overrides;
    return {
        api: {
            searchEntities: async <T>(entity: string, filters: ShopwareFilter[] = []) =>
                search(entity, filters) as T[],
        },
        shopware: ShopwareCapabilities.fromVersion("6.7.10.0"),
        salesChannelId: "sc-1",
        salesChannelName: "test-store",
        blueprint: createTestBlueprint(),
        cache: createMockDataCache(),
        ...rest,
    };
}

function findCheck(name: string): FeatureCheck {
    const check = FEATURE_CHECKS.find((c) => c.name === name);
    if (!check) throw new Error(`check ${name} not registered`);
    return check;
}

function variantProduct(id: string, colors: string[], sizes: string[]): BlueprintProduct {
    return createTestProduct({
        id,
        name: id,
        metadata: {
            isVariant: true,
            imageDescriptions: [{ view: "front", prompt: "front" }],
            variantColors: colors.map((name) => ({ name, family: "blue" })),
            variantConfigs: [
                { group: "Color", selectedOptions: colors, priceModifiers: {} },
                { group: "Size", selectedOptions: sizes, priceModifiers: {} },
            ],
        },
    });
}

function blueprintWith(products: BlueprintProduct[]): HydratedBlueprint {
    return createTestBlueprint({ products });
}

describe("feature check gating", () => {
    const gated: FeatureCheck = {
        name: "gated",
        requires: "productOpenGraph",
        run: async () => pass("ran"),
    };

    test("skips a check on a Shopware version without the feature", async () => {
        const context = createContext({ shopware: ShopwareCapabilities.fromVersion("6.6.10.0") });

        const [result] = await runFeatureChecks([gated], context);

        expect(result?.status).toBe("skip");
        expect(result?.detail).toStartWith("needs Shopware 6.7.10.0+");
    });

    test("runs a check when the version supports the feature", async () => {
        const [result] = await runFeatureChecks([gated], createContext());

        expect(result).toEqual({ name: "gated", status: "pass", detail: "ran" });
    });

    test("an active feature flag enables a check before its release", () => {
        const check: FeatureCheck = { ...gated, requires: "productTypeRequired" };
        const devBuild = ShopwareCapabilities.fromVersion("6.7.9999999.9999999-dev", ["v6.8.0.0"]);

        expect(unsupportedReason(check, { shopware: devBuild })).toBeNull();
        expect(
            unsupportedReason(check, {
                shopware: ShopwareCapabilities.fromVersion("6.7.9999999.9999999-dev"),
            })
        ).not.toBeNull();
    });

    test("a failing query fails only its own check", async () => {
        const broken: FeatureCheck = {
            name: "broken",
            run: async () => {
                throw new Error("HTTP 500");
            },
        };

        const results = await runFeatureChecks(
            [broken, { ...gated, name: "next" }],
            createContext()
        );

        expect(results.map((r) => r.status)).toEqual(["fail", "pass"]);
        expect(results[0]?.detail).toBe("query failed: HTTP 500");
    });

    test("check names are unique", () => {
        const names = FEATURE_CHECKS.map((c) => c.name);
        expect(new Set(names).size).toBe(names.length);
    });
});

describe("expectedVariantCounts", () => {
    test("multiplies the option counts and ignores products without variants", () => {
        const blueprint = blueprintWith([
            variantProduct("p1", ["Navy", "Red"], ["S", "M", "L"]),
            createTestProduct({ id: "p2" }),
        ]);

        const counts = expectedVariantCounts({
            blueprint,
            cache: createMockDataCache(),
            salesChannelName: "test-store",
        });

        expect([...counts]).toEqual([["p1", { name: "p1", count: 6 }]]);
    });

    test("prefers the cached metadata, like the variants processor", () => {
        const blueprint = blueprintWith([variantProduct("p1", ["Navy", "Red"], ["S", "M"])]);
        const cache = createMockDataCache({
            metadataMap: new Map([
                [
                    "p1",
                    {
                        isVariant: true,
                        variantConfigs: [
                            { group: "Size", selectedOptions: ["S", "M", "L"], priceModifiers: {} },
                        ],
                    },
                ],
            ]),
        });

        const counts = expectedVariantCounts({ blueprint, cache, salesChannelName: "test-store" });

        expect(counts.get("p1")?.count).toBe(3);
    });
});

describe("variants check", () => {
    const check = findCheck("variants");

    test("fails when Shopware has fewer variants than the blueprint", async () => {
        const context = createContext({
            blueprint: blueprintWith([variantProduct("p1", ["Navy", "Red"], ["S", "M"])]),
            search: () => [{ id: "v1", parentId: "p1" }],
        });

        const outcome = await check.run(context);

        expect(outcome).toEqual({ status: "fail", detail: "wrong variant count: p1 1/4" });
    });

    test("skips a blueprint without variant products", async () => {
        const outcome = await check.run(createContext());

        expect(outcome.status).toBe("skip");
    });
});

describe("variant-images check", () => {
    const check = findCheck("variant-images");
    const blueprint = blueprintWith([variantProduct("p1", ["Navy", "Red"], ["S"])]);
    const cache = createMockDataCache({ cachedImages: new Set(["p1-front--red"]) });

    function searchWith(variantCover: string | null): SearchHandler {
        return (_entity, filters) => {
            if (filters.length === 0) return [{ id: "p1", coverId: "parent-cover" }];
            return [
                {
                    id: "v-navy",
                    parentId: "p1",
                    coverId: "parent-cover",
                    options: [{ name: "Navy" }],
                },
                { id: "v-red", parentId: "p1", coverId: variantCover, options: [{ name: "Red" }] },
            ];
        };
    }

    test("passes when every recoloured variant has its own cover", async () => {
        const outcome = await check.run(
            createContext({ blueprint, cache, search: searchWith("red-cover") })
        );

        expect(outcome).toEqual({
            status: "pass",
            detail: "1 colour variants with their own cover",
        });
    });

    test("fails when a recoloured variant still shows the parent image", async () => {
        const outcome = await check.run(
            createContext({ blueprint, cache, search: searchWith("parent-cover") })
        );

        expect(outcome.status).toBe("fail");
    });

    test("skips without cached colour images", async () => {
        const outcome = await check.run(createContext({ blueprint }));

        expect(outcome.status).toBe("skip");
    });
});

describe("media-showcase check", () => {
    const check = findCheck("media-showcase");

    function showcase(extensions: string[]): SearchHandler {
        return () => [
            { id: "m", media: extensions.map((fileExtension) => ({ media: { fileExtension } })) },
        ];
    }

    test("does not expect videos before Shopware 6.6.1", async () => {
        const context = createContext({
            shopware: ShopwareCapabilities.fromVersion("6.6.0.0"),
            search: showcase(["glb", "glb"]),
        });

        expect((await check.run(context)).status).toBe("pass");
    });

    test("expects videos on newer versions", async () => {
        const outcome = await check.run(createContext({ search: showcase(["glb", "glb"]) }));

        expect(outcome).toEqual({ status: "fail", detail: "missing mp4 files in the gallery" });
    });
});

describe("product-type check", () => {
    const check = findCheck("product-type");

    test("fails when a catalog product is not physical", async () => {
        const context = createContext({
            search: () => [
                { productNumber: "A", type: "physical" },
                { productNumber: "B", type: null },
                { productNumber: "GIFT-CARD-50", type: "digital" },
            ],
        });

        expect(await check.run(context)).toEqual({
            status: "fail",
            detail: '1/2 products are not "physical"',
        });
    });
});
