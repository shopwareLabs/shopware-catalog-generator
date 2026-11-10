import { describe, expect, test } from "bun:test";

import {
    buildBaseImagePrompt,
    FICTIONAL_BRANDING_INSTRUCTION,
    withFictionalBranding,
} from "../../../src/utils/index.js";

describe("withFictionalBranding", () => {
    test("appends the instruction as a new sentence", () => {
        expect(withFictionalBranding("Vitamin D3 Capsules, front view on white background")).toBe(
            `Vitamin D3 Capsules, front view on white background. ${FICTIONAL_BRANDING_INSTRUCTION}`
        );
    });

    test("does not add a second period after a finished sentence", () => {
        expect(withFictionalBranding("A compact logo for the store. ")).toBe(
            `A compact logo for the store. ${FICTIONAL_BRANDING_INSTRUCTION}`
        );
    });

    test("is idempotent", () => {
        const once = withFictionalBranding("Shampoo bottle");
        expect(withFictionalBranding(once)).toBe(once);
    });

    test("forbids real brands but keeps explicitly requested text allowed", () => {
        expect(FICTIONAL_BRANDING_INSTRUCTION).toContain("Do not show real-world brands");
        expect(FICTIONAL_BRANDING_INSTRUCTION).toContain(
            "apart from text this prompt explicitly asks for"
        );
    });
});

describe("buildBaseImagePrompt", () => {
    test("adds material, colour and style in a fixed order", () => {
        const properties = [
            { group: "Style", value: "Modern" },
            { group: "Color", value: "Navy" },
            { group: "Material", value: "Oak" },
        ];
        expect(buildBaseImagePrompt("Lounge Chair", properties)).toBe(
            "Lounge Chair, Oak construction, Navy finish, Modern design"
        );
    });

    test("matches group names case-insensitively and ignores other groups", () => {
        const properties = [
            { group: "MATERIAL", value: "Linen" },
            { group: "Size", value: "XL" },
        ];
        expect(buildBaseImagePrompt("Cushion", properties)).toBe("Cushion, Linen construction");
    });

    test("leaves out values the name already mentions", () => {
        const properties = [
            { group: "Material", value: "oak" },
            { group: "Color", value: "NAVY" },
            { group: "Style", value: "Modern" },
        ];
        expect(buildBaseImagePrompt("Modern Oak Table - Navy", properties)).toBe(
            "Modern Oak Table - Navy"
        );
    });

    test("uses the normalized colour name", () => {
        const properties = [{ group: "Color", value: "navy blue" }];
        expect(buildBaseImagePrompt("Lamp", properties)).toBe("Lamp, Navy finish");
    });

    test("returns the name alone without properties", () => {
        expect(buildBaseImagePrompt("Lamp", [])).toBe("Lamp");
    });
});
