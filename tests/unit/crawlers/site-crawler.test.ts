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

describe("crawlForInspiration — characterization", () => {
    /** Route fetches by exact URL; unknown URLs (robots.txt, sitemap, icons) fail. Records page fetches. */
    function routeHtml(routes: Record<string, string>): string[] {
        const calls: string[] = [];
        mockFetch(async (input) => {
            const url = input.toString();
            calls.push(url);
            const html = routes[url];
            if (html === undefined) {
                return { ok: false, headers: { get: () => "text/html" }, text: async () => "" };
            }
            return { ok: true, headers: { get: () => "text/html" }, text: async () => html };
        });
        return calls;
    }

    function html(head: string, body = ""): string {
        return `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`;
    }

    const PRICES = Array(10).fill("19,99 €").join(" ");

    test("homepage link discovery skips anchors, mail, phone, external, query and duplicate links", async () => {
        const origFetch = globalThis.fetch;
        const home = html(
            "",
            `<a href="#top">Top</a>
             <a href="mailto:a@example.com">Mail</a>
             <a href="tel:123">Call</a>
             <a href="https://other.com/x">External</a>
             <a href="/search?q=1">Query</a>
             <a href="/page#section">Fragment</a>
             <a href="https://example.com/">Root</a>
             <a href="/b">B</a>
             <a href="/b">B again</a>
             <a href="http://[bad">Bad</a>
             <a href="/c">C</a>`
        );
        const calls = routeHtml({ "https://example.com": home });

        try {
            await crawlForInspiration("https://example.com");
            const pageFetches = calls.filter(
                (c) => !c.includes("robots.txt") && !c.includes("sitemap") && !c.includes("icon")
            );
            expect(pageFetches.slice(1).sort()).toEqual([
                "https://example.com/b",
                "https://example.com/c",
            ]);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("homepage link discovery stops at 100 links", async () => {
        const origFetch = globalThis.fetch;
        const links = Array.from({ length: 120 }, (_, i) => `<a href="/p-${i}">P</a>`).join("");
        const calls = routeHtml({ "https://example.com": html("", links) });

        try {
            await crawlForInspiration("https://example.com");
            const pageFetches = calls.filter((c) => /\/p-\d+$/.test(c));
            // sampleUrls caps at 30; all sampled links come from the first 100
            expect(pageFetches).toHaveLength(30);
            expect(pageFetches.every((c) => Number(c.split("-").pop()) < 100)).toBe(true);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("JSON-LD product without description uses og:description, cut to 300 chars", async () => {
        const origFetch = globalThis.fetch;
        const longDesc = "x".repeat(400);
        routeHtml({
            "https://example.com": html("", `<a href="/p1">1</a><a href="/p2">2</a>`),
            "https://example.com/p1": html(
                `<meta property="og:description" content="  ${longDesc}  ">
                 <script type="application/ld+json">{"@type":"Product","name":"Lamp One","offers":{}}</script>`
            ),
            "https://example.com/p2": html(
                `<meta name="description" content="Meta text">
                 <script type="application/ld+json">{"@type":"Product","name":"Lamp Two","offers":{}}</script>`
            ),
        });

        try {
            const result = await crawlForInspiration("https://example.com");
            const byName = new Map(result.exampleProducts.map((p) => [p.name, p]));
            expect(byName.get("Lamp One")?.description).toBe("x".repeat(300));
            expect(byName.get("Lamp Two")?.description).toBe("Meta text");
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("product without JSON-LD: h1 length bounds, microdata and meta descriptions", async () => {
        const origFetch = globalThis.fetch;
        const og = `<meta property="og:type" content="product">`;
        routeHtml({
            "https://example.com": html(
                "",
                `<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>`
            ),
            // single h1 with microdata description
            "https://example.com/a": html(
                og,
                `<h1>  Desk   Lamp </h1>
                 <div itemscope itemtype="https://schema.org/Product">
                    <span itemprop="description">Warm light</span>
                 </div>`
            ),
            // h1 too short, falls back to itemprop name; meta description
            "https://example.com/b": html(
                `${og}<meta name="description" content="From meta">`,
                `<h1>Ab</h1>
                 <div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Floor Lamp</span></div>`
            ),
            // no usable name at all
            "https://example.com/c": html(og, `<h1>X</h1>`),
        });

        try {
            const result = await crawlForInspiration("https://example.com");
            expect(result.exampleProducts).toEqual([
                { name: "Desk Lamp", description: "Warm light" },
                { name: "Floor Lamp", description: "From meta" },
            ]);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("product breadcrumbs skip home, account-like and duplicate categories", async () => {
        const origFetch = globalThis.fetch;
        routeHtml({
            "https://example.com": html("", `<a href="/p">p</a>`),
            "https://example.com/p": html(
                `<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[
                    {"name":"Home"},{"name":"Kontakt"},{"name":"Lamps"},{"name":"lamps"},
                    {"name":"${"y".repeat(59)}"}]}</script>
                 <script type="application/ld+json">{"@type":"Product","name":"Lamp","offers":{}}</script>`,
                `<ol itemscope itemtype="https://schema.org/BreadcrumbList">
                    <li itemprop="itemListElement"><span itemprop="name">Desk Lamps</span></li>
                 </ol>`
            ),
        });

        try {
            const result = await crawlForInspiration("https://example.com");
            expect(result.categories).toEqual(["Lamps", "y".repeat(59), "Desk Lamps"]);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("category name prefers the last non-home breadcrumb over the h1", async () => {
        const origFetch = globalThis.fetch;
        routeHtml({
            "https://example.com": html("", `<a href="/c1">1</a><a href="/c2">2</a>`),
            "https://example.com/c1": html(
                `<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[
                    {"name":"Shop"},{"name":"Outdoor"},{"name":"Startseite"}]}</script>`,
                `<h1>Ignored</h1>${PRICES}`
            ),
            "https://example.com/c2": html(
                "",
                `<ol itemscope itemtype="https://schema.org/BreadcrumbList">
                    <li itemprop="itemListElement"><span itemprop="name">Garden</span></li>
                    <li itemprop="itemListElement"><span itemprop="name">Home</span></li>
                 </ol><h1>Ignored too</h1>${PRICES}`
            ),
        });

        try {
            const result = await crawlForInspiration("https://example.com");
            expect(result.categories).toEqual(["Outdoor", "Garden"]);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("category page microdata products are used when no JSON-LD or data attributes exist", async () => {
        const origFetch = globalThis.fetch;
        routeHtml({
            "https://example.com": html("", `<a href="/c">c</a>`),
            "https://example.com/c": html(
                "",
                `<h1>Chairs</h1>
                 <div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Oak Chair</span>
                    <span itemprop="description">Solid oak</span></div>
                 <div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Ash Chair</span></div>
                 <div itemscope itemtype="https://schema.org/Product"><span itemprop="name">No</span></div>`
            ),
        });

        try {
            const result = await crawlForInspiration("https://example.com");
            expect(result.exampleProducts).toEqual([
                { name: "Oak Chair", description: "Solid oak" },
                { name: "Ash Chair", description: undefined },
            ]);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("Phase 4 follows a second level when the first level is all category pages", async () => {
        const origFetch = globalThis.fetch;
        routeHtml({
            "https://example.com": html("", `<a href="/a">a</a>`),
            "https://example.com/a": html("", `<h1>Level A</h1>${PRICES}<a href="/a/sub">sub</a>`),
            "https://example.com/a/sub": html(
                "",
                `<h1>Level B</h1>${PRICES}<a href="/a">back</a><a href="/a/sub/p">p</a>`
            ),
            "https://example.com/a/sub/p": html(
                `<meta property="og:type" content="product">`,
                `<h1>Deep Product</h1>`
            ),
        });

        try {
            const result = await crawlForInspiration("https://example.com");
            expect(result.exampleProducts.map((p) => p.name)).toEqual(["Deep Product"]);
            // Level-1 category names are not added to the category list
            expect(result.categories).toEqual(["Level A"]);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("Phase 4 is skipped when the sample already yields five products", async () => {
        const origFetch = globalThis.fetch;
        const cards = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]
            .map(
                (n) =>
                    `<div data-product-information='{"name":"${n}","description":"${n} text"}'></div>`
            )
            .join("");
        const calls = routeHtml({
            "https://example.com": html("", `<a href="/c">c</a>`),
            "https://example.com/c": html(
                "",
                `<h1>Cards</h1>${PRICES}${cards}<a href="/c/p">p</a>`
            ),
            "https://example.com/c/p": html(
                `<meta property="og:type" content="product">`,
                `<h1>Followed Product</h1>`
            ),
        });

        try {
            const result = await crawlForInspiration("https://example.com");
            expect(result.exampleProducts.map((p) => p.name)).toEqual([
                "Alpha",
                "Bravo",
                "Charlie",
                "Delta",
                "Echo",
            ]);
            expect(result.exampleProducts[0]?.description).toBe("Alpha text");
            expect(calls).not.toContain("https://example.com/c/p");
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("deduplicates products case-insensitively, keeping the first", async () => {
        const origFetch = globalThis.fetch;
        routeHtml({
            "https://example.com": html("", `<a href="/c">c</a>`),
            "https://example.com/c": html(
                `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[
                    {"@type":"Product","name":"Oak Chair"},{"@type":"Product","name":"OAK CHAIR"}]}</script>`
            ),
        });

        try {
            const result = await crawlForInspiration("https://example.com");
            expect(result.exampleProducts.map((p) => p.name)).toEqual(["Oak Chair"]);
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});
