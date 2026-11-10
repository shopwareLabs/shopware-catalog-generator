import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";

import {
    extractBrandDescriptionFromJsonLd,
    extractCategoriesFromJsonLd,
    extractCategoriesFromMicrodata,
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

    test("extracts products from ItemList blocks when items have @type Product", () => {
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

    test("skips ItemList items without @type Product (e.g. IKEA category navigation)", () => {
        const $ = load(`
            <script type="application/ld+json">
            {
                "@type": "ItemList",
                "name": "Produkte",
                "itemListElement": [
                    { "@type": "ListItem", "item": { "@type": "Thing", "name": "Beleuchtung" } },
                    { "@type": "ListItem", "item": { "@type": "Thing", "name": "Badezimmer" } },
                    { "@type": "ListItem", "item": { "@type": "Product", "name": "SYMFONISK Speaker" } }
                ]
            }
            </script>
        `);
        const products = extractProductsFromJsonLd($);
        expect(products).toHaveLength(1);
        expect(products[0]?.name).toBe("SYMFONISK Speaker");
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

    test("extracts brand, color, material as properties", () => {
        const $ = load(`
            <script type="application/ld+json">
            {
                "@type": "Product",
                "name": "Running Shoe X",
                "brand": { "name": "Nike" },
                "color": "white",
                "material": "mesh"
            }
            </script>
        `);
        const products = extractProductsFromJsonLd($);
        expect(products[0]?.properties?.["brand"]).toBe("Nike");
        expect(products[0]?.properties?.["color"]).toBe("white");
        expect(products[0]?.properties?.["material"]).toBe("mesh");
    });

    test("extracts additionalProperty values", () => {
        const $ = load(`
            <script type="application/ld+json">
            {
                "@type": "Product",
                "name": "Widget",
                "additionalProperty": [
                    { "@type": "PropertyValue", "name": "Size", "value": "42" },
                    { "@type": "PropertyValue", "name": "Weight", "value": "250g" }
                ]
            }
            </script>
        `);
        const products = extractProductsFromJsonLd($);
        expect(products[0]?.properties?.["size"]).toBe("42");
        expect(products[0]?.properties?.["weight"]).toBe("250g");
    });

    test("omits properties field when none present", () => {
        const $ = load(`
            <script type="application/ld+json">
            { "@type": "Product", "name": "Plain Product" }
            </script>
        `);
        const products = extractProductsFromJsonLd($);
        expect(products[0]?.properties).toBeUndefined();
    });

    test("extracts brand as string (not object)", () => {
        const $ = load(`
            <script type="application/ld+json">
            { "@type": "Product", "name": "T-Shirt", "brand": "Adidas" }
            </script>
        `);
        const products = extractProductsFromJsonLd($);
        expect(products[0]?.properties?.["brand"]).toBe("Adidas");
    });
});

describe("extractBrandDescriptionFromJsonLd", () => {
    test("extracts description from Organization block", () => {
        const $ = load(`
            <script type="application/ld+json">
            { "@type": "Organization", "description": "Premium furniture for modern homes" }
            </script>
        `);
        expect(extractBrandDescriptionFromJsonLd($)).toBe("Premium furniture for modern homes");
    });

    test("extracts description from WebSite block", () => {
        const $ = load(`
            <script type="application/ld+json">
            { "@type": "WebSite", "description": "Your one-stop shop for outdoor living" }
            </script>
        `);
        expect(extractBrandDescriptionFromJsonLd($)).toBe("Your one-stop shop for outdoor living");
    });

    test("returns undefined when no matching block", () => {
        const $ = load(`<html></html>`);
        expect(extractBrandDescriptionFromJsonLd($)).toBeUndefined();
    });
});

describe("extractCategoriesFromMicrodata", () => {
    test("extracts names from microdata BreadcrumbList (Shopware 5 / older Magento)", () => {
        const $ = load(`
            <ol itemtype="https://schema.org/BreadcrumbList" itemscope>
                <li itemprop="itemListElement" itemscope>
                    <span itemprop="name">Outdoor</span>
                </li>
                <li itemprop="itemListElement" itemscope>
                    <span itemprop="name">Jackets</span>
                </li>
            </ol>
        `);
        const cats = extractCategoriesFromMicrodata($);
        expect(cats).toContain("Outdoor");
        expect(cats).toContain("Jackets");
    });

    test("returns empty when no BreadcrumbList itemtype", () => {
        const $ = load(
            `<ol itemtype="https://schema.org/ItemList"><li itemprop="name">X</li></ol>`
        );
        expect(extractCategoriesFromMicrodata($)).toHaveLength(0);
    });

    test("deduplicates microdata breadcrumb entries", () => {
        const $ = load(`
            <ol itemtype="https://schema.org/BreadcrumbList" itemscope>
                <li itemprop="itemListElement"><span itemprop="name">Shoes</span></li>
                <li itemprop="itemListElement"><span itemprop="name">Shoes</span></li>
            </ol>
        `);
        expect(extractCategoriesFromMicrodata($)).toHaveLength(1);
    });
});

describe("extractProductsFromJsonLd — ProductGroup.category", () => {
    test("extracts category from ProductGroup.category string (Shopify pattern)", () => {
        const $ = load(`
            <script type="application/ld+json">
            {
                "@type": "ProductGroup",
                "name": "Running Shorts",
                "category": "shorts",
                "offers": {}
            }
            </script>
        `);
        const cats = extractCategoriesFromJsonLd($);
        expect(cats).toContain("shorts");
    });

    test("extracts category from Product.category array", () => {
        const $ = load(`
            <script type="application/ld+json">
            {
                "@type": "Product",
                "name": "Trail Shoe",
                "category": ["Footwear", "Trail Running"],
                "offers": {}
            }
            </script>
        `);
        const cats = extractCategoriesFromJsonLd($);
        expect(cats).toContain("Footwear");
        expect(cats).toContain("Trail Running");
    });
});

function jsonLd(data: unknown): ReturnType<typeof load> {
    return load(`<script type="application/ld+json">${JSON.stringify(data)}</script>`);
}

describe("extractCategoriesFromJsonLd — edge cases", () => {
    test("reads nested item.name, trims names and skips non-string names", () => {
        const $ = jsonLd({
            "@type": "https://schema.org/BreadcrumbList",
            itemListElement: [
                { item: { name: "  Lighting  " } },
                { name: 42 },
                { position: 3 },
                { name: "Desk Lamps", item: { name: "Ignored" } },
            ],
        });
        expect(extractCategoriesFromJsonLd($)).toEqual(["Lighting", "Desk Lamps"]);
    });

    test("combines breadcrumbs and product categories in block order, deduplicated", () => {
        const $ = jsonLd([
            { "@type": "BreadcrumbList", itemListElement: [{ name: "Shoes" }] },
            { "@type": ["Product"], name: "Runner", category: ["Shoes", " ", "Running"] },
            { "@type": "ProductGroup", name: "Group", category: 7 },
            { "@type": "Product", name: "No category" },
        ]);
        expect(extractCategoriesFromJsonLd($)).toEqual(["Shoes", "Running"]);
    });

    test("ignores malformed JSON-LD blocks", () => {
        const $ = load(`
            <script type="application/ld+json">{ not json</script>
            <script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[{"name":"Bags"}]}</script>
        `);
        expect(extractCategoriesFromJsonLd($)).toEqual(["Bags"]);
    });
});

describe("extractProductsFromJsonLd — edge cases", () => {
    test("builds properties from brand, color, material and additionalProperty", () => {
        const $ = jsonLd({
            "@type": "Product",
            name: "Lamp",
            brand: { name: "Lumo" },
            color: "Blue",
            material: "Steel",
            additionalProperty: [
                { name: "Color", value: "Red" },
                { name: "Pack Size", value: 6 },
                { name: "Weight", value: 0 },
                { name: "Empty" },
                { value: "no name" },
            ],
        });
        expect(extractProductsFromJsonLd($)[0]?.properties).toEqual({
            brand: "Lumo",
            color: "Blue",
            material: "Steel",
            pack_size: "6",
            weight: "0",
        });
    });

    test("omits brand without a name and non-string color or material", () => {
        const $ = jsonLd({
            "@type": "Product",
            name: "Lamp",
            brand: {},
            color: 5,
            material: ["Steel"],
            additionalProperty: "not an array",
        });
        expect(extractProductsFromJsonLd($)[0]?.properties).toBeUndefined();
    });

    test("takes the first trimmed category of an array and drops an empty one", () => {
        const $ = jsonLd([
            { "@type": "Product", name: " Chair ", category: [" Seating ", "Other"] },
            { "@type": "Product", name: "Stool", category: "  " },
            { "@type": "Product", name: "   " },
        ]);
        const products = extractProductsFromJsonLd($);
        expect(products.map((p) => [p.name, p.category])).toEqual([
            ["Chair", "Seating"],
            ["Stool", undefined],
        ]);
    });

    test("ItemList: uses item when present and requires @type Product on it", () => {
        const $ = jsonLd({
            "@type": "ItemList",
            itemListElement: [
                { position: 1, item: { "@type": "Product", name: "Nested Product" } },
                { "@type": "Product", position: 2, item: { "@type": "Thing", name: "Thing" } },
                { "@type": "Product", position: 3, name: "Direct Product" },
                { "@type": "Product", position: 4, name: " " },
                { position: 5, name: "Untyped" },
            ],
        });
        expect(extractProductsFromJsonLd($).map((p) => p.name)).toEqual([
            "Nested Product",
            "Direct Product",
        ]);
    });

    test("ItemList without itemListElement yields nothing", () => {
        expect(extractProductsFromJsonLd(jsonLd({ "@type": "ItemList" }))).toEqual([]);
    });
});
