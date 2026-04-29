import { describe, expect, test } from "bun:test";

import * as cheerio from "cheerio";

import {
    extractBrandDescriptionFromJsonLd,
    extractCategoriesFromJsonLd,
    extractProductsFromJsonLd,
} from "../../../src/crawlers/extractors/json-ld.js";

function load(html: string) {
    return cheerio.load(html);
}

describe("extractCategoriesFromJsonLd", () => {
    test("extracts names from BreadcrumbList", () => {
        const $ = load(`
            <script type="application/ld+json">
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    { "@type": "ListItem", "name": "Sofas", "position": 1 },
                    { "@type": "ListItem", "name": "Dining Tables", "position": 2 }
                ]
            }
            </script>
        `);
        const cats = extractCategoriesFromJsonLd($);
        expect(cats).toContain("Sofas");
        expect(cats).toContain("Dining Tables");
    });

    test("deduplicates categories", () => {
        const $ = load(`
            <script type="application/ld+json">
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    { "name": "Sofas" },
                    { "name": "Sofas" }
                ]
            }
            </script>
        `);
        const cats = extractCategoriesFromJsonLd($);
        expect(cats.filter((c) => c === "Sofas").length).toBe(1);
    });

    test("skips items with names that are too long or too short", () => {
        const $ = load(`
            <script type="application/ld+json">
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    { "name": "A" },
                    { "name": "${"X".repeat(61)}" }
                ]
            }
            </script>
        `);
        expect(extractCategoriesFromJsonLd($)).toHaveLength(0);
    });

    test("handles @graph wrapper", () => {
        const $ = load(`
            <script type="application/ld+json">
            {
                "@graph": [
                    {
                        "@type": "BreadcrumbList",
                        "itemListElement": [{ "name": "Lighting" }]
                    }
                ]
            }
            </script>
        `);
        expect(extractCategoriesFromJsonLd($)).toContain("Lighting");
    });

    test("returns empty array when no JSON-LD present", () => {
        const $ = load(`<html><body></body></html>`);
        expect(extractCategoriesFromJsonLd($)).toHaveLength(0);
    });
});

describe("extractProductsFromJsonLd", () => {
    test("extracts products from Product blocks", () => {
        const $ = load(`
            <script type="application/ld+json">
            {
                "@type": "Product",
                "name": "Oak Dining Table",
                "description": "A sturdy oak dining table for 6 people."
            }
            </script>
        `);
        const products = extractProductsFromJsonLd($);
        expect(products).toHaveLength(1);
        expect(products[0]?.name).toBe("Oak Dining Table");
        expect(products[0]?.description).toContain("sturdy oak");
    });

    test("extracts products from ItemList blocks", () => {
        const $ = load(`
            <script type="application/ld+json">
            {
                "@type": "ItemList",
                "itemListElement": [
                    { "@type": "ListItem", "item": { "@type": "Product", "name": "Red Chair" } },
                    { "@type": "ListItem", "item": { "@type": "Product", "name": "Blue Sofa" } }
                ]
            }
            </script>
        `);
        const products = extractProductsFromJsonLd($);
        expect(products.map((p) => p.name)).toContain("Red Chair");
        expect(products.map((p) => p.name)).toContain("Blue Sofa");
    });

    test("truncates long descriptions to 300 chars", () => {
        const longDesc = "X".repeat(500);
        const $ = load(`
            <script type="application/ld+json">
            { "@type": "Product", "name": "Test", "description": "${longDesc}" }
            </script>
        `);
        const products = extractProductsFromJsonLd($);
        expect(products[0]?.description?.length).toBeLessThanOrEqual(300);
    });
});

describe("extractBrandDescriptionFromJsonLd", () => {
    test("extracts description from Organization block", () => {
        const $ = load(`
            <script type="application/ld+json">
            { "@type": "Organization", "description": "Premium furniture for modern homes" }
            </script>
        `);
        expect(extractBrandDescriptionFromJsonLd($)).toBe(
            "Premium furniture for modern homes"
        );
    });

    test("extracts description from WebSite block", () => {
        const $ = load(`
            <script type="application/ld+json">
            { "@type": "WebSite", "description": "Your one-stop shop for outdoor living" }
            </script>
        `);
        expect(extractBrandDescriptionFromJsonLd($)).toBe(
            "Your one-stop shop for outdoor living"
        );
    });

    test("returns undefined when no matching block", () => {
        const $ = load(`<html></html>`);
        expect(extractBrandDescriptionFromJsonLd($)).toBeUndefined();
    });
});
