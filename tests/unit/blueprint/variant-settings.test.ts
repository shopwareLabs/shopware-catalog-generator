import { describe, expect, test } from "bun:test";

import type { VariantConfig, VariantSettings } from "../../../src/types/index.js";

import {
    assignVariantProducts,
    blueprintVariantSettings,
    capVariantConfigs,
    countVariants,
    formatVariantSettings,
    hasVariantOverrides,
    missingColorCount,
    pickOptions,
    pickPreferredOptions,
    productDefaultColor,
    productsMissingColors,
    repickVariantConfigs,
    resolveVariantSettings,
    VariantSettingsError,
} from "../../../src/blueprint/variant-settings.js";
import { DEFAULT_VARIANT_SETTINGS } from "../../../src/types/index.js";
import { createTestProduct } from "../../helpers/blueprint-factory.js";

function config(group: string, options: string[]): VariantConfig {
    return {
        group,
        selectedOptions: options,
        priceModifiers: Object.fromEntries(options.map((o) => [o, 1.1])),
    };
}

const COLORS = ["Navy", "Red", "Olive", "Sand", "Black", "White", "Teal", "Plum"];
const SIZES = ["XS", "S", "M", "L", "XL", "XXL"];

describe("resolveVariantSettings", () => {
    test("returns the defaults without flags or env vars", () => {
        expect(resolveVariantSettings({}, {})).toEqual(DEFAULT_VARIANT_SETTINGS);
    });

    test("flag beats env var beats base", () => {
        const base: VariantSettings = { colors: 5, options: 4, maxVariants: 30, share: 0.5 };
        const settings = resolveVariantSettings(
            { colors: "8" },
            { VARIANT_COLORS: "6", VARIANT_OPTIONS: "2" },
            base
        );

        expect(settings).toEqual({ colors: 8, options: 2, maxVariants: 30, share: 0.5 });
    });

    test("ignores empty env vars", () => {
        expect(resolveVariantSettings({}, { MAX_VARIANTS: " " }).maxVariants).toBe(24);
    });

    test("accepts numbers (MCP) and decimal shares", () => {
        expect(resolveVariantSettings({ share: 0.25, maxVariants: 100 }, {})).toMatchObject({
            share: 0.25,
            maxVariants: 100,
        });
    });

    test.each([
        [{ colors: "1" }, '--variant-colors must be a whole number between 2 and 12 (got "1")'],
        [{ options: "3.5" }, "--variant-options must be a whole number between 2 and 8"],
        [{ maxVariants: "abc" }, "--max-variants must be a whole number between 4 and 100"],
        [{ share: "1.5" }, "--variant-share must be a number between 0 and 1"],
        [{ colors: "" }, "--variant-colors must be a whole number"],
    ])("rejects %p", (overrides, message) => {
        expect(() => resolveVariantSettings(overrides, {})).toThrow(VariantSettingsError);
        expect(() => resolveVariantSettings(overrides, {})).toThrow(message);
    });

    test("names the env var in the error", () => {
        expect(() => resolveVariantSettings({}, { VARIANT_SHARE: "-1" })).toThrow(
            "VARIANT_SHARE must be a number between 0 and 1"
        );
    });
});

describe("helpers", () => {
    test("hasVariantOverrides is false for an empty object", () => {
        expect(hasVariantOverrides({})).toBe(false);
        expect(hasVariantOverrides({ colors: 4 })).toBe(true);
    });

    test("blueprintVariantSettings falls back to the defaults for older blueprints", () => {
        expect(blueprintVariantSettings({})).toEqual(DEFAULT_VARIANT_SETTINGS);
        const stored = { colors: 6, options: 2, maxVariants: 12, share: 0.5 };
        expect(blueprintVariantSettings({ variants: stored })).toBe(stored);
    });

    test("formatVariantSettings is one line", () => {
        expect(formatVariantSettings(DEFAULT_VARIANT_SETTINGS)).toBe(
            "30% variant products, 4 colours, 3 options per other group, max 24 variants"
        );
    });
});

describe("assignVariantProducts", () => {
    const products = Array.from({ length: 90 }, (_, i) => createTestProduct({ id: `p-${i}` }));

    test("marks exactly round(n x share) products", () => {
        assignVariantProducts(products, 0.3);
        expect(products.filter((p) => p.metadata.isVariant)).toHaveLength(27);

        assignVariantProducts(products, 0.25);
        expect(products.filter((p) => p.metadata.isVariant)).toHaveLength(23);

        assignVariantProducts(products, 0);
        expect(products.some((p) => p.metadata.isVariant)).toBe(false);
    });

    test("is stable for the same product IDs", () => {
        assignVariantProducts(products, 0.3);
        const first = products.filter((p) => p.metadata.isVariant).map((p) => p.id);
        assignVariantProducts([...products].reverse(), 0.3);
        const second = products.filter((p) => p.metadata.isVariant).map((p) => p.id);

        expect(second).toEqual(first);
    });

    test("a larger share keeps the products of a smaller one", () => {
        assignVariantProducts(products, 0.2);
        const small = products.filter((p) => p.metadata.isVariant).map((p) => p.id);
        assignVariantProducts(products, 0.5);
        const large = new Set(products.filter((p) => p.metadata.isVariant).map((p) => p.id));

        expect(small.every((id) => large.has(id))).toBe(true);
    });
});

describe("pickOptions / pickPreferredOptions", () => {
    test("picks exactly count unique options, seeded", () => {
        const first = pickOptions([...SIZES, "m"], 3, "seed-a");

        expect(first).toHaveLength(3);
        expect(new Set(first.map((o) => o.toLowerCase())).size).toBe(3);
        expect(pickOptions([...SIZES, "m"], 3, "seed-a")).toEqual(first);
    });

    test("returns the whole pool when it is smaller than count", () => {
        expect(pickOptions(["A", "B"], 5, "seed").sort()).toEqual(["A", "B"]);
    });

    test("keeps preferred options first and tops up from the pool", () => {
        const picked = pickPreferredOptions(["Navy", "red"], COLORS, 4, "seed");

        expect(picked).toHaveLength(4);
        expect(picked.slice(0, 2)).toEqual(["Navy", "red"]);
        expect(picked.filter((o) => o.toLowerCase() === "red")).toHaveLength(1);
    });

    test("cuts preferred options to count", () => {
        expect(pickPreferredOptions(["A", "B", "C"], [], 2, "seed")).toEqual(["A", "B"]);
    });
});

describe("capVariantConfigs", () => {
    test("leaves configs under the cap unchanged", () => {
        const configs = [config("Color", COLORS.slice(0, 4)), config("Size", SIZES.slice(0, 3))];

        expect(capVariantConfigs(configs, 24)).toEqual(configs);
    });

    test("shrinks the largest other group before the colours", () => {
        const configs = [config("Color", COLORS.slice(0, 4)), config("Size", SIZES)];
        const capped = capVariantConfigs(configs, 12);

        expect(countVariants(capped)).toBe(12);
        expect(capped[0]?.selectedOptions).toEqual(COLORS.slice(0, 4));
        expect(capped[1]?.selectedOptions).toEqual(SIZES.slice(0, 3));
        expect(Object.keys(capped[1]?.priceModifiers ?? {})).toEqual(SIZES.slice(0, 3));
    });

    test("then shrinks the colours, keeping the default colour first", () => {
        const configs = [config("Color", COLORS.slice(0, 6)), config("Size", SIZES)];
        const capped = capVariantConfigs(configs, 6);

        expect(capped[1]?.selectedOptions).toEqual(SIZES.slice(0, 2));
        expect(capped[0]?.selectedOptions).toEqual(COLORS.slice(0, 3));
        expect(countVariants(capped)).toBe(6);
    });

    test("then drops other groups from the end", () => {
        const configs = [
            config("Color", COLORS.slice(0, 2)),
            config("Size", SIZES.slice(0, 2)),
            config("Material", ["Wood", "Steel"]),
        ];
        const capped = capVariantConfigs(configs, 4);

        expect(capped.map((c) => c.group)).toEqual(["Color", "Size"]);
    });

    test("does not mutate the input", () => {
        const configs = [config("Size", SIZES)];
        capVariantConfigs(configs, 4);

        expect(configs[0]?.selectedOptions).toEqual(SIZES);
    });
});

describe("repickVariantConfigs", () => {
    const settings: VariantSettings = { colors: 6, options: 2, maxVariants: 24, share: 0.3 };
    const poolFor = (group: string): string[] => (group === "Color" ? COLORS : SIZES);

    test("keeps the default colour and existing options first, then the extra colours", () => {
        const configs = [config("Color", ["Red", "Navy"]), config("Size", ["M", "L", "XL"])];
        const result = repickVariantConfigs({
            productId: "p-1",
            configs,
            settings,
            poolFor,
            defaultColor: "Navy",
            extraColors: ["Teal", "Plum"],
        });

        expect(result[0]?.selectedOptions.slice(0, 4)).toEqual(["Navy", "Red", "Teal", "Plum"]);
        expect(result[0]?.selectedOptions).toHaveLength(6);
        expect(result[1]?.selectedOptions).toEqual(["M", "L"]);
        expect(countVariants(result)).toBe(12);
    });

    test("keeps price modifiers and defaults new options to 1.0", () => {
        const result = repickVariantConfigs({
            productId: "p-1",
            configs: [config("Color", ["Red", "Navy"])],
            settings: { ...settings, colors: 3 },
            poolFor: () => ["Sand"],
        });

        expect(result[0]?.priceModifiers).toEqual({ Red: 1.1, Navy: 1.1, Sand: 1.0 });
    });

    test("applies the cap", () => {
        const result = repickVariantConfigs({
            productId: "p-1",
            configs: [config("Color", ["Red"]), config("Size", ["M"])],
            settings: { colors: 8, options: 6, maxVariants: 16, share: 0.3 },
            poolFor,
        });

        expect(countVariants(result)).toBeLessThanOrEqual(16);
        expect(result[0]?.selectedOptions[0]).toBe("Red");
    });
});

describe("colour helpers", () => {
    test("missingColorCount counts the default colour and existing colours once", () => {
        const configs = [config("Color", ["Navy", "Red"])];

        expect(missingColorCount(configs, "navy", { ...DEFAULT_VARIANT_SETTINGS, colors: 5 })).toBe(
            3
        );
        expect(missingColorCount(configs, "Teal", DEFAULT_VARIANT_SETTINGS)).toBe(1);
        expect(
            missingColorCount([config("Size", SIZES)], undefined, DEFAULT_VARIANT_SETTINGS)
        ).toBe(0);
        expect(missingColorCount(undefined, undefined, DEFAULT_VARIANT_SETTINGS)).toBe(0);
    });

    test("productDefaultColor prefers the stored colour, then the Color property", () => {
        const configs = [config("Color", ["Red", "Navy"])];
        const stored = createTestProduct({
            metadata: { defaultColor: "Olive", variantConfigs: configs },
        });
        const own = createTestProduct({
            metadata: { properties: [{ group: "Colour", value: "Sand" }], variantConfigs: configs },
        });
        const fromConfig = createTestProduct({
            metadata: { properties: [], variantConfigs: configs },
        });

        expect(productDefaultColor(stored)).toBe("Olive");
        expect(productDefaultColor(own)).toBe("Sand");
        expect(productDefaultColor(fromConfig)).toBe("Red");
    });

    test("productsMissingColors only returns variant products below the colour count", () => {
        const short = createTestProduct({
            id: "short",
            metadata: {
                isVariant: true,
                properties: [],
                variantConfigs: [config("Color", ["Red"])],
            },
        });
        const full = createTestProduct({
            id: "full",
            metadata: {
                isVariant: true,
                properties: [],
                variantConfigs: [config("Color", COLORS.slice(0, 4))],
            },
        });
        const plain = createTestProduct({
            id: "plain",
            metadata: {
                isVariant: false,
                properties: [],
                variantConfigs: [config("Color", ["Red"])],
            },
        });

        const ids = productsMissingColors([short, full, plain], DEFAULT_VARIANT_SETTINGS).map(
            (p) => p.id
        );
        expect(ids).toEqual(["short"]);
    });
});
