import { describe, expect, test } from "bun:test";

import {
    buildImagePrompt,
    COLOR_PALETTE,
    findClosestColor,
    getColorHex,
    getViewSuffix,
    isColorGroup,
    VIEW_SUFFIXES,
} from "../../src/utils/color-palette.js";

describe("Color Palette", () => {
    describe("COLOR_PALETTE", () => {
        test("contains standard colors", () => {
            expect(COLOR_PALETTE.Red).toBeDefined();
            expect(COLOR_PALETTE.Blue).toBeDefined();
            expect(COLOR_PALETTE.Green).toBeDefined();
            expect(COLOR_PALETTE.Black).toBeDefined();
            expect(COLOR_PALETTE.White).toBeDefined();
        });

        test("contains wood tones", () => {
            expect(COLOR_PALETTE.Oak).toBeDefined();
            expect(COLOR_PALETTE.Walnut).toBeDefined();
            expect(COLOR_PALETTE.Cherry).toBeDefined();
            expect(COLOR_PALETTE.Mahogany).toBeDefined();
        });

        test("contains metal colors", () => {
            expect(COLOR_PALETTE.Brass).toBeDefined();
            expect(COLOR_PALETTE.Bronze).toBeDefined();
            expect(COLOR_PALETTE.Silver).toBeDefined();
            expect(COLOR_PALETTE.Gold).toBeDefined();
        });

        test("all values are valid hex codes", () => {
            const hexPattern = /^#[0-9a-f]{6}$/i;
            for (const [name, hex] of Object.entries(COLOR_PALETTE)) {
                expect(hex, `${name} should be a valid hex`).toMatch(hexPattern);
            }
        });
    });

    describe("findClosestColor", () => {
        test("finds exact match (case-insensitive)", () => {
            const result = findClosestColor("Red");
            expect(result).not.toBeNull();
            expect(result?.name).toBe("Red");
            expect(result?.hex).toBe(COLOR_PALETTE.Red);
        });

        test("finds exact match lowercase", () => {
            const result = findClosestColor("red");
            expect(result).not.toBeNull();
            expect(result?.name).toBe("Red");
        });

        test("finds exact match uppercase", () => {
            const result = findClosestColor("RED");
            expect(result).not.toBeNull();
            expect(result?.name).toBe("Red");
        });

        test("finds partial match (color name contains palette entry)", () => {
            const result = findClosestColor("Natural Oak Wood");
            expect(result).not.toBeNull();
            expect(result?.name).toBe("Natural Oak");
        });

        test("finds partial match (palette entry contains color name)", () => {
            const result = findClosestColor("Forest");
            expect(result).not.toBeNull();
            expect(result?.name).toBe("Forest Green");
        });

        test("finds word-based match", () => {
            const result = findClosestColor("Deep Blue Ocean");
            expect(result).not.toBeNull();
            expect(result?.name).toBe("Blue");
        });

        test("returns null for unknown colors", () => {
            const result = findClosestColor("Ultraviolet Rainbow");
            expect(result).toBeNull();
        });

        test("returns null for empty string", () => {
            const result = findClosestColor("");
            expect(result).toBeNull();
        });

        test("trims whitespace", () => {
            const result = findClosestColor("  Red  ");
            expect(result).not.toBeNull();
            expect(result?.name).toBe("Red");
        });

        test("handles hyphenated color names", () => {
            // "Slate-Blue" matches "Blue" via word-based matching
            // (splits into ["slate", "blue"], Blue matches first in palette)
            const result = findClosestColor("Slate-Blue");
            expect(result).not.toBeNull();
            // Could match either "Blue" or "Slate Blue" depending on palette order
            expect(result?.name).toBeDefined();
            expect(["Blue", "Slate Blue"]).toContain(result?.name ?? "");
        });
    });

    describe("getColorHex", () => {
        test("returns hex for known color", () => {
            expect(getColorHex("Red")).toBe(COLOR_PALETTE.Red ?? "#FF0000");
            expect(getColorHex("Blue")).toBe(COLOR_PALETTE.Blue ?? "#0000FF");
        });

        test("returns fallback for unknown color", () => {
            expect(getColorHex("Unknown Color")).toBe("#808080");
        });

        test("accepts custom fallback", () => {
            expect(getColorHex("Unknown Color", "#ffffff")).toBe("#ffffff");
        });

        test("is case-insensitive", () => {
            expect(getColorHex("red")).toBe(COLOR_PALETTE.Red ?? "#FF0000");
            expect(getColorHex("RED")).toBe(COLOR_PALETTE.Red ?? "#FF0000");
        });
    });

    describe("isColorGroup", () => {
        test("returns true for Color group", () => {
            expect(isColorGroup("Color")).toBe(true);
            expect(isColorGroup("color")).toBe(true);
            expect(isColorGroup("COLOR")).toBe(true);
        });

        test("returns true for Colour (British spelling)", () => {
            expect(isColorGroup("Colour")).toBe(true);
            expect(isColorGroup("colour")).toBe(true);
        });

        test("returns true for Farbe (German)", () => {
            expect(isColorGroup("Farbe")).toBe(true);
            expect(isColorGroup("farbe")).toBe(true);
        });

        test("returns true for Finish group", () => {
            expect(isColorGroup("Finish")).toBe(true);
            expect(isColorGroup("finish")).toBe(true);
        });

        test("returns true for compound color names", () => {
            expect(isColorGroup("Exterior Color")).toBe(true);
            expect(isColorGroup("Frame Colour")).toBe(true);
        });

        test("returns false for non-color groups", () => {
            expect(isColorGroup("Material")).toBe(false);
            expect(isColorGroup("Size")).toBe(false);
            expect(isColorGroup("Style")).toBe(false);
        });
    });
});

describe("View Suffixes", () => {
    describe("VIEW_SUFFIXES", () => {
        test("contains standard views", () => {
            expect(VIEW_SUFFIXES.front).toBeDefined();
            expect(VIEW_SUFFIXES.side).toBeDefined();
            expect(VIEW_SUFFIXES.lifestyle).toBeDefined();
            expect(VIEW_SUFFIXES.detail).toBeDefined();
        });

        test("all suffixes are non-empty strings", () => {
            for (const [view, suffix] of Object.entries(VIEW_SUFFIXES)) {
                expect(suffix, `${view} suffix should be non-empty`).not.toBe("");
                expect(typeof suffix).toBe("string");
            }
        });
    });

    describe("getViewSuffix", () => {
        // Extract suffixes with type guard to avoid non-null assertions
        const frontSuffix = VIEW_SUFFIXES.front;
        const lifestyleSuffix = VIEW_SUFFIXES.lifestyle;
        if (!frontSuffix || !lifestyleSuffix) {
            throw new Error("VIEW_SUFFIXES.front or lifestyle is not defined");
        }

        test("returns suffix for known view", () => {
            expect(getViewSuffix("front")).toBe(frontSuffix);
            expect(getViewSuffix("lifestyle")).toBe(lifestyleSuffix);
        });

        test("is case-insensitive", () => {
            expect(getViewSuffix("FRONT")).toBe(frontSuffix);
            expect(getViewSuffix("Front")).toBe(frontSuffix);
        });

        test("trims whitespace", () => {
            expect(getViewSuffix("  front  ")).toBe(frontSuffix);
        });

        test("returns front suffix for unknown view", () => {
            expect(getViewSuffix("unknown")).toBe(frontSuffix);
        });
    });

    describe("buildImagePrompt", () => {
        // Extract suffix with type guard
        const frontSuffix = VIEW_SUFFIXES.front;
        if (!frontSuffix) {
            throw new Error("VIEW_SUFFIXES.front is not defined");
        }

        test("combines base prompt with view suffix", () => {
            const result = buildImagePrompt("Oak coffee table", "front");
            expect(result).toContain("Oak coffee table");
            expect(result).toContain(frontSuffix);
        });

        test("uses comma to join base and suffix", () => {
            const result = buildImagePrompt("Oak table", "front");
            expect(result).toBe(`Oak table, ${frontSuffix}`);
        });

        test("handles different views", () => {
            const frontResult = buildImagePrompt("Chair", "front");
            const lifestyleResult = buildImagePrompt("Chair", "lifestyle");

            expect(frontResult).not.toBe(lifestyleResult);
            expect(frontResult).toContain("front view");
            expect(lifestyleResult).toContain("modern room");
        });
    });
});
