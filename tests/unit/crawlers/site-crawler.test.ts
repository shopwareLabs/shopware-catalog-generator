import { describe, expect, mock, test } from "bun:test";

import { crawlForInspiration } from "../../../src/crawlers/site-crawler.js";

const PRODUCT_HTML = `
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
    <nav>
        <a href="/sofas">Sofas</a>
        <a href="/tables">Tables</a>
    </nav>
</body>
</html>
`;

describe("crawlForInspiration", () => {
    test("extracts categories, products, brand colors, and description", async () => {
        const fetchMock = mock(async (_url: string) => ({
            ok: true,
            headers: { get: () => "text/html" },
            text: async () => PRODUCT_HTML,
        }));

        // Override global fetch for this test
        const originalFetch = globalThis.fetch;
        // @ts-expect-error — mocking fetch
        globalThis.fetch = fetchMock;

        try {
            const result = await crawlForInspiration("https://example.com", {
                followCategoryPages: false,
            });

            expect(result.sourceUrl).toBe("https://example.com");
            expect(result.crawledAt).toBeDefined();

            // Categories from JSON-LD BreadcrumbList
            expect(result.categories).toContain("Sofas");
            expect(result.categories).toContain("Dining Tables");

            // Products from Product JSON-LD
            expect(result.exampleProducts).toHaveLength(1);
            expect(result.exampleProducts[0]?.name).toBe("Oslo 3-Seater");

            // Brand colors from theme-color and CSS var
            expect(result.brandColors?.primary).toBe("#3f51b5");
            expect(result.brandColors?.secondary).toBe("#ff9800");

            // Description from og:description
            expect(result.brandDescription).toBe("Scandinavian furniture for modern homes");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("throws when URL is not fetchable", async () => {
        const originalFetch = globalThis.fetch;
        // @ts-expect-error — mocking fetch
        globalThis.fetch = mock(async () => ({ ok: false, headers: { get: () => "text/html" }, text: async () => "" }));

        try {
            await expect(
                crawlForInspiration("https://unreachable.example", { followCategoryPages: false })
            ).rejects.toThrow();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("falls back to nav categories when no JSON-LD breadcrumbs", async () => {
        const html = `
            <html>
            <head><meta property="og:description" content="A test shop with varied furniture"></head>
            <body>
                <nav>
                    <a href="/chairs">Chairs</a>
                    <a href="/desks">Desks</a>
                </nav>
            </body>
            </html>
        `;

        const originalFetch = globalThis.fetch;
        // @ts-expect-error — mocking fetch
        globalThis.fetch = mock(async () => ({
            ok: true,
            headers: { get: () => "text/html" },
            text: async () => html,
        }));

        try {
            const result = await crawlForInspiration("https://example.com", {
                followCategoryPages: false,
            });
            expect(result.categories).toContain("Chairs");
            expect(result.categories).toContain("Desks");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
