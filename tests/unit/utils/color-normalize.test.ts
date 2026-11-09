import { describe, expect, test } from "bun:test";

import type { ColorFamily } from "../../../src/types/index.js";

import {
    estimateShade,
    familyFromHex,
    isHexColor,
    normalizeColorName,
    resolveOrEstimateShade,
    resolveShade,
} from "../../../src/utils/index.js";

describe("normalizeColorName", () => {
    test.each([
        ["grey", "Gray"],
        ["  Light   Grey ", "Light Gray"],
        ["navy blue", "Navy"],
        ["off-white", "Off White"],
        ["Clear", "Transparent"],
        ["multi-colored", "Multicolor"],
        ["3 colours", "Multicolor"],
        ["assorted colors", "Multicolor"],
        ["Various", "Multicolor"],
        ["black & white", "Black/White"],
        ["Navy and Red", "Navy/Red"],
        ["dusty rose", "Dusty Rose"],
        ["blue-gray", "Blue-Gray"],
    ])("%p → %p", (raw, expected) => {
        expect(normalizeColorName(raw)).toBe(expected);
    });

    test("returns empty string for blank input", () => {
        expect(normalizeColorName("   ")).toBe("");
    });

    test("keeps unknown combinations as one title-cased name", () => {
        expect(normalizeColorName("sunset / dusk")).toBe("Sunset / Dusk");
    });
});

describe("isHexColor", () => {
    test("accepts #rrggbb only", () => {
        expect(isHexColor("#a1B2c3")).toBe(true);
        expect(isHexColor("#abc")).toBe(false);
        expect(isHexColor("a1b2c3")).toBe(false);
    });
});

describe("familyFromHex", () => {
    test.each([
        ["#000000", "black"],
        ["#ffffff", "white"],
        ["#808080", "gray"],
        ["#dc2626", "red"],
        ["#f57c00", "orange"],
        ["#fbc02d", "yellow"],
        ["#388e3c", "green"],
        ["#1976d2", "blue"],
        ["#7b1fa2", "purple"],
        ["#ec407a", "pink"],
        ["#795548", "brown"],
        ["#d8c3a5", "beige"],
    ] satisfies Array<[string, ColorFamily]>)("%p → %p", (hex, family) => {
        expect(familyFromHex(hex)).toBe(family);
    });

    test("invalid hex falls back to gray", () => {
        expect(familyFromHex("not-a-hex")).toBe("gray");
    });
});

describe("resolveShade", () => {
    test("resolves curated shades with their fixture family", () => {
        expect(resolveShade("navy blue")).toEqual({ name: "Navy", hex: "#1e3a5f", family: "blue" });
    });

    test("uses learned shades for unknown names", () => {
        const learned = {
            "dusty rose": { name: "Dusty Rose", hex: "#c48b8b", family: "pink" as const },
        };
        expect(resolveShade("dusty rose", learned)).toEqual({
            name: "Dusty Rose",
            hex: "#c48b8b",
            family: "pink",
        });
    });

    test("curated shades win over learned ones", () => {
        const learned = { navy: { name: "Navy", hex: "#000000", family: "black" as const } };
        expect(resolveShade("Navy", learned)?.family).toBe("blue");
    });

    test("image colours and known combinations are multicolor", () => {
        expect(resolveShade("Rainbow")?.family).toBe("multicolor");
        expect(resolveShade("Black & White")).toMatchObject({
            name: "Black/White",
            family: "multicolor",
        });
    });

    test("returns null for unknown names", () => {
        expect(resolveShade("Dusty Rose")).toBeNull();
        expect(resolveShade("")).toBeNull();
    });
});

describe("estimateShade", () => {
    test("uses the closest palette entry", () => {
        expect(estimateShade("Deep Forest Green")).toMatchObject({
            name: "Deep Forest Green",
            family: "green",
        });
    });

    test("falls back to neutral gray", () => {
        expect(estimateShade("Xyzzy")).toEqual({ name: "Xyzzy", hex: "#808080", family: "gray" });
    });

    test("resolveOrEstimateShade prefers known shades", () => {
        expect(resolveOrEstimateShade("grey").name).toBe("Gray");
        expect(resolveOrEstimateShade("Xyzzy").family).toBe("gray");
    });
});
