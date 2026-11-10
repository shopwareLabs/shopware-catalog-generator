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
const MIN_CATEGORIES = 3;
const CATEGORY_FALLBACK_SAMPLE_URLS = 20;
const FETCH_CONCURRENCY = 5;

const HOME_NAMES = new Set(["home", "startseite", "homepage", "start", "hauptseite"]);

// No `g` flag — used for .test() only (stateless)
const PRICE_RE_LISTING = /\d{1,4}[.,]\d{2}\s*[€£$]|[€£$]\s*\d{1,4}[.,]\d{2}/;

const CATEGORY_SKIP = new Set([
    "shop",
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

const NON_PAGE_HREF_PREFIXES = ["#", "mailto:", "tel:"];

function isNonPageHref(href: string | undefined): boolean {
    return !href || NON_PAGE_HREF_PREFIXES.some((prefix) => href.startsWith(prefix));
}

/** Absolute URL of a link when it stays on the origin and has no query or fragment. */
function toSameOriginUrl(href: string, pageUrl: string, origin: string): string | null {
    try {
        const abs = new URL(href, pageUrl).href;
        if (new URL(abs).origin !== origin) return null;
        if (abs.includes("?") || abs.includes("#")) return null;
        return abs;
    } catch {
        return null;
    }
}

/** Collect internal links from a page for sitemap fallback. */
function collectInternalLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
    const origin = new URL(baseUrl).origin;
    const links: string[] = [];
    const seen = new Set<string>([baseUrl, `${origin}/`]);

    $("a[href]").each((_, el) => {
        if (links.length >= 100) return false;
        const href = $(el).attr("href");
        if (isNonPageHref(href)) return;
        const abs = toSameOriginUrl(href ?? "", baseUrl, origin);
        if (!abs || seen.has(abs)) return;
        seen.add(abs);
        links.push(abs);
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
        const abs = toSameOriginUrl($(el).attr("href") ?? "", pageUrl, origin);
        if (!abs || seen.has(abs) || out.has(abs)) return;
        out.add(abs);
    });
}

function metaDescription($: cheerio.CheerioAPI): string | undefined {
    return (
        $('meta[property="og:description"]').attr("content")?.trim() ||
        $('meta[name="description"]').attr("content")?.trim()
    );
}

/** JSON-LD product without a description gets the page meta description instead. */
function withMetaDescription(product: ExampleProduct, $: cheerio.CheerioAPI): ExampleProduct {
    if (product.description) return product;
    const metaDesc = metaDescription($);
    return metaDesc ? { ...product, description: metaDesc.slice(0, 300) } : product;
}

function isProductNameLength(name: string): boolean {
    return name.length >= 3 && name.length <= 120;
}

function singleH1Name($: cheerio.CheerioAPI): string | null {
    const h1s = $("h1");
    if (h1s.length !== 1) return null;
    const h1 = h1s.first().text().trim().replace(/\s+/g, " ");
    return isProductNameLength(h1) ? h1 : null;
}

function microdataProductName($: cheerio.CheerioAPI): string | null {
    const itemprop = $('[itemtype*="schema.org/Product"] [itemprop="name"]').first().text().trim();
    return isProductNameLength(itemprop) ? itemprop : null;
}

/** Product from page markup when there is no JSON-LD product. */
function productFromPageMarkup($: cheerio.CheerioAPI): ExampleProduct | null {
    // Single h1 is the most reliable signal for the page title. Try it before scoped
    // microdata because some shops (e.g. Koro) wrap a huge section with
    // [itemtype="Product"] and the first [itemprop="name"] inside is a breadcrumb or
    // navigation label, not the actual product name.
    const name = singleH1Name($) ?? microdataProductName($);
    if (!name) return null;

    // Description: scoped microdata → og:description → meta description
    const rawDesc =
        $('[itemtype*="schema.org/Product"] [itemprop="description"]').first().text().trim() ||
        metaDescription($);

    return { name, description: rawDesc ? rawDesc.slice(0, 300) : undefined };
}

function extractProduct($: cheerio.CheerioAPI): ExampleProduct | null {
    // JSON-LD gives us name + description + properties in one go
    const first = extractProductsFromJsonLd($)[0];
    return first ? withMetaDescription(first, $) : productFromPageMarkup($);
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

function productFromPage(page: FetchedPage | null): ExampleProduct | null {
    return page?.type === "product" ? extractProduct(page.$) : null;
}

function productsFromPages(pages: Array<FetchedPage | null>): ExampleProduct[] {
    return pages
        .map(productFromPage)
        .filter((product): product is ExampleProduct => product !== null);
}

interface FollowLevelScan {
    products: ExampleProduct[];
    nextUrls: Set<string>;
}

/** Extract products from one follow level; category pages contribute links for the
 * next level only while fewer than 5 products have been found so far. */
function scanFollowLevel(
    pages: Array<FetchedPage | null>,
    origin: string,
    seen: Set<string>
): FollowLevelScan {
    const products: ExampleProduct[] = [];
    const nextUrls = new Set<string>();
    for (const page of pages) {
        const product = productFromPage(page);
        if (product) products.push(product);
        if (page?.type === "category" && products.length < 5) {
            collectPageLinks(page.$, page.url, origin, nextUrls, seen, 60);
        }
    }
    return { products, nextUrls };
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
        if (result?.type !== "category") continue;
        collectPageLinks(result.$, result.url, origin, followUrls, sampledSet, 300);
    }

    if (followUrls.size === 0) return [];

    const followFetched = await fetchPages(sampleUrls([...followUrls], 20));
    const seenUrls = new Set([...sampledSet, ...followUrls]);
    const level1 = scanFollowLevel(followFetched, origin, seenUrls);
    if (level1.nextUrls.size === 0 || level1.products.length >= 5) return level1.products;

    const level2Fetched = await fetchPages(sampleUrls([...level1.nextUrls], 20));
    return [...level1.products, ...productsFromPages(level2Fetched)];
}

/** Phase 1: URL discovery — sitemap, fallback to homepage link extraction */
async function discoverCandidateUrls(url: string, $home: cheerio.CheerioAPI): Promise<string[]> {
    const fromSitemap = await discoverFromSitemap(url);
    if (fromSitemap.length > 0) return fromSitemap;
    console.warn(`[inspire] no sitemap URLs for ${url} — using homepage link discovery`);
    return collectInternalLinks($home, url);
}

interface SamplePages {
    sampled: string[];
    fetched: Array<FetchedPage | null>;
}

function categoriesOf(pages: Array<FetchedPage | null>): string[] {
    return uniqueCategories(pages.flatMap((page) => extractFromPage(page).categories));
}

/**
 * Phase 3b: when product pages carry no category breadcrumbs (Foot Locker, WooCommerce
 * without Product JSON-LD), the product-first sample yields few categories. Read the
 * non-product sub-sitemaps then and fetch a sample of those pages.
 */
async function fetchCategoryFallbackPages(url: string, sampled: string[]): Promise<SamplePages> {
    const seen = new Set(sampled);
    const candidates = await discoverFromSitemap(url, { skipProductSitemaps: true });
    const fallbackUrls = sampleUrls(
        candidates.filter((candidate) => !seen.has(candidate)),
        CATEGORY_FALLBACK_SAMPLE_URLS,
        { mergeSingleUrlBranches: true }
    );
    return { sampled: fallbackUrls, fetched: await fetchPages(fallbackUrls) };
}

async function fetchSamplePages(url: string, $home: cheerio.CheerioAPI): Promise<SamplePages> {
    const sampled = sampleUrls(await discoverCandidateUrls(url, $home), MAX_SAMPLE_URLS);
    const fetched = await fetchPages(sampled);
    if (categoriesOf(fetched).length >= MIN_CATEGORIES) return { sampled, fetched };

    const fallback = await fetchCategoryFallbackPages(url, sampled);
    return {
        sampled: [...sampled, ...fallback.sampled],
        fetched: [...fetched, ...fallback.fetched],
    };
}

interface PageExtraction {
    categories: string[];
    products: ExampleProduct[];
}

function extractFromProductPage($: cheerio.CheerioAPI): PageExtraction {
    const product = extractProduct($);
    const productName = product?.name.toLowerCase().trim();
    // Breadcrumbs; home entries are dropped by uniqueCategories. The last breadcrumb
    // of a product page is often the product itself, which is not a category.
    const categories = [
        ...extractCategoriesFromJsonLd($),
        ...extractCategoriesFromMicrodata($),
    ].filter((name) => name.toLowerCase().trim() !== productName);
    return { categories, products: product ? [product] : [] };
}

function extractFromCategoryPage($: cheerio.CheerioAPI): PageExtraction {
    const catName = extractCategoryName($);
    return {
        categories: catName ? [catName] : [],
        products: extractCategoryPageProducts($),
    };
}

function extractFromPage(page: FetchedPage | null): PageExtraction {
    if (page?.type === "product") return extractFromProductPage(page.$);
    if (page?.type === "category") return extractFromCategoryPage(page.$);
    return { categories: [], products: [] };
}

function isCategoryCandidate(key: string): boolean {
    if (key.length < 2 || key.length > 60) return false;
    return !CATEGORY_SKIP.has(key) && !HOME_NAMES.has(key);
}

/** Trimmed category names without skip/home entries, deduplicated case-insensitively. */
function uniqueCategories(names: string[]): string[] {
    const seen = new Set<string>();
    const categories: string[] = [];
    for (const name of names) {
        const key = name.toLowerCase().trim();
        if (!isCategoryCandidate(key) || seen.has(key)) continue;
        seen.add(key);
        categories.push(name.trim());
    }
    return categories;
}

function uniqueProductsByName(products: ExampleProduct[]): ExampleProduct[] {
    const seenNames = new Set<string>();
    return products.filter((p) => {
        const key = p.name.toLowerCase();
        if (seenNames.has(key)) return false;
        seenNames.add(key);
        return true;
    });
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

    // Phase 1-3: discover, fetch, classify (plus category fallback), then extract
    const { sampled, fetched } = await fetchSamplePages(url, $home);
    const extracted = fetched.map(extractFromPage);
    const categories = uniqueCategories(extracted.flatMap((page) => page.categories));
    const products = extracted.flatMap((page) => page.products);

    // Phase 4: follow category page links when few products found
    if (products.length < 5) {
        products.push(...(await followUpCrawl(fetched, url, sampled)));
    }

    if (categories.length < MIN_CATEGORIES) {
        console.warn(`[inspire] only ${categories.length} categories found for ${url}`);
    }

    return {
        sourceUrl: url,
        crawledAt: new Date().toISOString(),
        brandDescription: brandDescription || undefined,
        brandColors,
        categories,
        exampleProducts: uniqueProductsByName(products),
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
