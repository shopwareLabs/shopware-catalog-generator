import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";

import {
    extractBrandDescription,
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
