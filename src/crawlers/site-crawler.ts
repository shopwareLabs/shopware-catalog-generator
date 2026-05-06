import * as cheerio from "cheerio";

import type { PageType } from "./page-classifier.js";
import type { ExampleProduct, InspirationData } from "./types.js";

import {
    extractBrandDescription,
    extractBrandDescriptionFromJsonLd,
    extractCategoriesFromJsonLd,
    extractCategoriesFromMicrodata,
    extractColorsFromBrandImage,
    extractPrimaryColor,
    extractProductsFromJsonLd,
    extractSecondaryColor,
} from "./extractors/index.js";
import { discoverFromSitemap, sampleUrls, BROWSER_HEADERS } from "./extractors/sitemap.js";
import { classifyPage } from "./page-classifier.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_SAMPLE_URLS = 30;
const FETCH_CONCURRENCY = 5;

const HOME_NAMES = new Set(["home", "startseite", "homepage", "start", "hauptseite"]);

// No `g` flag — used for .test() only (stateless)
const PRICE_RE_LISTING = /\d{1,4}[.,]\d{2}\s*[€£$]|[€£$]\s*\d{1,4}[.,]\d{2}/;

const CATEGORY_SKIP = new Set([
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
    "mein-konto",
    "my-account",
    "blog",
    "news",
    "magazin",
    "presse",
    "jobs",
    "career",
    "about",
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

interface FetchedPage {
    type: PageType;
    $: cheerio.CheerioAPI;
    url: string;
}

async function fetchHtml(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                ...BROWSER_HEADERS,
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
        });
        if (!response.ok) {
            clearTimeout(timer);
            return null;
        }
        const ct = response.headers.get("content-type") ?? "";
        if (!ct.includes("html")) {
            clearTimeout(timer);
            return null;
        }
        const text = await response.text();
        clearTimeout(timer);
        return text;
    } catch {
        clearTimeout(timer);
        return null;
    }
}

async function fetchAllWithConcurrency<T>(
    tasks: Array<() => Promise<T>>,
    concurrency: number
): Promise<T[]> {
    const results: (T | undefined)[] = new Array(tasks.length);
    let next = 0;
    async function worker() {
        while (next < tasks.length) {
            const i = next++;
            const task = tasks[i];
            if (task) results[i] = await task();
        }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results as T[];
}

async function fetchPages(urls: string[]): Promise<Array<FetchedPage | null>> {
    return fetchAllWithConcurrency(
        urls.map((pageUrl) => async () => {
            const html = await fetchHtml(pageUrl);
            if (!html) return null;
            const $ = cheerio.load(html);
            return { type: classifyPage(html, $), $, url: pageUrl };
        }),
        FETCH_CONCURRENCY
    );
}

/** Collect internal links from a page for sitemap fallback. */
function collectInternalLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
    const origin = new URL(baseUrl).origin;
    const links: string[] = [];
    const seen = new Set<string>([baseUrl, `${origin}/`]);

    $("a[href]").each((_, el) => {
        if (links.length >= 100) return false;
        const href = $(el).attr("href");
        if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:"))
            return;
        try {
            const abs = new URL(href, baseUrl).href;
            if (new URL(abs).origin !== origin) return;
            if (abs.includes("?") || abs.includes("#")) return;
            if (seen.has(abs)) return;
            seen.add(abs);
            links.push(abs);
        } catch {
            /* ignore */
        }
    });

    return links;
}

/** Collect same-origin links from a page into a Set, respecting a size cap. */
function collectPageLinks(
    $: cheerio.CheerioAPI,
    pageUrl: string,
    origin: string,
    out: Set<string>,
    seen: Set<string>,
    cap: number
): void {
    $("a[href]").each((_, el) => {
        if (out.size >= cap) return false;
        const href = $(el).attr("href") ?? "";
        try {
            const abs = new URL(href, pageUrl).href;
            if (new URL(abs).origin !== origin) return;
            if (seen.has(abs) || out.has(abs)) return;
            if (abs.includes("?") || abs.includes("#")) return;
            out.add(abs);
        } catch {
            /* ignore */
        }
    });
}

function extractProduct($: cheerio.CheerioAPI): ExampleProduct | null {
    // JSON-LD gives us name + description + properties in one go
    const fromJsonLd = extractProductsFromJsonLd($);
    const first = fromJsonLd[0];
    if (first) {
        if (!first.description) {
            const metaDesc =
                $('meta[property="og:description"]').attr("content")?.trim() ||
                $('meta[name="description"]').attr("content")?.trim();
            if (metaDesc) return { ...first, description: metaDesc.slice(0, 300) };
        }
        return first;
    }

    // Single h1 is the most reliable signal for the page title. Try it before scoped
    // microdata because some shops (e.g. Koro) wrap a huge section with
    // [itemtype="Product"] and the first [itemprop="name"] inside is a breadcrumb or
    // navigation label, not the actual product name.
    let name: string | null = null;
    const h1s = $("h1");
    if (h1s.length === 1) {
        const h1 = h1s.first().text().trim().replace(/\s+/g, " ");
        if (h1.length >= 3 && h1.length <= 120) name = h1;
    }

    if (!name) {
        const itemprop = $('[itemtype*="schema.org/Product"] [itemprop="name"]')
            .first()
            .text()
            .trim();
        if (itemprop.length >= 3 && itemprop.length <= 120) name = itemprop;
    }

    if (!name) return null;

    // Description: scoped microdata → og:description → meta description
    const rawDesc =
        $('[itemtype*="schema.org/Product"] [itemprop="description"]').first().text().trim() ||
        $('meta[property="og:description"]').attr("content")?.trim() ||
        $('meta[name="description"]').attr("content")?.trim();

    return { name, description: rawDesc ? rawDesc.slice(0, 300) : undefined };
}

/** Extract products from a classified category page using four fallback tiers. */
function extractCategoryPageProducts($: cheerio.CheerioAPI): ExampleProduct[] {
    const fromJsonLd = extractProductsFromJsonLd($);
    if (fromJsonLd.length > 0) return fromJsonLd;

    // Shopware 6: data-product-information JSON attributes
    const fromDataAttrs: ExampleProduct[] = [];
    $("[data-product-information]").each((_, el) => {
        try {
            const data = JSON.parse($(el).attr("data-product-information") ?? "{}") as Record<
                string,
                unknown
            >;
            if (typeof data.name === "string" && data.name.length >= 3) {
                const desc =
                    typeof data.description === "string" && data.description.length > 0
                        ? data.description.slice(0, 300)
                        : undefined;
                fromDataAttrs.push({ name: data.name, description: desc });
            }
        } catch {
            /* malformed JSON */
        }
    });
    if (fromDataAttrs.length > 0) return fromDataAttrs;

    // Microdata: multiple Product scopes on a category listing page
    const fromMicrodata: ExampleProduct[] = [];
    $('[itemtype*="schema.org/Product"]').each((_, el) => {
        const $scope = $(el);
        const name = $scope.find('[itemprop="name"]').first().text().trim().replace(/\s+/g, " ");
        if (name.length >= 3 && name.length <= 120) {
            const rawDesc = $scope.find('[itemprop="description"]').first().text().trim();
            fromMicrodata.push({ name, description: rawDesc ? rawDesc.slice(0, 300) : undefined });
        }
    });
    if (fromMicrodata.length > 0) return fromMicrodata;

    // Last resort: h2/h3 where a price appears within at most 2 DOM levels in a
    // sibling or parent-sibling. Shallow text only (direct text node + one child
    // level) prevents section headers from matching prices that are nested several
    // levels deep inside a sibling product carousel.
    const fromHeadings: ExampleProduct[] = [];
    $("h2, h3").each((_, el) => {
        const $el = $(el);
        const name = $el.text().trim().replace(/\s+/g, " ");
        if (name.length < 3 || name.length > 100) return;

        const nearNodes = [
            ...$el.parent().children().not($el).toArray(),
            ...$el.parent().siblings().toArray(),
        ];
        const hasShallowPrice = nearNodes.some((node) => {
            const $n = $(node);
            const direct = $n.clone().children().remove().end().text();
            if (PRICE_RE_LISTING.test(direct)) return true;
            return $n
                .children()
                .toArray()
                .some((c) => PRICE_RE_LISTING.test($(c).clone().children().remove().end().text()));
        });

        if (hasShallowPrice) fromHeadings.push({ name });
    });
    return fromHeadings;
}

function extractCategoryName($: cheerio.CheerioAPI): string | null {
    const fromJsonLd = extractCategoriesFromJsonLd($).filter(
        (c) => !HOME_NAMES.has(c.toLowerCase().trim())
    );
    if (fromJsonLd.length > 0) return fromJsonLd[fromJsonLd.length - 1] ?? null;

    const fromMicrodata = extractCategoriesFromMicrodata($).filter(
        (c) => !HOME_NAMES.has(c.toLowerCase().trim())
    );
    if (fromMicrodata.length > 0) return fromMicrodata[fromMicrodata.length - 1] ?? null;

    const h1 = $("h1").first().text().trim().replace(/\s+/g, " ");
    if (h1.length >= 2 && h1.length <= 80) return h1;

    return null;
}

async function resolveBrandColors(
    $: cheerio.CheerioAPI,
    url: string
): Promise<InspirationData["brandColors"]> {
    const imageColors = await extractColorsFromBrandImage($, url);
    if (imageColors?.primary) {
        return {
            primary: imageColors.primary,
            secondary: imageColors.secondary ?? deriveSecondaryColor(imageColors.primary),
        };
    }
    const primary = extractPrimaryColor($);
    if (primary && !isNearWhite(primary)) {
        return {
            primary,
            secondary: extractSecondaryColor($) ?? deriveSecondaryColor(primary),
        };
    }
    return undefined;
}

/**
 * Phase 4: follow links from category pages to find products when the sitemap
 * sample yielded fewer than 5. Handles stores where product URLs are absent from
 * the sitemap but linked from category listing pages (e.g. Foot Locker).
 * Goes up to two levels deep if the first follow level is still all category pages.
 */
async function followUpCrawl(
    fetched: Array<FetchedPage | null>,
    baseUrl: string,
    sampled: string[]
): Promise<ExampleProduct[]> {
    const origin = new URL(baseUrl).origin;
    const sampledSet = new Set(sampled);
    const followUrls = new Set<string>();

    for (const result of fetched) {
        if (!result || result.type !== "category") continue;
        collectPageLinks(result.$, result.url, origin, followUrls, sampledSet, 300);
    }

    if (followUrls.size === 0) return [];

    const followFetched = await fetchPages(sampleUrls([...followUrls], 20));
    const products: ExampleProduct[] = [];
    const level2Urls = new Set<string>();
    const seenUrls = new Set([...sampledSet, ...followUrls]);

    for (const result of followFetched) {
        if (!result) continue;
        if (result.type === "product") {
            const product = extractProduct(result.$);
            if (product) products.push(product);
        } else if (result.type === "category" && products.length < 5) {
            collectPageLinks(result.$, result.url, origin, level2Urls, seenUrls, 60);
        }
    }

    if (level2Urls.size > 0 && products.length < 5) {
        const level2Fetched = await fetchPages(sampleUrls([...level2Urls], 20));
        for (const result of level2Fetched) {
            if (!result || result.type !== "product") continue;
            const product = extractProduct(result.$);
            if (product) products.push(product);
        }
    }

    return products;
}

export async function crawlForInspiration(url: string): Promise<InspirationData> {
    // Phase 0: Homepage — brand data only
    const homepageHtml = await fetchHtml(url);
    if (!homepageHtml) {
        throw new Error(`Failed to fetch "${url}". Check that the URL is accessible.`);
    }
    const $home = cheerio.load(homepageHtml);

    const brandDescription =
        extractBrandDescriptionFromJsonLd($home) ?? extractBrandDescription($home);
    const brandColors = await resolveBrandColors($home, url);

    // Phase 1: URL discovery — sitemap, fallback to homepage link extraction
    let candidateUrls = await discoverFromSitemap(url);
    if (candidateUrls.length === 0) {
        console.warn(`[inspire] no sitemap URLs for ${url} — using homepage link discovery`);
        candidateUrls = collectInternalLinks($home, url);
    }

    const sampled = sampleUrls(candidateUrls, MAX_SAMPLE_URLS);

    // Phase 2+3: Fetch, classify, extract in parallel
    const fetched = await fetchPages(sampled);

    const categories: string[] = [];
    const categorySet = new Set<string>();
    const products: ExampleProduct[] = [];

    function addCategory(name: string) {
        const key = name.toLowerCase().trim();
        if (key.length < 2 || key.length > 60) return;
        if (CATEGORY_SKIP.has(key) || HOME_NAMES.has(key)) return;
        if (categorySet.has(key)) return;
        categorySet.add(key);
        categories.push(name.trim());
    }

    for (const result of fetched) {
        if (!result || result.type === "cms" || result.type === "unknown") continue;

        if (result.type === "product") {
            const product = extractProduct(result.$);
            if (product) products.push(product);

            const breadcrumbs = [
                ...extractCategoriesFromJsonLd(result.$),
                ...extractCategoriesFromMicrodata(result.$),
            ];
            for (const cat of breadcrumbs) {
                if (!HOME_NAMES.has(cat.toLowerCase().trim())) addCategory(cat);
            }
        }

        if (result.type === "category") {
            const catName = extractCategoryName(result.$);
            if (catName) addCategory(catName);
            for (const p of extractCategoryPageProducts(result.$)) products.push(p);
        }
    }

    // Phase 4: follow category page links when few products found
    if (products.length < 5) {
        for (const p of await followUpCrawl(fetched, url, sampled)) products.push(p);
    }

    if (categories.length < 3) {
        console.warn(`[inspire] only ${categories.length} categories found for ${url}`);
    }

    const seenNames = new Set<string>();
    const uniqueProducts = products.filter((p) => {
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

function isNearWhite(hex: string): boolean {
    const h = hex.replace(/^#/, "").padEnd(6, "0");
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b > 0.85;
}

function deriveSecondaryColor(primary: string): string {
    let hex = primary.replace(/^#/, "");
    if (hex.length === 3)
        hex = hex
            .split("")
            .map((c) => c + c)
            .join("");
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const adjust = luminance < 0.4 ? 60 : -60;
    const toHex = (v: number) =>
        Math.min(255, Math.max(0, Math.round(v + adjust)))
            .toString(16)
            .padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
