/**
 * Crawler validation script — runs blueprint inspire against all known stores
 * and checks minimum expectations per store.
 *
 * Usage:
 *   bun run test:crawlers
 *
 * Run this after any change to src/crawlers/ to confirm no regressions.
 *
 * Results depend on live websites and are inherently flaky — a store can fail
 * at any time due to bot protection, sitemap changes, or HTML restructuring.
 * When that happens, update the thresholds or note in the spec below; don't
 * chase flaky failures by patching the crawler for one specific site.
 */

import type { InspirationData } from "../src/crawlers/index.js";

import { crawlForInspiration } from "../src/crawlers/index.js";

interface StoreSpec {
    name: string;
    url: string;
    platform: string;
    minCategories: number;
    minProducts: number;
    requireColors: boolean;
    skipOnFetchError?: boolean;
    note?: string;
}

const STORES: StoreSpec[] = [
    {
        name: "Gymshark",
        url: "https://www.gymshark.com",
        platform: "Shopify Plus",
        minCategories: 3,
        minProducts: 5,
        requireColors: true,
        note: "JSON-LD ProductGroup + BreadcrumbList on product pages, og:type=product",
    },
    {
        name: "STABILO",
        url: "https://www.stabilo.com/de/",
        platform: "Shopware 6",
        minCategories: 3,
        minProducts: 5,
        requireColors: true,
        note: "no product URLs in sitemap; products from data-product-information on category pages",
    },
    {
        name: "schuhe24.de",
        url: "https://www.schuhe24.de",
        platform: "Shopware 5",
        minCategories: 5,
        minProducts: 5,
        requireColors: true,
        note: "categories from microdata BreadcrumbList on product pages",
    },
    {
        name: "IKEA",
        url: "https://www.ikea.com/de/de/",
        platform: "Custom",
        minCategories: 10,
        minProducts: 5,
        requireColors: true,
        note: "products from JSON-LD ItemList; subcats from followed nav pages",
    },
    {
        name: "Media Markt",
        url: "https://www.mediamarkt.de",
        platform: "Shopware 6",
        minCategories: 5,
        minProducts: 5,
        requireColors: true,
        note: "products via JSON-LD on detail pages; og:type=og:product normalized",
    },
    {
        name: "Foot Locker",
        url: "https://www.footlocker.de",
        platform: "Custom",
        minCategories: 3,
        minProducts: 0,
        requireColors: true,
        note: "categories from /de/sitemap-*.xml; products via Phase 4 link-follow (best-effort, JS-heavy); sitemap can be flaky",
    },
    {
        name: "Koro Drogerie",
        url: "https://www.korodrogerie.de/",
        platform: "Shopware 6",
        minCategories: 3,
        minProducts: 5,
        requireColors: true,
        note: "products from h1 of og:type=product pages (JSON-LD is FAQPage, not Product)",
    },
    {
        name: "YT Industries",
        url: "https://www.yt-industries.com/de-eu",
        platform: "Shopware 6 (Nuxt)",
        minCategories: 3,
        minProducts: 0,
        requireColors: false,
        note: "gzip sitemap via pathPrefix fallback; clothing pages classified via Tier 3 price signal",
    },
    {
        name: "bergzeit.de",
        url: "https://www.bergzeit.de",
        platform: "Magento 2",
        minCategories: 10,
        minProducts: 10,
        requireColors: true,
        note: "multi-sitemap robots.txt (magazin first); editorial sitemaps deprioritized so product sitemap is tried second",
    },
    {
        name: "forestwholefoods.co.uk",
        url: "https://www.forestwholefoods.co.uk",
        platform: "WooCommerce",
        minCategories: 10,
        minProducts: 10,
        requireColors: true,
        note: "JSON-LD Product + BreadcrumbList; standard WooCommerce schema output",
    },
    {
        name: "mey.com",
        url: "https://www.mey.com/",
        platform: "Hyva + Adobe Commerce",
        minCategories: 10,
        minProducts: 0,
        requireColors: true,
        note: "Hyva frontend; categories from breadcrumbs, products JS-rendered on listing pages so product count is best-effort",
    },
];

interface StoreResult {
    spec: StoreSpec;
    data?: InspirationData;
    error?: string;
    passed: boolean;
    failures: string[];
    durationMs: number;
}

async function validateStore(spec: StoreSpec): Promise<StoreResult> {
    const start = Date.now();
    try {
        const data = await crawlForInspiration(spec.url);
        const durationMs = Date.now() - start;
        const failures: string[] = [];

        if (data.categories.length < spec.minCategories) {
            failures.push(
                `categories: got ${data.categories.length}, expected ≥${spec.minCategories}`
            );
        }
        if (data.exampleProducts.length < spec.minProducts) {
            failures.push(
                `products: got ${data.exampleProducts.length}, expected ≥${spec.minProducts}`
            );
        }
        if (spec.requireColors && !data.brandColors) {
            failures.push("brand colors: none extracted (expected some)");
        }

        return { spec, data, passed: failures.length === 0, failures, durationMs };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const passed = spec.skipOnFetchError === true;
        return {
            spec,
            error: message,
            passed,
            failures: passed ? [] : [`fetch failed: ${message}`],
            durationMs: Date.now() - start,
        };
    }
}

function colorHex(colors?: InspirationData["brandColors"]): string {
    if (!colors) return "none    ";
    return colors.primary.padEnd(8);
}

function bar(label: string, width = 18): string {
    return label.length > width ? label.slice(0, width - 1) + "…" : label.padEnd(width);
}

async function main() {
    console.log("\nValidating crawlers against known stores...\n");
    console.log(
        `${"Store".padEnd(16)} ${"Platform".padEnd(18)} ${"Categories".padEnd(12)} ${"Products".padEnd(10)} ${"Colors".padEnd(10)} ${"Time".padEnd(7)} Status`
    );
    console.log("─".repeat(90));

    const results: StoreResult[] = [];

    for (const spec of STORES) {
        process.stdout.write(`  ${bar(spec.name, 14)} ${bar(spec.platform, 16)} `);
        const result = await validateStore(spec);
        results.push(result);

        const cats = result.data
            ? `${result.data.categories.length}/≥${spec.minCategories}`
            : "error";
        const prods = result.data
            ? `${result.data.exampleProducts.length}/≥${spec.minProducts}`
            : "error";
        const colors = colorHex(result.data?.brandColors);
        const time = `${(result.durationMs / 1000).toFixed(1)}s`;
        const status = result.passed ? "✅ PASS" : "❌ FAIL";

        console.log(
            `${cats.padEnd(12)} ${prods.padEnd(10)} ${colors.padEnd(10)} ${time.padEnd(7)} ${status}`
        );

        if (result.failures.length > 0) {
            for (const f of result.failures) {
                console.log(`    ↳ ${f}`);
            }
        }
    }

    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    console.log("\n" + "─".repeat(90));
    console.log(`Results: ${passed} pass, ${failed} fail\n`);

    if (failed > 0) {
        console.log(
            "Note: results are flaky by nature — live sites change bot protection, sitemaps, and HTML"
        );
        console.log(
            "structure without notice. Update the spec thresholds if a change appears permanent.\n"
        );
        process.exit(1);
    }
}

main();
