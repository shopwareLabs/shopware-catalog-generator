import { describe, expect, test } from "bun:test";

import {
    capitalizeString,
    createShortHash,
    decodeHtmlEntities,
    generateCategoryPlaceholder,
    generateProductPlaceholder,
    generatePropertyGroupPlaceholder,
    normalizeDescription,
    normalizeString,
    stripHtml,
} from "../../../src/utils/strings.js";

describe("string utilities", () => {
    describe("normalizeString", () => {
        test("trims whitespace", () => {
            expect(normalizeString("  hello  ")).toBe("hello");
        });

        test("collapses multiple spaces", () => {
            expect(normalizeString("hello   world")).toBe("hello world");
        });

        test("handles mixed whitespace", () => {
            expect(normalizeString("  hello  \t  world  \n  ")).toBe("hello world");
        });

        test("returns empty string for whitespace only", () => {
            expect(normalizeString("   ")).toBe("");
        });
    });

    describe("stripHtml", () => {
        test("removes simple HTML tags", () => {
            expect(stripHtml("<p>Hello</p>")).toBe(" Hello ");
        });

        test("removes nested HTML tags", () => {
            expect(stripHtml("<div><p>Hello</p></div>")).toBe("  Hello  ");
        });

        test("removes tags with attributes", () => {
            expect(stripHtml('<a href="test">Link</a>')).toBe(" Link ");
        });

        test("handles self-closing tags", () => {
            expect(stripHtml("Hello<br/>World")).toBe("Hello World");
        });

        test("returns same string if no HTML", () => {
            expect(stripHtml("No HTML here")).toBe("No HTML here");
        });
    });

    describe("decodeHtmlEntities", () => {
        test("decodes &nbsp;", () => {
            expect(decodeHtmlEntities("hello&nbsp;world")).toBe("hello world");
        });

        test("decodes &amp;", () => {
            expect(decodeHtmlEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
        });

        test("decodes &lt; and &gt;", () => {
            expect(decodeHtmlEntities("&lt;div&gt;")).toBe("<div>");
        });

        test("decodes &quot;", () => {
            expect(decodeHtmlEntities("Say &quot;hello&quot;")).toBe('Say "hello"');
        });

        test("decodes &#39; and &#x27;", () => {
            expect(decodeHtmlEntities("It&#39;s fine")).toBe("It's fine");
            expect(decodeHtmlEntities("It&#x27;s fine")).toBe("It's fine");
        });

        test("handles multiple entities", () => {
            expect(decodeHtmlEntities("&lt;a&gt; &amp; &quot;b&quot;")).toBe('<a> & "b"');
        });
    });

    describe("normalizeDescription", () => {
        test("strips HTML and normalizes whitespace", () => {
            expect(normalizeDescription("<p>Hello  World</p>")).toBe("Hello World");
        });

        test("decodes HTML entities", () => {
            expect(normalizeDescription("Hello&nbsp;World")).toBe("Hello World");
        });

        test("handles complex HTML with entities", () => {
            expect(
                normalizeDescription("<p>This is a <strong>bold</strong> &amp; italic text.</p>")
            ).toBe("This is a bold & italic text.");
        });

        test("trims result", () => {
            expect(normalizeDescription("  <p>Hello</p>  ")).toBe("Hello");
        });

        test("collapses whitespace after entity decoding", () => {
            expect(normalizeDescription("Hello&nbsp;&nbsp;&nbsp;World")).toBe("Hello World");
        });
    });

    describe("capitalizeString", () => {
        test("capitalizes first letter of each word", () => {
            expect(capitalizeString("hello world")).toBe("Hello World");
        });

        test("lowercases rest of each word", () => {
            expect(capitalizeString("HELLO WORLD")).toBe("Hello World");
        });

        test("handles single word", () => {
            expect(capitalizeString("hello")).toBe("Hello");
        });

        test("handles mixed case", () => {
            expect(capitalizeString("hElLo WoRlD")).toBe("Hello World");
        });

        test("handles empty string", () => {
            expect(capitalizeString("")).toBe("");
        });
    });

    describe("placeholder generators", () => {
        test("generateCategoryPlaceholder creates category description", () => {
            expect(generateCategoryPlaceholder("Electronics")).toBe(
                "Browse our Electronics collection."
            );
        });

        test("generateProductPlaceholder creates product description", () => {
            expect(generateProductPlaceholder("iPhone 15", "Electronics")).toBe(
                "High-quality iPhone 15 from our Electronics collection."
            );
        });

        test("generatePropertyGroupPlaceholder creates group description", () => {
            expect(generatePropertyGroupPlaceholder("Color")).toBe("Color property options");
        });
    });

    describe("createShortHash", () => {
        test("returns a string of the requested length", () => {
            expect(createShortHash("hello", 5)).toHaveLength(5);
            expect(createShortHash("hello", 3)).toHaveLength(3);
            expect(createShortHash("hello", 8)).toHaveLength(8);
        });

        test("defaults to length 5", () => {
            expect(createShortHash("hello")).toHaveLength(5);
        });

        test("is deterministic (same input produces same output)", () => {
            const hash1 = createShortHash("test-input", 5);
            const hash2 = createShortHash("test-input", 5);
            expect(hash1).toBe(hash2);
        });

        test("produces different hashes for different inputs", () => {
            const hash1 = createShortHash("adjustable-100-135-cm-polyester-exterior-foam", 5);
            const hash2 = createShortHash("adjustable-100-135-cm-polyester-exterior-nylon", 5);
            expect(hash1).not.toBe(hash2);
        });

        test("produces different hashes for inputs differing only at the end", () => {
            const prefix = "very-long-option-name-that-shares-a-common-prefix-with-another";
            const hash1 = createShortHash(`${prefix}-variant-a`, 5);
            const hash2 = createShortHash(`${prefix}-variant-b`, 5);
            expect(hash1).not.toBe(hash2);
        });

        test("only contains alphanumeric characters", () => {
            const hash = createShortHash("some input with spaces & symbols!", 8);
            expect(hash).toMatch(/^[0-9a-z]+$/);
        });

        test("clamps length to max 8", () => {
            expect(createShortHash("hello", 20)).toHaveLength(8);
        });

        test("clamps length to min 1", () => {
            expect(createShortHash("hello", 0)).toHaveLength(1);
            expect(createShortHash("hello", -5)).toHaveLength(1);
        });

        test("handles empty string input", () => {
            const hash = createShortHash("", 5);
            expect(hash).toHaveLength(5);
            expect(hash).toMatch(/^[0-9a-z]+$/);
        });
    });
});
