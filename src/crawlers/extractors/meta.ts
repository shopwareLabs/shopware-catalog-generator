import type { CheerioAPI } from "cheerio";

const HEX_COLOR_RE = /#([0-9a-fA-F]{3}){1,2}\b/;

/** Extract brand description from og:description or meta description */
export function extractBrandDescription($: CheerioAPI): string | undefined {
    const og = $('meta[property="og:description"]').attr("content")?.trim();
    if (og && og.length > 10) return og;

    const meta = $('meta[name="description"]').attr("content")?.trim();
    if (meta && meta.length > 10) return meta;

    return undefined;
}

/** Extract primary brand color from theme-color meta tag or CSS custom properties */
export function extractPrimaryColor($: CheerioAPI): string | undefined {
    const themeColor = $('meta[name="theme-color"]').attr("content")?.trim();
    if (themeColor && HEX_COLOR_RE.test(themeColor)) return themeColor.toLowerCase();

    // Scan inline <style> for common CSS variable names
    const cssVarRe =
        /--(?:primary|brand|main|accent|color-primary|color-brand)(?:-color)?[^:]*:\s*(#[0-9a-fA-F]{3,6})/gi;

    let color: string | undefined;

    $("style").each((_, el) => {
        if (color) return;
        const css = $(el).html() ?? "";
        const match = cssVarRe.exec(css);
        if (match?.[1]) {
            color = match[1].toLowerCase();
        }
        cssVarRe.lastIndex = 0;
    });

    return color;
}

/** Extract secondary/accent color from CSS custom properties */
export function extractSecondaryColor($: CheerioAPI): string | undefined {
    const cssVarRe =
        /--(?:secondary|accent|highlight|color-secondary|color-accent)(?:-color)?[^:]*:\s*(#[0-9a-fA-F]{3,6})/gi;

    let color: string | undefined;

    $("style").each((_, el) => {
        if (color) return;
        const css = $(el).html() ?? "";
        const match = cssVarRe.exec(css);
        if (match?.[1]) {
            color = match[1].toLowerCase();
        }
        cssVarRe.lastIndex = 0;
    });

    return color;
}

/** Extract category candidates from navigation links */
export function extractNavCategories($: CheerioAPI): string[] {
    const seen = new Set<string>();
    const categories: string[] = [];

    $("nav a, header a").each((_, el) => {
        const text = $(el).text().trim();
        const href = $(el).attr("href") ?? "";

        // Normalize internal whitespace (template strings, multi-line text nodes)
        const normalized = text.replace(/\s+/g, " ").trim();

        // Skip: empty, too short/long, query strings, anchors, external-looking links, template vars
        if (
            !normalized ||
            normalized.length < 2 ||
            normalized.length > 50 ||
            normalized.includes("{{") ||
            href.includes("?") ||
            href.startsWith("#") ||
            href.startsWith("mailto:") ||
            href.startsWith("tel:")
        ) {
            return;
        }

        // Skip generic navigation words (English + German)
        const lower = normalized.toLowerCase();
        const skipWords = new Set([
            // English
            "home",
            "login",
            "sign in",
            "sign up",
            "register",
            "account",
            "cart",
            "basket",
            "checkout",
            "wishlist",
            "search",
            "help",
            "faq",
            "contact",
            "about",
            "blog",
            "news",
            "careers",
            "privacy",
            "terms",
            "impressum",
            "datenschutz",
            "cookie",
            "sitemap",
            "back",
            "menu",
            // German
            "warenkorb",
            "merkzettel",
            "anmelden",
            "einloggen",
            "registrieren",
            "konto",
            "suche",
            "startseite",
            "kontakt",
            "hilfe",
            "impressum",
            "datenschutz",
            "karriere",
            "newsletter",
            "hej",
            // German legal / footer
            "jobs",
            "agb",
            "widerrufsrecht",
            "widerrufsbelehrung",
            "über",
            "händler",
            "leistungen",
            "versand",
            "zahlungsbedingungen",
            "datenschutzerklärung",
            "lieferung",
            "rückgabe",
            "presse",
            "stellenangebote",
        ]);

        // Exact match or any token matches — split on whitespace AND hyphens/slashes to handle
        // compound words like "Versand-/Zahlungsbedingungen" → ["versand", "zahlungsbedingungen"]
        const tokens = lower.split(/[\s/\-]+/).map((t) => t.replace(/[^a-z0-9äöüß]/g, ""));
        if (skipWords.has(lower) || tokens.some((t) => t.length > 2 && skipWords.has(t))) return;

        if (!seen.has(lower)) {
            seen.add(lower);
            categories.push(normalized);
        }
    });

    return categories.slice(0, 15);
}

/** Extract product name candidates from page headings (for product listing pages) */
export function extractProductHeadings($: CheerioAPI): string[] {
    const candidates: string[] = [];
    const seen = new Set<string>();

    $("h2, h3").each((_, el) => {
        const text = $(el).text().trim();
        if (
            !text ||
            text.length < 3 ||
            text.length > 80 ||
            seen.has(text.toLowerCase())
        ) {
            return;
        }

        // Skip headings that look like section titles (too generic or very long)
        const lower = text.toLowerCase();
        const skipPhrases = [
            "featured",
            "new arrivals",
            "best seller",
            "on sale",
            "categories",
            "shop by",
            "our products",
            "popular",
            "trending",
            "you may also like",
        ];
        if (skipPhrases.some((p) => lower.includes(p))) return;

        seen.add(lower);
        candidates.push(text);
    });

    return candidates.slice(0, 10);
}
