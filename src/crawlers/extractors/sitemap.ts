import * as cheerio from "cheerio";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_SITEMAP_URLS = 300;

export const BROWSER_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/xml,text/xml,application/x-gzip,*/*",
    "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
};

async function fetchText(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: BROWSER_HEADERS,
        });
        if (!res.ok) {
            clearTimeout(timer);
            return null;
        }

        // Manually decompress only when the file is a raw gzip blob (url ends in .gz or
        // content-type signals a gzip container). When Content-Encoding is "gzip", the
        // runtime (Bun/Node fetch) already decompresses transparently — double-gunzip fails.
        const isRawGzip =
            url.endsWith(".gz") || !!res.headers?.get?.("content-type")?.includes("gzip");

        let result: string | null;
        if (isRawGzip) {
            const buffer = await res.arrayBuffer();
            try {
                result = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(buffer)));
            } catch {
                result = null;
            }
        } else {
            result = await res.text();
        }
        clearTimeout(timer);
        return result;
    } catch {
        clearTimeout(timer);
        return null;
    }
}

function extractLocsFromXml(xml: string): string[] {
    const $xml = cheerio.load(xml, { xmlMode: true });
    const locs: string[] = [];
    $xml("loc").each((_, el) => {
        const text = $xml(el).text().trim();
        if (text) locs.push(text);
    });
    return locs;
}

function isSitemapIndex(xml: string): boolean {
    return /<sitemapindex[\s>]/.test(xml) || /<sitemap>/.test(xml);
}

function looksLikeSitemap(xml: string): boolean {
    return xml.includes("<loc>") || xml.includes("<urlset") || xml.includes("<sitemapindex");
}

interface SitemapScope {
    origin: string;
    /** Only URLs starting with this prefix are collected (null: whole origin). */
    pathPrefix: string | null;
    /** Locale code from the base URL path (e.g. "de-de"), used to rank sub-sitemaps. */
    localeCode: string;
    /** Skip product sub-sitemaps of an index (category fallback discovery). */
    skipProductSitemaps: boolean;
}

export interface SitemapDiscoveryOptions {
    /** Only read non-product sub-sitemaps, to find category pages when product pages
     * carry no category breadcrumbs. */
    skipProductSitemaps?: boolean;
}

function isValidUrl(url: string): boolean {
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
}

function isInScope(loc: string, scope: SitemapScope): boolean {
    try {
        if (new URL(loc).origin !== scope.origin) return false;
    } catch {
        return false;
    }
    return !scope.pathPrefix || loc.startsWith(scope.pathPrefix);
}

function collectLocs(locs: string[], scope: SitemapScope, out: string[]): void {
    for (const loc of locs) {
        if (out.length >= MAX_SITEMAP_URLS) return;
        if (isInScope(loc, scope)) out.push(loc);
    }
}

const PRODUCT_SCORE = 0;

/** Category patterns are checked first: WooCommerce names its category sitemap
 * `product_cat-sitemap.xml`, which would otherwise count as a product sitemap. */
function contentScore(url: string): number {
    if (/categor|kategorie|collection|product_cat/i.test(url)) return 10;
    if (/\bprod\b|product|produkt|artikel/i.test(url)) return PRODUCT_SCORE;
    return 20;
}

function isProductSitemap(url: string): boolean {
    return contentScore(url) === PRODUCT_SCORE;
}

/** Lower is better: product/category content first, locale match gets a bonus. */
function subSitemapScore(url: string, localeCode: string): number {
    const localeBonus = localeCode.length >= 4 && url.toLowerCase().includes(localeCode) ? 15 : 0;
    return contentScore(url) - localeBonus;
}

function sortSubSitemaps(urls: string[], localeCode: string): string[] {
    return [...urls].sort(
        (a, b) => subSitemapScore(a, localeCode) - subSitemapScore(b, localeCode)
    );
}

/** Fetch one sub-sitemap of an index; returns true when it added URLs. */
async function processSubSitemap(
    subUrl: string,
    scope: SitemapScope,
    out: string[],
    depth: number
): Promise<boolean> {
    const subXml = await fetchText(subUrl);
    if (!subXml || !looksLikeSitemap(subXml)) return false;
    const before = out.length;
    if (!isSitemapIndex(subXml)) {
        collectLocs(extractLocsFromXml(subXml), scope, out);
    } else if (depth < 2) {
        await processSitemap(subUrl, scope, out, depth + 1);
    }
    return out.length > before;
}

/**
 * Iterate sorted sub-sitemaps with two separate limits:
 * - validCount: stop after 5 sub-sitemaps that actually added URLs
 * - attempts:   safety cap of 50 total fetches (handles stores like Foot Locker
 *   that have 30+ product sitemaps returning empty JSON before the real ones)
 */
async function processSitemapIndex(
    xml: string,
    scope: SitemapScope,
    out: string[],
    depth: number
): Promise<void> {
    const subUrls = extractLocsFromXml(xml)
        .filter(isValidUrl)
        .filter((url) => !scope.skipProductSitemaps || !isProductSitemap(url));
    let validCount = 0;
    let attempts = 0;
    for (const subUrl of sortSubSitemaps(subUrls, scope.localeCode)) {
        if (attempts >= 50 || out.length >= MAX_SITEMAP_URLS || validCount >= 5) return;
        attempts++;
        if (await processSubSitemap(subUrl, scope, out, depth)) validCount++;
    }
}

/** Fetch and process one sitemap (or sitemap index), collecting matching URLs. */
async function processSitemap(
    sitemapUrl: string,
    scope: SitemapScope,
    out: string[],
    depth = 0
): Promise<void> {
    const xml = await fetchText(sitemapUrl);
    if (!xml || !looksLikeSitemap(xml)) return;
    if (isSitemapIndex(xml)) {
        await processSitemapIndex(xml, scope, out, depth);
        return;
    }
    collectLocs(extractLocsFromXml(xml), scope, out);
}

/** Base path of the URL with a trailing slash (e.g. "/de/de/"). */
function basePathOf(baseUrl: string): string {
    return new URL(baseUrl).pathname.replace(/\/?$/, "/");
}

/** If baseUrl has a non-trivial path (e.g. /de/de/), restrict to that prefix so
 * multi-locale sitemaps (IKEA, Zara, etc.) don't bleed in other locales. */
function buildSitemapScope(
    baseUrl: string,
    origin: string,
    options: SitemapDiscoveryOptions
): SitemapScope {
    const basePath = basePathOf(baseUrl);
    const pathSegments = new URL(baseUrl).pathname.split("/").filter(Boolean);
    return {
        origin,
        pathPrefix: basePath.length > 1 ? `${origin}${basePath}` : null,
        localeCode: pathSegments.join("-").toLowerCase(),
        skipProductSitemaps: options.skipProductSitemaps ?? false,
    };
}

function editorialScore(url: string): number {
    return /magazin|magazine|blog|news|press|presse/i.test(url) ? 1 : 0;
}

/**
 * Build candidate sitemap URLs to try in priority order:
 * 1. robots.txt Sitemap directives (all of them — some sites list several)
 * 2. Root /sitemap.xml (conventional)
 * 3. Locale-specific /path/sitemap.xml (Shopware/locale shops like STABILO at /com/)
 *
 * Candidates are sorted so that magazine/blog-named sitemaps come last; this prevents
 * stores like bergzeit.de (whose robots.txt lists magazin/sitemap_index.xml first) from
 * returning only editorial content instead of products.
 */
async function collectSitemapCandidates(baseUrl: string, origin: string): Promise<string[]> {
    const robotsTxt = await fetchText(`${origin}/robots.txt`);
    const robotsSitemaps = [...(robotsTxt ?? "").matchAll(/^Sitemap:\s*(\S+)/gim)]
        .map((m) => m[1])
        .filter((url): url is string => !!url);
    const basePath = basePathOf(baseUrl);
    const localeSitemaps = basePath.length > 1 ? [`${origin}${basePath}sitemap.xml`] : [];
    const candidates = [
        ...new Set([...robotsSitemaps, `${origin}/sitemap.xml`, ...localeSitemaps]),
    ];
    return candidates.sort((a, b) => editorialScore(a) - editorialScore(b));
}

async function firstSitemapWithUrls(candidates: string[], scope: SitemapScope): Promise<string[]> {
    for (const candidate of candidates) {
        const urls: string[] = [];
        await processSitemap(candidate, scope, urls);
        if (urls.length > 0) return urls;
    }
    return [];
}

function originOf(url: string): string | null {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

/** Fetch and parse sitemap.xml, returning up to MAX_SITEMAP_URLS discovered URLs.
 * No URL classification — the page classifier handles that at fetch time. */
export async function discoverFromSitemap(
    baseUrl: string,
    options: SitemapDiscoveryOptions = {}
): Promise<string[]> {
    const origin = originOf(baseUrl);
    if (!origin) return [];

    const scope = buildSitemapScope(baseUrl, origin, options);
    const candidates = await collectSitemapCandidates(baseUrl, origin);

    const urls = await firstSitemapWithUrls(candidates, scope);
    if (urls.length > 0) return urls;

    // Fallback: if pathPrefix rejected every URL (base URL has a path component that
    // doesn't match actual page paths — e.g. /de-eu landing page on a single-locale site),
    // retry without the prefix constraint to collect all same-origin URLs.
    if (scope.pathPrefix) {
        const unscoped = await firstSitemapWithUrls(candidates, { ...scope, pathPrefix: null });
        if (unscoped.length > 0) return unscoped;
    }

    console.warn(`[sitemap] no sitemap found for ${origin}`);
    return [];
}

/** Group URLs by their first `depth` path segments ("root" for the homepage). */
function groupByBranch(urls: string[], depth: number): string[][] {
    const byBranch = new Map<string, string[]>();
    for (const url of urls) {
        if (!isValidUrl(url)) continue;
        const segs = new URL(url).pathname.split("/").filter(Boolean);
        const branch = segs.slice(0, depth).join("/") || "root";
        byBranch.set(branch, [...(byBranch.get(branch) ?? []), url]);
    }
    return [...byBranch.values()];
}

/** Take one URL per group per round until n URLs are picked or all groups are empty. */
function roundRobin(groups: string[][], n: number): string[] {
    const result: string[] = [];
    const longest = Math.max(0, ...groups.map((group) => group.length));
    for (let round = 0; round < longest; round++) {
        for (const group of groups) {
            if (result.length >= n) return result;
            const url = group[round];
            if (url) result.push(url);
        }
    }
    return result;
}

export interface SampleOptions {
    /** Put branches with a single URL into one shared group. Use it when many one-off
     * pages (blog posts at the root) would otherwise crowd out a large branch. */
    mergeSingleUrlBranches?: boolean;
}

function mergeSingleUrlBranches(groups: string[][]): string[][] {
    const singles = groups.filter((group) => group.length === 1).flat();
    const multi = groups.filter((group) => group.length > 1);
    return singles.length > 0 ? [...multi, singles] : multi;
}

/** Sample up to n URLs, picking one from each path branch for diversity.
 * Uses 2-segment branching when all URLs share the same first segment (e.g.
 * books.toscrape where everything is under /catalogue/ but category vs product
 * pages differ at the second segment). */
export function sampleUrls(urls: string[], n: number, options: SampleOptions = {}): string[] {
    if (urls.length <= n) return urls;

    // If one first-segment bucket holds the vast majority (>80%) of URLs,
    // group by two segments so distinct subtrees (e.g. /catalogue/category/... vs
    // /catalogue/book-name/...) each get representation in the sample.
    const byFirstSegment = groupByBranch(urls, 1);
    const maxBucketSize = Math.max(...byFirstSegment.map((group) => group.length));
    const groups = maxBucketSize / urls.length > 0.8 ? groupByBranch(urls, 2) : byFirstSegment;

    return roundRobin(options.mergeSingleUrlBranches ? mergeSingleUrlBranches(groups) : groups, n);
}
