import { describe, expect, test } from "bun:test";

import { discoverFromSitemap, sampleUrls } from "../../../src/crawlers/extractors/sitemap.js";
import { mockFetch } from "../../helpers/fetch-mock.js";

const FLAT_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://shop.test/clothing/shirts/blue-oxford/</loc></url>
    <url><loc>https://shop.test/clothing/pants/chinos/</loc></url>
    <url><loc>https://shop.test/shoes/sneakers/air-max/</loc></url>
    <url><loc>https://shop.test/blog/summer-trends/</loc></url>
    <url><loc>https://shop.test/account/orders/</loc></url>
    <url><loc>https://shop.test/clothing/</loc></url>
</urlset>`;

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap><loc>https://shop.test/sitemap-product.xml</loc></sitemap>
    <sitemap><loc>https://shop.test/sitemap-cms.xml</loc></sitemap>
</sitemapindex>`;

const PRODUCT_SUB_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://shop.test/bikes/hardtail/tues-al-3/</loc></url>
    <url><loc>https://shop.test/bikes/hardtail/capra-al-base/</loc></url>
    <url><loc>https://shop.test/apparel/jerseys/speed-jersey/</loc></url>
</urlset>`;

function setupRoutedFetch(responses: Record<string, string>): void {
    mockFetch(async (input) => {
        const url = input.toString();
        const body = responses[url] ?? null;
        return {
            ok: body !== null,
            text: async () => body ?? "",
            headers: { get: () => null },
        };
    });
}

describe("discoverFromSitemap", () => {
    test("collects all URLs from a flat sitemap", async () => {
        const origFetch = globalThis.fetch;
        setupRoutedFetch({ "https://shop.test/sitemap.xml": FLAT_SITEMAP });

        try {
            const urls = await discoverFromSitemap("https://shop.test");
            expect(urls).toContain("https://shop.test/clothing/shirts/blue-oxford/");
            expect(urls).toContain("https://shop.test/shoes/sneakers/air-max/");
            expect(urls).toContain("https://shop.test/blog/summer-trends/");
            expect(urls).toContain("https://shop.test/account/orders/");
            expect(urls).toContain("https://shop.test/clothing/");
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("follows sub-sitemaps in a sitemap index", async () => {
        const origFetch = globalThis.fetch;
        setupRoutedFetch({
            "https://shop.test/sitemap.xml": SITEMAP_INDEX,
            "https://shop.test/sitemap-product.xml": PRODUCT_SUB_SITEMAP,
        });

        try {
            const urls = await discoverFromSitemap("https://shop.test");
            expect(urls).toContain("https://shop.test/bikes/hardtail/tues-al-3/");
            expect(urls).toContain("https://shop.test/apparel/jerseys/speed-jersey/");
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("returns empty when sitemap.xml is not found", async () => {
        const origFetch = globalThis.fetch;
        mockFetch(async () => ({ ok: false, text: async () => "", headers: { get: () => null } }));

        try {
            const urls = await discoverFromSitemap("https://shop.test");
            expect(urls).toHaveLength(0);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("returns empty when response is HTML (not a sitemap)", async () => {
        const origFetch = globalThis.fetch;
        mockFetch(async () => ({
            ok: true,
            text: async () => "<html><body><h1>Shop</h1></body></html>",
            headers: { get: () => null },
        }));

        try {
            const urls = await discoverFromSitemap("https://shop.test");
            expect(urls).toHaveLength(0);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("collects all Sitemap directives from robots.txt, deprioritises editorial", async () => {
        const robotsTxt = [
            "User-agent: *",
            "Disallow: /admin/",
            "Sitemap: https://shop.test/magazin/sitemap_index.xml",
            "Sitemap: https://shop.test/sitemap.xml",
        ].join("\n");
        const editorialSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset><url><loc>https://shop.test/magazin/article-1/</loc></url></urlset>`;

        const origFetch = globalThis.fetch;
        setupRoutedFetch({
            "https://shop.test/robots.txt": robotsTxt,
            "https://shop.test/sitemap.xml": FLAT_SITEMAP,
            "https://shop.test/magazin/sitemap_index.xml": editorialSitemap,
        });

        try {
            const urls = await discoverFromSitemap("https://shop.test");
            // Product sitemap must win over editorial (deprioritized by sort)
            expect(urls).toContain("https://shop.test/clothing/shirts/blue-oxford/");
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("gzip sitemap (URL ends .gz) is decompressed", async () => {
        const robotsTxt = "Sitemap: https://shop.test/sitemap.xml.gz";
        const gzipped = Bun.gzipSync(Buffer.from(FLAT_SITEMAP));

        const origFetch = globalThis.fetch;
        mockFetch(async (input) => {
            const url = input.toString();
            if (url === "https://shop.test/robots.txt") {
                return { ok: true, text: async () => robotsTxt, headers: { get: () => null } };
            }
            if (url === "https://shop.test/sitemap.xml.gz") {
                return {
                    ok: true,
                    arrayBuffer: async () => gzipped.buffer,
                    headers: { get: () => null },
                };
            }
            return { ok: false, text: async () => "", headers: { get: () => null } };
        });

        try {
            const urls = await discoverFromSitemap("https://shop.test");
            expect(urls).toContain("https://shop.test/clothing/shirts/blue-oxford/");
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("corrupted gzip returns no URLs (does not throw)", async () => {
        const origFetch = globalThis.fetch;
        mockFetch(async (input) => {
            const url = input.toString();
            if (url === "https://shop.test/sitemap.xml.gz") {
                return {
                    ok: true,
                    arrayBuffer: async () => new Uint8Array([0x00, 0x01, 0x02]).buffer,
                    headers: { get: () => null },
                };
            }
            return { ok: false, text: async () => "", headers: { get: () => null } };
        });

        try {
            const urls = await discoverFromSitemap("https://shop.test");
            expect(urls).toHaveLength(0);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("pathPrefix filters URLs to the given locale path", async () => {
        const localeSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
    <url><loc>https://shop.test/de/de/sofas/product-1/</loc></url>
    <url><loc>https://shop.test/de/de/chairs/product-2/</loc></url>
    <url><loc>https://shop.test/en/sofas/product-3/</loc></url>
</urlset>`;

        const origFetch = globalThis.fetch;
        setupRoutedFetch({
            "https://shop.test/robots.txt": "",
            "https://shop.test/sitemap.xml": localeSitemap,
        });

        try {
            // Base URL has /de/de/ path → only those URLs pass the prefix filter
            const urls = await discoverFromSitemap("https://shop.test/de/de/");
            expect(urls).toContain("https://shop.test/de/de/sofas/product-1/");
            expect(urls).toContain("https://shop.test/de/de/chairs/product-2/");
            expect(urls).not.toContain("https://shop.test/en/sofas/product-3/");
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("pathPrefix fallback collects all same-origin URLs when prefix matches nothing", async () => {
        const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
    <url><loc>https://shop.test/products/item-1/</loc></url>
    <url><loc>https://shop.test/products/item-2/</loc></url>
</urlset>`;

        const origFetch = globalThis.fetch;
        setupRoutedFetch({
            "https://shop.test/robots.txt": "",
            "https://shop.test/sitemap.xml": sitemap,
            "https://shop.test/de-eu/sitemap.xml": sitemap,
        });

        try {
            // /de-eu/ path → no sitemap URLs start with that prefix → fallback with no prefix
            const urls = await discoverFromSitemap("https://shop.test/de-eu/");
            expect(urls).toContain("https://shop.test/products/item-1/");
            expect(urls).toContain("https://shop.test/products/item-2/");
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("locale-specific sitemap candidate is tried for stores with a base path", async () => {
        const localeSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
    <url><loc>https://shop.test/com/products/item-1/</loc></url>
</urlset>`;

        const origFetch = globalThis.fetch;
        setupRoutedFetch({
            "https://shop.test/robots.txt": "",
            // /sitemap.xml returns nothing
            "https://shop.test/sitemap.xml": "<urlset></urlset>",
            // locale-specific sitemap at /com/sitemap.xml has real content
            "https://shop.test/com/sitemap.xml": localeSitemap,
        });

        try {
            const urls = await discoverFromSitemap("https://shop.test/com/");
            expect(urls).toContain("https://shop.test/com/products/item-1/");
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});

describe("sampleUrls", () => {
    test("returns all when count <= n", () => {
        const urls = ["https://shop.test/a/prod1", "https://shop.test/b/prod2"];
        expect(sampleUrls(urls, 5)).toEqual(urls);
    });

    test("distributes across top-level path branches", () => {
        const urls = [
            "https://shop.test/bikes/mtb/tues",
            "https://shop.test/bikes/mtb/capra",
            "https://shop.test/bikes/road/road-1",
            "https://shop.test/apparel/jersey-1",
            "https://shop.test/apparel/jersey-2",
            "https://shop.test/accessories/lock",
        ];
        const sampled = sampleUrls(urls, 3);
        expect(sampled).toHaveLength(3);
        const branches = sampled.map((u) => new URL(u).pathname.split("/")[1]);
        expect(new Set(branches).size).toBeGreaterThanOrEqual(2);
    });

    test("respects the n cap", () => {
        const urls = Array.from({ length: 50 }, (_, i) => `https://shop.test/cat/prod-${i}`);
        expect(sampleUrls(urls, 6)).toHaveLength(6);
    });
});
