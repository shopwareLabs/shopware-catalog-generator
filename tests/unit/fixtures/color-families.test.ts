import { describe, expect, test } from "bun:test";

import {
    COLOR_ALIASES,
    COLOR_FAMILIES,
    COLOR_FAMILY_GROUP_ID,
    COLOR_OPTIONS,
    colorHasImage,
    colorFamilyOptionId,
    colorFamilyTranslation,
    getCuratedShade,
} from "../../../src/fixtures/index.js";
import { COLOR_FAMILY_KEYS } from "../../../src/types/index.js";

const HEX = /^#[0-9a-f]{6}$/i;

describe("COLOR_FAMILIES", () => {
    test("has all 16 families in key order", () => {
        expect(COLOR_FAMILIES.map((f) => f.key)).toEqual([...COLOR_FAMILY_KEYS]);
        expect(COLOR_FAMILIES).toHaveLength(16);
    });

    test("every family has a valid hex and a German name", () => {
        for (const family of COLOR_FAMILIES) {
            expect(family.hex).toMatch(HEX);
            expect(family.translations.de).toBeTruthy();
        }
    });

    test("IDs are stable and unique", () => {
        const ids = COLOR_FAMILY_KEYS.map(colorFamilyOptionId);
        expect(new Set([...ids, COLOR_FAMILY_GROUP_ID]).size).toBe(17);
        expect(colorFamilyOptionId("red")).toBe(colorFamilyOptionId("red"));
    });
});

describe("colorFamilyTranslation", () => {
    test("returns the group name without a family", () => {
        expect(colorFamilyTranslation("de-DE")).toBe("Farbfamilie");
    });

    test("matches by language part of the locale", () => {
        expect(colorFamilyTranslation("de-CH", "white")).toBe("Weiß");
        expect(colorFamilyTranslation("fr_FR", "black")).toBe("Noir");
    });

    test("returns undefined for languages without an entry", () => {
        expect(colorFamilyTranslation("ja-JP", "red")).toBeUndefined();
        expect(colorFamilyTranslation("ja-JP")).toBeUndefined();
    });
});

describe("COLOR_OPTIONS (curated shades)", () => {
    test("names are unique (case-insensitive)", () => {
        const names = COLOR_OPTIONS.map((c) => c.name.toLowerCase());
        expect(new Set(names).size).toBe(names.length);
    });

    test("every shade has a valid hex and a known family", () => {
        for (const shade of COLOR_OPTIONS) {
            expect(shade.hex).toMatch(HEX);
            expect(COLOR_FAMILY_KEYS).toContain(shade.family);
        }
    });

    test("every family name except Multicolor (an image colour) is a curated shade", () => {
        expect(colorHasImage("Multicolor")).toBe(true);
        for (const family of COLOR_FAMILIES.filter((f) => f.key !== "multicolor")) {
            expect(getCuratedShade(family.name)?.family).toBe(family.key);
        }
    });

    test("aliases point to curated shades or image colours", () => {
        for (const target of Object.values(COLOR_ALIASES)) {
            expect(getCuratedShade(target) !== undefined || colorHasImage(target)).toBe(true);
        }
    });

    test("getCuratedShade is case-insensitive", () => {
        expect(getCuratedShade("NAVY")?.name).toBe("Navy");
        expect(getCuratedShade("unknown shade")).toBeUndefined();
    });
});
