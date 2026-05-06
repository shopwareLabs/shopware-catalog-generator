/**
 * Live inspiration crawl + validation tests.
 *
 * Crawls each store, saves the result to tmp/inspiration/<name>.json,
 * and asserts quality thresholds — so you get file output AND test
 * feedback in one step.
 *
 * Skipped by default to keep `bun test` fast. Enable with:
 *   INSPIRATION_INTEGRATION=1 bun test tests/integration/inspiration-files.test.ts
 *
 * Or use the convenience script:
 *   bun run test:inspiration
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";

import type { InspirationData } from "../../src/crawlers/types.js";

import { crawlForInspiration } from "../../src/crawlers/index.js";
import { InspirationDataSchema } from "../../src/crawlers/types.js";

const CRAWL_TIMEOUT_MS = 120_000;
const OUT_DIR = "tmp/inspiration";

interface StoreSpec {
    name: string;
    url: string;
    minCategories: number;
    minProducts: number;
    requireColors: boolean;
}

const STORES: StoreSpec[] = [
    {
        name: "gymshark",
        url: "https://www.gymshark.com",
        minCategories: 3,
        minProducts: 5,
        requireColors: true,
    },
    {
        name: "stabilo",
        url: "https://www.stabilo.com/de/",
        minCategories: 3,
        minProducts: 5,
        requireColors: true,
    },
    {
        name: "schuhe24",
        url: "https://www.schuhe24.de",
        minCategories: 5,
        minProducts: 5,
        requireColors: true,
    },
    {
        name: "ikea",
        url: "https://www.ikea.com/de/de/",
        minCategories: 10,
        minProducts: 5,
        requireColors: true,
    },
    {
        name: "mediamarkt",
        url: "https://www.mediamarkt.de",
        minCategories: 5,
        minProducts: 5,
        requireColors: true,
    },
    {
        name: "footlocker",
        url: "https://www.footlocker.de",
        minCategories: 3,
        minProducts: 0,
        requireColors: true,
    },
    {
        name: "korodrogerie",
        url: "https://www.korodrogerie.de/",
        minCategories: 3,
        minProducts: 5,
        requireColors: true,
    },
    {
        name: "yt-industries",
        url: "https://www.yt-industries.com/de-eu",
        minCategories: 3,
        minProducts: 0,
        requireColors: false,
    },
    {
        name: "bergzeit",
        url: "https://www.bergzeit.de",
        minCategories: 10,
        minProducts: 10,
        requireColors: true,
    },
    {
        name: "forestwholefoods",
        url: "https://www.forestwholefoods.co.uk",
        minCategories: 10,
        minProducts: 10,
        requireColors: true,
    },
    {
        name: "mey",
        url: "https://www.mey.com/",
        minCategories: 3,
        minProducts: 0,
        requireColors: true,
    },
];

const UTILITY_CATEGORIES = new Set([
    "account",
    "login",
    "register",
    "registrierung",
    "anmelden",
    "cart",
    "warenkorb",
    "wishlist",
    "merkzettel",
    "checkout",
    "orders",
    "bestellungen",
    "profile",
    "mein konto",
    "my account",
    "blog",
    "news",
    "magazin",
    "jobs",
    "career",
    "about",
    "about us",
    "über uns",
    "contact",
    "kontakt",
    "help",
    "hilfe",
    "faq",
    "impressum",
    "datenschutz",
    "agb",
    "sitemap",
    "search",
    "suche",
    "newsletter",
    "cookie",
]);

const HEX_RE = /^#[0-9a-f]{6}$/i;

function isNearWhite(hex: string): boolean {
    const h = hex.replace(/^#/, "").padEnd(6, "0");
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b > 0.85;
}

const RUN = process.env.INSPIRATION_INTEGRATION === "1";

if (!RUN) {
    test.skip("skipped — set INSPIRATION_INTEGRATION=1 to run live crawl tests", () => {});
} else {
    mkdirSync(OUT_DIR, { recursive: true });

    for (const store of STORES) {
        describe(store.name, () => {
            let data: InspirationData | undefined;
            let crawlError: string | undefined;

            beforeAll(async () => {
                try {
                    data = await crawlForInspiration(store.url);
                    writeFileSync(`${OUT_DIR}/${store.name}.json`, JSON.stringify(data, null, 2));
                } catch (e) {
                    crawlError = e instanceof Error ? e.message : String(e);
                }
            }, CRAWL_TIMEOUT_MS);

            test("crawl succeeds without error", () => {
                expect(crawlError).toBeUndefined();
            });

            test("passes schema validation", () => {
                if (!data) return;
                const result = InspirationDataSchema.safeParse(data);
                if (!result.success) throw new Error(result.error.toString());
            });

            test(`has ≥ ${store.minCategories} categories`, () => {
                if (!data) return;
                expect(data.categories.length).toBeGreaterThanOrEqual(store.minCategories);
            });

            test(`has ≥ ${store.minProducts} example products`, () => {
                if (!data) return;
                expect(data.exampleProducts.length).toBeGreaterThanOrEqual(store.minProducts);
            });

            if (store.requireColors) {
                test("has brand colors", () => {
                    if (!data) return;
                    expect(data.brandColors).toBeDefined();
                });

                test("primary color is valid hex and not near-white", () => {
                    if (!data?.brandColors) return;
                    expect(HEX_RE.test(data.brandColors.primary)).toBe(true);
                    expect(isNearWhite(data.brandColors.primary)).toBe(false);
                });

                test("secondary color is valid hex", () => {
                    if (!data?.brandColors) return;
                    expect(HEX_RE.test(data.brandColors.secondary)).toBe(true);
                });
            }

            test("no duplicate product names", () => {
                if (!data) return;
                const names = data.exampleProducts.map((p) => p.name.toLowerCase());
                expect(new Set(names).size).toBe(names.length);
            });

            test("no utility/navigation categories leaked (cart, login, account, ...)", () => {
                if (!data) return;
                const leaking = data.categories.filter((c) =>
                    UTILITY_CATEGORIES.has(c.toLowerCase().trim())
                );
                expect(leaking).toEqual([]);
            });

            test("all products have a non-empty name", () => {
                if (!data) return;
                const invalid = data.exampleProducts.filter((p) => p.name.trim().length === 0);
                expect(invalid).toEqual([]);
            });

            test("product descriptions are non-empty strings and ≤ 300 chars when present", () => {
                if (!data) return;
                const invalid = data.exampleProducts.filter(
                    (p) =>
                        p.description !== undefined &&
                        (p.description.length === 0 || p.description.length > 300)
                );
                expect(invalid).toEqual([]);
            });
        });
    }
}
