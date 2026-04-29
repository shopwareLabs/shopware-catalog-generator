import * as cheerio from "cheerio";

import type { ExampleProduct, InspirationData } from "./types.js";

import {
    extractBrandDescription,
    extractBrandDescriptionFromJsonLd,
    extractCategoriesFromJsonLd,
    extractColorsFromBrandImage,
    extractNavCategories,
    extractPrimaryColor,
    extractProductHeadings,
    extractProductsFromJsonLd,
    extractSecondaryColor,
} from "./extractors/index.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CATEGORY_PAGES_TO_FOLLOW = 2;
const MAX_PRODUCTS_PER_PAGE = 5;

interface CrawlOptions {
    /** Follow up to N category links to collect example products (default: 2) */
    followCategoryPages?: boolean;
}

async function fetchHtml(url: string): Promise<string | null> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (compatible; ShopwareCatalogBot/1.0; +https://github.com/shopwareLabs/shopware-catalog-generator)",
                Accept: "text/html,application/xhtml+xml",
            },
        });

        clearTimeout(timer);

        if (!response.ok) return null;

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("html")) return null;

        return await response.text();
    } catch {
        return null;
    }
}

function resolveAbsoluteUrl(base: string, href: string): string | null {
    try {
        return new URL(href, base).href;
    } catch {
        return null;
    }
}

/** Extract absolute category-like URLs from nav, limited to the same origin */
function extractCategoryLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
    const origin = new URL(baseUrl).origin;
    const links: string[] = [];
    const seen = new Set<string>();

    $("nav a, header a").each((_, el) => {
        const href = $( el).attr("href");
        if (!href) return;

        const absolute = resolveAbsoluteUrl(baseUrl, href);
        if (!absolute) return;

        // Only same-origin, path-based links (not homepage or anchor-only)
        if (
            !absolute.startsWith(origin) ||
            absolute === baseUrl ||
            absolute === `${origin}/` ||
            absolute.includes("#") ||
            absolute.includes("?")
        ) {
            return;
        }

        if (!seen.has(absolute)) {
            seen.add(absolute);
            links.push(absolute);
        }
    });

    return links.slice(0, MAX_CATEGORY_PAGES_TO_FOLLOW);
}

/** Collect products from a single page */
function collectProductsFromPage(
    $: cheerio.CheerioAPI,
    categoryName?: string
): ExampleProduct[] {
    const fromJsonLd = extractProductsFromJsonLd($);
    if (fromJsonLd.length > 0) {
        return fromJsonLd.slice(0, MAX_PRODUCTS_PER_PAGE).map((p) => ({
            ...p,
            category: categoryName,
        }));
    }

    // Fallback: heading-based extraction
    return extractProductHeadings($)
        .slice(0, MAX_PRODUCTS_PER_PAGE)
        .map((name) => ({ name, category: categoryName }));
}

/**
 * Crawl a website and extract inspiration data for AI-guided blueprint generation.
 *
 * Fetches the provided URL, optionally follows 2 category links to collect
 * example products, and assembles an InspirationData object.
 */
export async function crawlForInspiration(
    url: string,
    options: CrawlOptions = {}
): Promise<InspirationData> {
    const { followCategoryPages = true } = options;

    const html = await fetchHtml(url);
    if (!html) {
        throw new Error(`Failed to fetch "${url}". Check that the URL is accessible.`);
    }

    const $ = cheerio.load(html);

    // Brand description
    const brandDescription =
        extractBrandDescriptionFromJsonLd($) ?? extractBrandDescription($);

    // Brand colors: image analysis first (most reliable), then CSS/meta fallback
    let brandColors: InspirationData["brandColors"];
    const imageColors = await extractColorsFromBrandImage($, url);
    if (imageColors?.primary) {
        brandColors = {
            primary: imageColors.primary,
            secondary: imageColors.secondary ?? deriveSecondaryColor(imageColors.primary),
        };
    } else {
        const primaryColor = extractPrimaryColor($);
        if (primaryColor && !isNearWhite(primaryColor)) {
            const secondaryColor = extractSecondaryColor($);
            brandColors = {
                primary: primaryColor,
                secondary: secondaryColor ?? deriveSecondaryColor(primaryColor),
            };
        }
    }

    // Categories: JSON-LD breadcrumbs first, then nav
    let categories = extractCategoriesFromJsonLd($);
    if (categories.length === 0) {
        categories = extractNavCategories($);
    }

    // Products from main page
    const allProducts: ExampleProduct[] = collectProductsFromPage($);

    // Follow category links for more product examples
    if (followCategoryPages && categories.length > 0) {
        const categoryLinks = extractCategoryLinks($, url);

        for (const [idx, link] of categoryLinks.entries()) {
            const catName = categories[idx];
            const catHtml = await fetchHtml(link);
            if (!catHtml) continue;

            const $cat = cheerio.load(catHtml);
            const products = collectProductsFromPage($cat, catName);
            allProducts.push(...products);
        }
    }

    // Deduplicate products by name
    const seenNames = new Set<string>();
    const uniqueProducts = allProducts.filter((p) => {
        const key = p.name.toLowerCase();
        if (seenNames.has(key)) return false;
        seenNames.add(key);
        return true;
    });

    return {
        sourceUrl: url,
        crawledAt: new Date().toISOString(),
        brandDescription: brandDescription || undefined,
        brandColors,
        categories,
        exampleProducts: uniqueProducts,
    };
}

/** Return true when a hex color is near-white (luminance > 0.85), making it useless as a brand color */
function isNearWhite(hex: string): boolean {
    const h = hex.replace(/^#/, "").padEnd(6, "0");
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b > 0.85;
}

/**
 * Derive a secondary color by lightening/darkening the primary.
 * Simple heuristic: if primary is dark, return a lighter shade; otherwise darker.
 */
function deriveSecondaryColor(primary: string): string {
    // Expand 3-digit hex to 6-digit
    let hex = primary.replace(/^#/, "");
    if (hex.length === 3) {
        hex = hex
            .split("")
            .map((c) => c + c)
            .join("");
    }

    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);

    // Luminance approximation
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

    // If dark primary, return a lighter complementary; if light, return darker
    const adjust = luminance < 0.4 ? 60 : -60;
    const toHex = (v: number) =>
        Math.min(255, Math.max(0, Math.round(v + adjust)))
            .toString(16)
            .padStart(2, "0");

    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
