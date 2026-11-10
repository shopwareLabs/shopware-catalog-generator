import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
    variantOverridesFromParams,
    variantSettingParams,
} from "../../../src/services/variant-params.js";
import { VARIANT_SETTING_LIMITS } from "../../../src/types/index.js";

const schema = z.object(variantSettingParams);

describe("variantSettingParams", () => {
    test("accepts the limits and leaves every setting optional", () => {
        expect(schema.safeParse({}).success).toBe(true);
        expect(
            schema.safeParse({
                variantColors: VARIANT_SETTING_LIMITS.colors.max,
                variantOptions: VARIANT_SETTING_LIMITS.options.min,
                maxVariants: VARIANT_SETTING_LIMITS.maxVariants.max,
                variantShare: VARIANT_SETTING_LIMITS.share.min,
            }).success
        ).toBe(true);
    });

    test.each([
        [{ variantColors: VARIANT_SETTING_LIMITS.colors.max + 1 }],
        [{ variantOptions: 2.5 }],
        [{ maxVariants: VARIANT_SETTING_LIMITS.maxVariants.min - 1 }],
        [{ variantShare: 1.1 }],
    ])("rejects %p", (args) => {
        expect(schema.safeParse(args).success).toBe(false);
    });
});

describe("variantOverridesFromParams", () => {
    test("maps tool arguments to overrides and drops unset values", () => {
        expect(variantOverridesFromParams({ variantColors: 6, variantShare: 0.5 })).toEqual({
            colors: 6,
            share: 0.5,
        });
        expect(variantOverridesFromParams({})).toEqual({});
    });
});
