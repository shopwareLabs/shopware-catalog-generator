import { describe, expect, test } from "bun:test";

import {
    buildCustomFieldConfig,
    findPackagingUnit,
    PACKAGING_OPTIONS,
    PACKAGING_SHARE,
    PRODUCT_CUSTOM_FIELD_SET,
} from "../../../src/fixtures/index.js";

describe("packaging fixtures", () => {
    test("every packaging option refers to a known unit", () => {
        for (const option of PACKAGING_OPTIONS) {
            expect(findPackagingUnit(option.unitShortCode)).toBeDefined();
        }
    });

    test("returns undefined for unknown units", () => {
        expect(findPackagingUnit("unknown")).toBeUndefined();
    });

    test("share is a fraction", () => {
        expect(PACKAGING_SHARE).toBeGreaterThan(0);
        expect(PACKAGING_SHARE).toBeLessThan(1);
    });
});

describe("custom field fixtures", () => {
    test("field names are unique and prefixed", () => {
        const names = PRODUCT_CUSTOM_FIELD_SET.fields.map((f) => f.name);
        expect(new Set(names).size).toBe(names.length);
        expect(names.every((n) => n.startsWith("cg_"))).toBe(true);
    });

    test("builds the Administration config with label and input type", () => {
        expect(
            buildCustomFieldConfig({
                name: "cg_x",
                type: "int",
                label: "X",
                includeInSearch: false,
            })
        ).toMatchObject({ label: { "en-GB": "X" }, type: "number", numberType: "int" });
        expect(
            buildCustomFieldConfig({
                name: "cg_y",
                type: "bool",
                label: "Y",
                includeInSearch: false,
            }).customFieldType
        ).toBe("switch");
    });
});
