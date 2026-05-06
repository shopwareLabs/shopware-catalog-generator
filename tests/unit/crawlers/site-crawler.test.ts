import { describe, expect, test } from "bun:test";

import { crawlForInspiration } from "../../../src/crawlers/site-crawler.js";
import { mockFetch } from "../../helpers/fetch-mock.js";

const PRODUCT_PAGE_HTML = `
<!DOCTYPE html>
<html>
<head>
    <meta name="theme-color" content="#3F51B5">
    <meta property="og:description" content="Scandinavian furniture for modern homes">
    <style>:root { --secondary-color: #FF9800; }</style>
    <script type="application/ld+json">
    {
        "@type": "BreadcrumbList",
        "itemListElement": [
            { "name": "Sofas", "position": 1 },
            { "name": "Dining Tables", "position": 2 }
        ]
    }
    </script>
    <script type="application/ld+json">
    { "@type": "Product", "name": "Oslo 3-Seater", "description": "Elegant fabric sofa." }
    </script>
</head>
<body>
    <a href="https://example.com/sofas/oslo-3-seater">Oslo 3-Seater</a>
</body>
</html>
`;

const CATEGORY_PAGE_HTML = `
<!DOCTYPE html>
<html>
<head>
    <script type="application/ld+json">
    {
        "@type": "ItemList",
        "itemListElement": [
            { "@type": "Product", "name": "Teak Chair" },
            { "@type": "Product", "name": "Oak Stool" }
        ]
    }
    </script>
</head>
<body><h1>Outdoor Furniture</h1></body>
</html>
`;

const CMS_PAGE_HTML = `
<!DOCTYPE html>
<html>
<head>
    <script type="application/ld+json">{ "@type": "Article", "name": "Our Story" }</script>
</head>
<body><h1>About Us</h1></body>
</html>
`;

describe("crawlForInspiration", () => {
    test("extracts products and categories from product pages, brand data from homepage", async () => {
        const origFetch = globalThis.fetch;
        mockFetch(async () => ({
            ok: true,
            headers: { get: () => "text/html" },
            text: async () => PRODUCT_PAGE_HTML,
        }));

        try {
            const result = await crawlForInspiration("https://example.com");

            expect(result.sourceUrl).toBe("https://example.com");
            expect(result.crawledAt).toBeDefined();

            // Categories from BreadcrumbList (homepage + sampled pages)
            expect(result.categories).toContain("Sofas");
            expect(result.categories).toContain("Dining Tables");

            // Products from Product JSON-LD
            expect(result.exampleProducts.some((p) => p.name === "Oslo 3-Seater")).toBe(true);

            // Brand colors from theme-color and CSS var
            expect(result.brandColors?.primary).toBe("#3f51b5");
            expect(result.brandColors?.secondary).toBe("#ff9800");

            // Description from og:description
            expect(result.brandDescription).toBe("Scandinavian furniture for modern homes");
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("throws when homepage URL is not fetchable", async () => {
        const origFetch = globalThis.fetch;
        mockFetch(async () => ({
            ok: false,
            headers: { get: () => "text/html" },
            text: async () => "",
        }));

        try {
            await expect(crawlForInspiration("https://unreachable.example")).rejects.toThrow();
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("extracts category name and products from category pages", async () => {
        const homepageHtml = `
            <html><head></head>
            <body>
                <a href="https://example.com/outdoor">Outdoor</a>
            </body></html>
        `;
        const origFetch = globalThis.fetch;
        let callCount = 0;
        mockFetch(async () => {
            const html = callCount++ === 0 ? homepageHtml : CATEGORY_PAGE_HTML;
            return { ok: true, headers: { get: () => "text/html" }, text: async () => html };
        });

        try {
            const result = await crawlForInspiration("https://example.com");
            // Category name from h1 (no BreadcrumbList on this page)
            expect(result.categories).toContain("Outdoor Furniture");
            // Products from ItemList
            expect(result.exampleProducts.some((p) => p.name === "Teak Chair")).toBe(true);
            expect(result.exampleProducts.some((p) => p.name === "Oak Stool")).toBe(true);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("skips CMS pages — no products or categories extracted", async () => {
        const origFetch = globalThis.fetch;
        mockFetch(async () => ({
            ok: true,
            headers: { get: () => "text/html" },
            text: async () => CMS_PAGE_HTML,
        }));

        try {
            const result = await crawlForInspiration("https://example.com");
            expect(result.categories).not.toContain("About Us");
            expect(result.exampleProducts).toHaveLength(0);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("returns null for non-HTML content-type", async () => {
        const origFetch = globalThis.fetch;
        mockFetch(async () => ({
            ok: true,
            headers: { get: () => "application/json" },
            text: async () => "{}",
        }));

        try {
            await expect(crawlForInspiration("https://example.com")).rejects.toThrow();
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("extracts product name from single h1 when no JSON-LD Product", async () => {
        // Homepage links to product page; product page has og:type=product and a single h1
        const homepageHtml = `
            <!DOCTYPE html><html><head></head>
            <body><a href="https://example.com/products/leather-wallet">Wallet</a></body>
            </html>`;
        const productPageHtml = `
            <!DOCTYPE html><html>
            <head><meta property="og:type" content="product"></head>
            <body><h1>Leather Wallet</h1><p>19,99 €</p></body>
            </html>`;
        const origFetch = globalThis.fetch;
        mockFetch(async (input) => {
            const url = input.toString();
            const html = url === "https://example.com" ? homepageHtml : productPageHtml;
            return { ok: true, headers: { get: () => "text/html" }, text: async () => html };
        });

        try {
            const result = await crawlForInspiration("https://example.com");
            expect(result.exampleProducts.some((p) => p.name === "Leather Wallet")).toBe(true);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("extracts product name from itemprop when no JSON-LD and multiple h1s", async () => {
        const homepageHtml = `
            <!DOCTYPE html><html><head></head>
            <body><a href="https://example.com/products/backpack">Backpack</a></body>
            </html>`;
        const itempropPage = `
            <!DOCTYPE html><html>
            <head><meta property="og:type" content="product"></head>
            <body>
                <h1>Store Header</h1><h1>Sub Header</h1>
                <div itemtype="https://schema.org/Product" itemscope>
                    <span itemprop="name">Canvas Backpack</span>
                    <span itemprop="price">49,99</span>
                </div>
            </body>
            </html>`;
        const origFetch = globalThis.fetch;
        mockFetch(async (input) => {
            const url = input.toString();
            const html = url === "https://example.com" ? homepageHtml : itempropPage;
            return { ok: true, headers: { get: () => "text/html" }, text: async () => html };
        });

        try {
            const result = await crawlForInspiration("https://example.com");
            expect(result.exampleProducts.some((p) => p.name === "Canvas Backpack")).toBe(true);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("extracts products from data-product-information on category pages (Shopware 6)", async () => {
        const prices = Array(10).fill("49,99 €").join(" ");
        const homepageHtml = `
            <!DOCTYPE html><html><head></head>
            <body><a href="https://example.com/kategorie/jackets">Jackets</a></body>
            </html>`;
        const shopwareCategoryHtml = `
            <!DOCTYPE html><html><head></head>
            <body>
                ${prices}
                <h1>Jackets</h1>
                <div data-product-information='{"name":"Alpine Pro Jacket","productNumber":"SW-001"}'></div>
                <div data-product-information='{"name":"Trail Wind Jacket","productNumber":"SW-002"}'></div>
                <div data-product-information='{"productNumber":"SW-003"}'></div>
            </body>
            </html>`;
        const origFetch = globalThis.fetch;
        mockFetch(async (input) => {
            const url = input.toString();
            const html = url === "https://example.com" ? homepageHtml : shopwareCategoryHtml;
            return { ok: true, headers: { get: () => "text/html" }, text: async () => html };
        });

        try {
            const result = await crawlForInspiration("https://example.com");
            expect(result.exampleProducts.some((p) => p.name === "Alpine Pro Jacket")).toBe(true);
            expect(result.exampleProducts.some((p) => p.name === "Trail Wind Jacket")).toBe(true);
            expect(result.exampleProducts.every((p) => p.name !== undefined)).toBe(true);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("extracts products from h2+price-sibling on category pages (mey.com-style)", async () => {
        const prices = Array(10).fill("39,95 €").join(" ");
        const homepageHtml = `
            <!DOCTYPE html><html><head></head>
            <body><a href="https://example.com/herren/slips">Slips</a></body>
            </html>`;
        const categoryHtml = `
            <!DOCTYPE html><html><head></head>
            <body>
                ${prices}
                <h1>Slips</h1>
                <div class="product-card">
                    <a href="/shorty-taeby/p/"><h2>Shorty Serie Taeby</h2></a>
                    <span class="price">39,95 €</span>
                </div>
                <div class="product-card">
                    <a href="/slip-noblesse/p/"><h2>Slip Serie Noblesse</h2></a>
                    <span class="price">24,95 €</span>
                </div>
            </body>
            </html>`;
        const origFetch = globalThis.fetch;
        mockFetch(async (input) => {
            const url = input.toString();
            const html = url === "https://example.com" ? homepageHtml : categoryHtml;
            return { ok: true, headers: { get: () => "text/html" }, text: async () => html };
        });

        try {
            const result = await crawlForInspiration("https://example.com");
            expect(result.exampleProducts.some((p) => p.name === "Shorty Serie Taeby")).toBe(true);
            expect(result.exampleProducts.some((p) => p.name === "Slip Serie Noblesse")).toBe(true);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("Phase 4: follows links on category pages to find products when < 5 products found", async () => {
        const homepageHtml = `
            <!DOCTYPE html><html><head></head>
            <body><a href="https://example.com/shoes">Shoes</a></body>
            </html>`;
        const categoryPageHtml = `
            <!DOCTYPE html><html><head></head>
            <body>
                <h1>Running Shoes</h1>
                <a href="https://example.com/shoes/trail-runner">Trail Runner</a>
                <a href="https://example.com/shoes/road-runner">Road Runner</a>
                ${Array(10).fill("89,99 €").join(" ")}
            </body>
            </html>`;
        const productPageHtml = `
            <!DOCTYPE html><html>
            <head><meta property="og:type" content="product"></head>
            <body><h1>Trail Runner</h1><p>89,99 €</p></body>
            </html>`;

        const origFetch = globalThis.fetch;
        mockFetch(async (input) => {
            const url = input.toString();
            if (url === "https://example.com")
                return {
                    ok: true,
                    headers: { get: () => "text/html" },
                    text: async () => homepageHtml,
                };
            if (url.startsWith("https://example.com/shoes/"))
                return {
                    ok: true,
                    headers: { get: () => "text/html" },
                    text: async () => productPageHtml,
                };
            return {
                ok: true,
                headers: { get: () => "text/html" },
                text: async () => categoryPageHtml,
            };
        });

        try {
            const result = await crawlForInspiration("https://example.com");
            expect(result.exampleProducts.some((p) => p.name === "Trail Runner")).toBe(true);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("deduplicates products with the same name", async () => {
        const origFetch = globalThis.fetch;
        mockFetch(async () => ({
            ok: true,
            headers: { get: () => "text/html" },
            text: async () => PRODUCT_PAGE_HTML,
        }));

        try {
            const result = await crawlForInspiration("https://example.com");
            const names = result.exampleProducts.map((p) => p.name);
            const uniqueNames = new Set(names);
            expect(names.length).toBe(uniqueNames.size);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("near-white brand colors are filtered out, falling back to CSS var", async () => {
        const nearWhiteHtml = `
            <!DOCTYPE html><html>
            <head>
                <meta name="theme-color" content="#f8f8f8">
                <style>:root { --color-primary: #e63946; }</style>
            </head>
            <body></body>
            </html>
        `;
        const origFetch = globalThis.fetch;
        mockFetch(async () => ({
            ok: true,
            headers: { get: () => "text/html" },
            text: async () => nearWhiteHtml,
        }));

        try {
            const result = await crawlForInspiration("https://example.com");
            // Near-white #f8f8f8 should be skipped; CSS var fallback should be used
            expect(result.brandColors?.primary).not.toBe("#f8f8f8");
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});
