import { describe, expect, test } from "bun:test";

import { resolveCmsStoreDescription } from "../../../src/services/blueprint-service.js";

describe("resolveCmsStoreDescription", () => {
    test("returns hydrated description when present", () => {
        expect(resolveCmsStoreDescription("shop", "blueprint desc", "hydrated desc")).toBe(
            "hydrated desc"
        );
    });

    test("falls back to blueprint description when hydrated is absent", () => {
        expect(resolveCmsStoreDescription("shop", "blueprint desc", undefined)).toBe(
            "blueprint desc"
        );
    });

    test("falls back to blueprint description when hydrated is empty string", () => {
        expect(resolveCmsStoreDescription("shop", "blueprint desc", "")).toBe("blueprint desc");
    });

    test("falls back to blueprint description when hydrated is whitespace only", () => {
        expect(resolveCmsStoreDescription("shop", "blueprint desc", "   ")).toBe("blueprint desc");
    });

    test("falls back to salesChannelName webshop when both descriptions absent", () => {
        expect(resolveCmsStoreDescription("my-shop", undefined, undefined)).toBe("my-shop webshop");
    });

    test("falls back to salesChannelName webshop when both descriptions empty", () => {
        expect(resolveCmsStoreDescription("furniture", "", "")).toBe("furniture webshop");
    });

    test("returns hydrated description even when blueprint description exists", () => {
        const result = resolveCmsStoreDescription("shop", "ignored", "winner");
        expect(result).toBe("winner");
    });
});
