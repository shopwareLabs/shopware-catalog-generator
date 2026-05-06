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

/** Fetch and process one sitemap (or sitemap index), collecting matching URLs. */
async function processSitemap(
    sitemapUrl: string,
    origin: string,
    pathPrefix: string | null,
    localeCode: string,
    out: string[],
    depth = 0
): Promise<void> {
    const xml = await fetchText(sitemapUrl);
    if (!xml || !looksLikeSitemap(xml)) return;

    function collect(locs: string[]) {
        for (const loc of locs) {
            if (out.length >= MAX_SITEMAP_URLS) break;
            try {
                if (new URL(loc).origin !== origin) continue;
                if (pathPrefix && !loc.startsWith(pathPrefix)) continue;
            } catch {
                continue;
            }
            out.push(loc);
        }
    }

    if (isSitemapIndex(xml)) {
        const subUrls = extractLocsFromXml(xml).filter((u) => {
            try {
                new URL(u);
                return true;
            } catch {
                return false;
            }
        });

        // Score sub-sitemaps: prefer product/category content AND locale match.
        const sorted = [...subUrls].sort((a, b) => {
            const score = (u: string) => {
                const ul = u.toLowerCase();
                let s = /\bprod\b|product|produkt|artikel/i.test(u)
                    ? 0
                    : /categor|kategorie|collection/i.test(u)
                      ? 10
                      : 20;
                if (localeCode.length >= 4 && ul.includes(localeCode)) s -= 15;
                return s;
            };
            return score(a) - score(b);
        });

        // Iterate sorted sub-sitemaps with two separate limits:
        // - validCount: stop after 5 sub-sitemaps that actually added URLs
        // - attempts:   safety cap of 50 total fetches (handles stores like Foot Locker
        //   that have 30+ product sitemaps returning empty JSON before the real ones)
        let validCount = 0;
        let attempts = 0;
        for (const subUrl of sorted) {
            if (attempts >= 50 || out.length >= MAX_SITEMAP_URLS || validCount >= 5) break;
            attempts++;
            const subXml = await fetchText(subUrl);
            if (!subXml || !looksLikeSitemap(subXml)) continue;
            const before = out.length;
            if (isSitemapIndex(subXml) && depth < 2) {
                await processSitemap(subUrl, origin, pathPrefix, localeCode, out, depth + 1);
            } else if (!isSitemapIndex(subXml)) {
                collect(extractLocsFromXml(subXml));
            }
            if (out.length > before) validCount++;
        }
    } else {
        collect(extractLocsFromXml(xml));
    }
}

/** Fetch and parse sitemap.xml, returning up to MAX_SITEMAP_URLS discovered URLs.
 * No URL classification — the page classifier handles that at fetch time. */
export async function discoverFromSitemap(baseUrl: string): Promise<string[]> {
    let origin: string;
    try {
        origin = new URL(baseUrl).origin;
    } catch {
        return [];
    }

    // If baseUrl has a non-trivial path (e.g. /de/de/), restrict to that prefix so
    // multi-locale sitemaps (IKEA, Zara, etc.) don't bleed in other locales.
    const basePath = new URL(baseUrl).pathname.replace(/\/?$/, "/");
    const pathPrefix = basePath.length > 1 ? `${origin}${basePath}` : null;
    const pathSegments = new URL(baseUrl).pathname.split("/").filter(Boolean);
    const localeCode = pathSegments.join("-").toLowerCase();

    // Build candidate sitemap URLs to try in priority order:
    // 1. robots.txt Sitemap directives (all of them — some sites list several)
    // 2. Root /sitemap.xml (conventional)
    // 3. Locale-specific /path/sitemap.xml (Shopware/locale shops like STABILO at /com/)
    //
    // Candidates are sorted so that magazine/blog-named sitemaps come last; this prevents
    // stores like bergzeit.de (whose robots.txt lists magazin/sitemap_index.xml first) from
    // returning only editorial content instead of products.
    const seen = new Set<string>();
    const candidates: string[] = [];

    const robotsTxt = await fetchText(`${origin}/robots.txt`);
    if (robotsTxt) {
        for (const m of robotsTxt.matchAll(/^Sitemap:\s*(\S+)/gim)) {
            if (m[1] && !seen.has(m[1])) {
                seen.add(m[1]);
                candidates.push(m[1]);
            }
        }
    }
    for (const url of [`${origin}/sitemap.xml`]) {
        if (!seen.has(url)) {
            seen.add(url);
            candidates.push(url);
        }
    }
    if (basePath.length > 1) {
        const localeSitemap = `${origin}${basePath}sitemap.xml`;
        if (!seen.has(localeSitemap)) {
            seen.add(localeSitemap);
            candidates.push(localeSitemap);
        }
    }

    // Deprioritize clearly editorial sitemaps so product/shop sitemaps are tried first.
    candidates.sort((a, b) => {
        const editScore = (u: string) =>
            /magazin|magazine|blog|news|press|presse/i.test(u) ? 1 : 0;
        return editScore(a) - editScore(b);
    });

    for (const candidate of candidates) {
        const urls: string[] = [];
        await processSitemap(candidate, origin, pathPrefix, localeCode, urls);
        if (urls.length > 0) return urls;
    }

    // Fallback: if pathPrefix rejected every URL (base URL has a path component that
    // doesn't match actual page paths — e.g. /de-eu landing page on a single-locale site),
    // retry without the prefix constraint to collect all same-origin URLs.
    if (pathPrefix) {
        for (const candidate of candidates) {
            const urls: string[] = [];
            await processSitemap(candidate, origin, null, localeCode, urls);
            if (urls.length > 0) return urls;
        }
    }

    console.warn(`[sitemap] no sitemap found for ${origin}`);
    return [];
}

/** Sample up to n URLs, picking one from each path branch for diversity.
 * Uses 2-segment branching when all URLs share the same first segment (e.g.
 * books.toscrape where everything is under /catalogue/ but category vs product
 * pages differ at the second segment). */
export function sampleUrls(urls: string[], n: number): string[] {
    if (urls.length <= n) return urls;

    const byBranch = new Map<string, string[]>();
    for (const url of urls) {
        try {
            const segs = new URL(url).pathname.split("/").filter(Boolean);
            const branch = segs[0] ?? "root";
            if (!byBranch.has(branch)) byBranch.set(branch, []);
            byBranch.get(branch)!.push(url);
        } catch {
            /* ignore */
        }
    }

    // If one first-segment bucket holds the vast majority (>80%) of URLs,
    // group by two segments so distinct subtrees (e.g. /catalogue/category/... vs
    // /catalogue/book-name/...) each get representation in the sample.
    const maxBucketSize = Math.max(...[...byBranch.values()].map((v) => v.length));
    if (maxBucketSize / urls.length > 0.8) {
        byBranch.clear();
        for (const url of urls) {
            try {
                const segs = new URL(url).pathname.split("/").filter(Boolean);
                const branch = segs.slice(0, 2).join("/") || "root";
                if (!byBranch.has(branch)) byBranch.set(branch, []);
                byBranch.get(branch)!.push(url);
            } catch {
                /* ignore */
            }
        }
    }

    const result: string[] = [];
    const iters = [...byBranch.values()].map((arr) => arr[Symbol.iterator]());

    while (result.length < n) {
        let added = 0;
        for (const it of iters) {
            if (result.length >= n) break;
            const { value, done } = it.next();
            if (!done && value) {
                result.push(value);
                added++;
            }
        }
        if (added === 0) break;
    }

    return result;
}
