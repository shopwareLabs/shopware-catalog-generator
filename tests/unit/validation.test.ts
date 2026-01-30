import { describe, expect, test } from "bun:test";

import {
    generateSubdomainUrl,
    isValidSubdomain,
    validateSubdomainName,
} from "../../src/utils/validation.js";

describe("validateSubdomainName", () => {
    test("accepts valid subdomain names", () => {
        const result = validateSubdomainName("furniture");
        expect(result.valid).toBe(true);
        expect(result.sanitized).toBe("furniture");
        expect(result.error).toBeUndefined();
        expect(result.warning).toBeUndefined();
    });

    test("accepts names with numbers", () => {
        const result = validateSubdomainName("shop123");
        expect(result.valid).toBe(true);
        expect(result.sanitized).toBe("shop123");
    });

    test("accepts names with hyphens", () => {
        const result = validateSubdomainName("my-shop");
        expect(result.valid).toBe(true);
        expect(result.sanitized).toBe("my-shop");
    });

    test("converts uppercase to lowercase", () => {
        const result = validateSubdomainName("MyShop");
        expect(result.valid).toBe(true);
        expect(result.sanitized).toBe("myshop");
        // No warning for just case conversion (result equals lowercased input)
        expect(result.warning).toBeUndefined();
    });

    test("warns when name requires sanitization beyond lowercasing", () => {
        const result = validateSubdomainName("My Shop!");
        expect(result.valid).toBe(true);
        expect(result.sanitized).toBe("my-shop");
        expect(result.warning).toContain("sanitized");
    });

    test("replaces spaces with hyphens", () => {
        const result = validateSubdomainName("my shop");
        expect(result.valid).toBe(true);
        expect(result.sanitized).toBe("my-shop");
        expect(result.warning).toContain("sanitized");
    });

    test("replaces underscores with hyphens", () => {
        const result = validateSubdomainName("my_shop");
        expect(result.valid).toBe(true);
        expect(result.sanitized).toBe("my-shop");
    });

    test("removes special characters", () => {
        const result = validateSubdomainName("shop!@#$%");
        expect(result.valid).toBe(true);
        expect(result.sanitized).toBe("shop");
    });

    test("collapses multiple hyphens", () => {
        const result = validateSubdomainName("my--shop");
        expect(result.valid).toBe(true);
        expect(result.sanitized).toBe("my-shop");
    });

    test("removes leading hyphens", () => {
        const result = validateSubdomainName("-shop");
        expect(result.valid).toBe(true);
        expect(result.sanitized).toBe("shop");
    });

    test("removes trailing hyphens", () => {
        const result = validateSubdomainName("shop-");
        expect(result.valid).toBe(true);
        expect(result.sanitized).toBe("shop");
    });

    test("handles complex sanitization", () => {
        const result = validateSubdomainName("  My Awesome Shop!!! ");
        expect(result.valid).toBe(true);
        expect(result.sanitized).toBe("my-awesome-shop");
    });

    test("rejects empty string", () => {
        const result = validateSubdomainName("");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("empty");
    });

    test("rejects whitespace-only string", () => {
        const result = validateSubdomainName("   ");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("empty");
    });

    test("rejects string with only special characters", () => {
        const result = validateSubdomainName("!@#$%^&*()");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("no valid characters");
    });

    test("truncates names longer than 63 characters", () => {
        const longName = "a".repeat(70);
        const result = validateSubdomainName(longName);
        expect(result.valid).toBe(true);
        expect(result.sanitized.length).toBeLessThanOrEqual(63);
        expect(result.warning).toContain("truncated");
    });

    test("handles German umlauts", () => {
        const result = validateSubdomainName("möbel");
        expect(result.valid).toBe(true);
        expect(result.sanitized).toBe("mbel");
    });

    test("handles names starting with numbers", () => {
        const result = validateSubdomainName("123shop");
        expect(result.valid).toBe(true);
        expect(result.sanitized).toBe("123shop");
    });
});

describe("isValidSubdomain", () => {
    test("returns true for valid subdomains", () => {
        expect(isValidSubdomain("shop")).toBe(true);
        expect(isValidSubdomain("my-shop")).toBe(true);
        expect(isValidSubdomain("shop123")).toBe(true);
        expect(isValidSubdomain("a")).toBe(true);
    });

    test("returns false for empty string", () => {
        expect(isValidSubdomain("")).toBe(false);
    });

    test("returns false for uppercase letters", () => {
        expect(isValidSubdomain("Shop")).toBe(false);
    });

    test("returns false for special characters", () => {
        expect(isValidSubdomain("shop!")).toBe(false);
        expect(isValidSubdomain("shop_name")).toBe(false);
        expect(isValidSubdomain("shop name")).toBe(false);
    });

    test("returns false for leading hyphen", () => {
        expect(isValidSubdomain("-shop")).toBe(false);
    });

    test("returns false for trailing hyphen", () => {
        expect(isValidSubdomain("shop-")).toBe(false);
    });

    test("returns false for consecutive hyphens", () => {
        expect(isValidSubdomain("my--shop")).toBe(false);
    });

    test("returns false for names over 63 characters", () => {
        expect(isValidSubdomain("a".repeat(64))).toBe(false);
    });

    test("returns true for exactly 63 characters", () => {
        expect(isValidSubdomain("a".repeat(63))).toBe(true);
    });
});

describe("generateSubdomainUrl", () => {
    test("generates URL with default host", () => {
        const url = generateSubdomainUrl("furniture");
        expect(url).toBe("http://furniture.localhost:8000");
    });

    test("uses custom host", () => {
        const url = generateSubdomainUrl("furniture", "example.com");
        expect(url).toBe("http://furniture.example.com");
    });

    test("uses custom protocol", () => {
        const url = generateSubdomainUrl("furniture", "example.com", "https");
        expect(url).toBe("https://furniture.example.com");
    });

    test("handles host with port", () => {
        const url = generateSubdomainUrl("shop", "localhost:3000");
        expect(url).toBe("http://shop.localhost:3000");
    });
});
