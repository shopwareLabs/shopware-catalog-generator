import { describe, expect, test } from "bun:test";

import {
    capitalizeString,
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
});
