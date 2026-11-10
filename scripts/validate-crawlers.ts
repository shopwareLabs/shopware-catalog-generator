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

import type { StoreResult, StoreSpec } from "./crawler-validation.js";

import { crawlForInspiration } from "../src/crawlers/index.js";
import {
    formatRowPrefix,
    formatRowResult,
    formatTableHeader,
    summarizeResults,
    validateStore,
} from "./crawler-validation.js";

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
        note: "product pages lack category breadcrumbs; categories (collections) via category fallback; sitemap can be flaky",
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
        note: "no Product JSON-LD (og:type=article); WooCommerce body class + category fallback",
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

async function main(): Promise<void> {
    formatTableHeader().forEach((line) => console.log(line));

    const results: StoreResult[] = [];
    for (const spec of STORES) {
        process.stdout.write(formatRowPrefix(spec));
        const result = await validateStore(spec, crawlForInspiration);
        results.push(result);
        formatRowResult(result).forEach((line) => console.log(line));
    }

    const summary = summarizeResults(results);
    summary.lines.forEach((line) => console.log(line));
    if (summary.failed > 0) process.exit(1);
}

main();
