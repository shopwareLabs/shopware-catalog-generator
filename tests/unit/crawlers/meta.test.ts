import { describe, expect, test } from "bun:test";

import * as cheerio from "cheerio";

import {
    extractBrandDescription,
    extractNavCategories,
    extractPrimaryColor,
    extractSecondaryColor,
} from "../../../src/crawlers/extractors/meta.js";

function load(html: string) {
    return cheerio.load(html);
}

describe("extractBrandDescription", () => {
    test("prefers og:description", () => {
        const $ = load(`
            <meta property="og:description" content="The finest furniture in town">
            <meta name="description" content="Fallback description">
        `);
        expect(extractBrandDescription($)).toBe("The finest furniture in town");
    });

    test("falls back to meta description", () => {
        const $ = load(`<meta name="description" content="Best online shop">`);
        expect(extractBrandDescription($)).toBe("Best online shop");
    });

    test("returns undefined for missing meta", () => {
        const $ = load(`<html></html>`);
        expect(extractBrandDescription($)).toBeUndefined();
    });

    test("ignores descriptions shorter than 10 chars", () => {
        const $ = load(`<meta name="description" content="Short">`);
        expect(extractBrandDescription($)).toBeUndefined();
    });
});

describe("extractPrimaryColor", () => {
    test("extracts theme-color meta tag", () => {
        const $ = load(`<meta name="theme-color" content="#2D3A4A">`);
        expect(extractPrimaryColor($)).toBe("#2d3a4a");
    });

    test("extracts --primary-color CSS variable", () => {
        const $ = load(`<style>:root { --primary-color: #FF5722; }</style>`);
        expect(extractPrimaryColor($)).toBe("#ff5722");
    });

    test("extracts --brand-color CSS variable", () => {
        const $ = load(`<style>:root { --brand-color: #1A237E; }</style>`);
        expect(extractPrimaryColor($)).toBe("#1a237e");
    });

    test("returns undefined when no color found", () => {
        const $ = load(`<html></html>`);
        expect(extractPrimaryColor($)).toBeUndefined();
    });
});

describe("extractSecondaryColor", () => {
    test("extracts --secondary-color CSS variable", () => {
        const $ = load(`<style>:root { --secondary-color: #FFC107; }</style>`);
        expect(extractSecondaryColor($)).toBe("#ffc107");
    });

    test("extracts --accent-color CSS variable", () => {
        const $ = load(`<style>:root { --accent-color: #E91E63; }</style>`);
        expect(extractSecondaryColor($)).toBe("#e91e63");
    });

    test("returns undefined when no secondary color found", () => {
        const $ = load(`<html></html>`);
        expect(extractSecondaryColor($)).toBeUndefined();
    });
});

describe("extractNavCategories", () => {
    test("extracts nav link text", () => {
        const $ = load(`
            <nav>
                <a href="/sofas">Sofas</a>
                <a href="/tables">Dining Tables</a>
                <a href="/lighting">Lighting</a>
            </nav>
        `);
        const cats = extractNavCategories($);
        expect(cats).toContain("Sofas");
        expect(cats).toContain("Dining Tables");
        expect(cats).toContain("Lighting");
    });

    test("skips generic navigation words", () => {
        const $ = load(`
            <nav>
                <a href="/">Home</a>
                <a href="/login">Login</a>
                <a href="/cart">Cart</a>
                <a href="/sofas">Sofas</a>
            </nav>
        `);
        const cats = extractNavCategories($);
        expect(cats).not.toContain("Home");
        expect(cats).not.toContain("Login");
        expect(cats).not.toContain("Cart");
        expect(cats).toContain("Sofas");
    });

    test("skips links with query strings", () => {
        const $ = load(`
            <nav>
                <a href="/search?q=sofa">Sofas</a>
                <a href="/chairs">Chairs</a>
            </nav>
        `);
        const cats = extractNavCategories($);
        // "Sofas" link has query string → should skip; "Chairs" is fine
        expect(cats).toContain("Chairs");
    });

    test("deduplicates entries", () => {
        const $ = load(`
            <nav>
                <a href="/sofas">Sofas</a>
                <a href="/sofas-2">Sofas</a>
            </nav>
        `);
        expect(extractNavCategories($).filter((c) => c === "Sofas").length).toBe(1);
    });

    test("limits to 15 entries", () => {
        const links = Array.from({ length: 20 }, (_, i) => `<a href="/cat-${i}">Category ${i}</a>`).join("");
        const $ = load(`<nav>${links}</nav>`);
        expect(extractNavCategories($).length).toBeLessThanOrEqual(15);
    });
});
