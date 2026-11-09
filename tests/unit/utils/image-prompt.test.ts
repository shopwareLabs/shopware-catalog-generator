import { describe, expect, test } from "bun:test";

import { FICTIONAL_BRANDING_INSTRUCTION, withFictionalBranding } from "../../../src/utils/index.js";

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
