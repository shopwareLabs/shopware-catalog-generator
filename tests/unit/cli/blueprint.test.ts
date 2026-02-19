import { describe, expect, test } from "bun:test";

import { resolveCmsStoreDescription } from "../../../src/cli/blueprint.js";

describe("resolveCmsStoreDescription", () => {
    test("prefers hydrated description when available", () => {
        const result = resolveCmsStoreDescription(
            "music",
            "Raw blueprint description",
            "AI-generated hydrated description"
        );

        expect(result).toBe("AI-generated hydrated description");
    });

    test("falls back to blueprint description when hydrated is missing", () => {
        const result = resolveCmsStoreDescription("music", "Raw blueprint description");

        expect(result).toBe("Raw blueprint description");
    });

    test("falls back to default description when both are empty", () => {
        const result = resolveCmsStoreDescription("music", "   ", " ");

        expect(result).toBe("music webshop");
    });
});
