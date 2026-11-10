import type { CheerioAPI } from "cheerio";

export type PageType = "product" | "category" | "cms" | "unknown";

const PRODUCT_TYPES = new Set([
    "product",
    "productgroup",
    "productmodel",
    "individualproduct",
    "vehicle",
    "drug",
    "dietarysupplement",
]);

const CATEGORY_TYPES = new Set(["itemlist", "offercatalog", "productcollection", "collectionpage"]);

const CMS_TYPES = new Set([
    "article",
    "newsarticle",
    "blogposting",
    "techarticle",
    "report",
    "recipe",
    "howto",
    "review",
    "event",
    "aboutpage",
    "contactpage",
    "faqpage",
    "qapage",
    "checkoutpage",
    "searchresultspage",
    "profilepage",
]);

const PRICE_RE = /\d{1,4}[.,]\d{2}\s*[€£$]|[€£$]\s*\d{1,4}[.,]\d{2}/g;
const CART_RE =
    /in\s*den\s*warenkorb|add\s*to\s*cart|add\s*to\s*basket|add\s*to\s*bag|jetzt\s*kaufen|buy\s*now/gi;

function getTypes(block: Record<string, unknown>): string[] {
    const raw = block["@type"];
    if (!raw) return [];
    const arr = Array.isArray(raw) ? raw : [raw];
    return (arr as string[]).map((t) => t.toLowerCase().replace(/^https?:\/\/schema\.org\//, ""));
}

function flattenBlocks(data: unknown): Record<string, unknown>[] {
    if (!data || typeof data !== "object") return [];
    if (Array.isArray(data)) return data.flatMap(flattenBlocks);
    const obj = data as Record<string, unknown>;
    const graph = obj["@graph"];
    if (graph && Array.isArray(graph)) return graph.flatMap(flattenBlocks);
    return [obj];
}

/** A bare Product with only a name is a navigation/category item, not a real product.
 * Real products have at least one product-specific field. */
const PRODUCT_DETAIL_FIELDS = [
    "offers",
    "sku",
    "gtin",
    "mpn",
    "description",
    "brand",
    "color",
    "material",
    "additionalProperty",
    "aggregateRating",
    "review",
];

function isSubstantialProduct(block: Record<string, unknown>): boolean {
    return PRODUCT_DETAIL_FIELDS.some((field) => !!block[field]);
}

interface JsonLdSignals {
    /** Definitive product/category signal — wins over og:type. */
    strong: PageType | null;
    /** CMS hint (FAQPage, AboutPage, …) — overridable by og:type=product because
     * product detail pages frequently embed FAQPage Q&A about the product itself. */
    weakCms: boolean;
}

function parseJsonLdBlocks($: CheerioAPI): Record<string, unknown>[] {
    const blocks: Record<string, unknown>[] = [];

    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const parsed: unknown = JSON.parse($(el).html() ?? "");
            blocks.push(...flattenBlocks(parsed));
        } catch {
            /* ignore malformed */
        }
    });

    return blocks;
}

/** Definitive product/category signal of one JSON-LD block, null when it has none. */
function strongSignalOf(types: string[], block: Record<string, unknown>): PageType | null {
    if (types.some((t) => PRODUCT_TYPES.has(t)) && isSubstantialProduct(block)) return "product";
    // ItemList subtypes are CATEGORY — except BreadcrumbList which is navigation
    if (types.some((t) => CATEGORY_TYPES.has(t)) && !types.includes("breadcrumblist")) {
        return "category";
    }
    return null;
}

function classifyFromJsonLd($: CheerioAPI): JsonLdSignals {
    let strong: PageType | null = null;
    let weakCms = false;

    for (const block of parseJsonLdBlocks($)) {
        const types = getTypes(block);
        strong ??= strongSignalOf(types, block);
        if (types.some((t) => CMS_TYPES.has(t))) weakCms = true;
    }

    return { strong, weakCms };
}

interface MicrodataSignals {
    productCount: number;
    listCount: number;
    priceCount: number;
    aggregateRatingCount: number;
}

function countMicrodataSignals($: CheerioAPI): MicrodataSignals {
    const itemtypes = $("[itemtype]")
        .toArray()
        .map((el) => $(el).attr("itemtype")?.toLowerCase() ?? "");
    const countMatching = (predicate: (t: string) => boolean): number =>
        itemtypes.filter(predicate).length;

    return {
        productCount: countMatching((t) => t.includes("schema.org/product")),
        listCount: countMatching(
            (t) => t.includes("schema.org/itemlist") && !t.includes("breadcrumb")
        ),
        priceCount: $("[itemprop='price'], [itemprop='offers']").length,
        aggregateRatingCount: countMatching((t) => t.includes("schema.org/aggregaterating")),
    };
}

function classifyFromMicrodata($: CheerioAPI): PageType | null {
    const { productCount, listCount, priceCount, aggregateRatingCount } = countMicrodataSignals($);

    // An explicit ItemList → listing page.
    if (listCount > 0) return "category";
    // Multiple Product scopes without an explicit ItemList → product cards on a listing page.
    // A single Product scope without any list → product detail page.
    if (productCount >= 2) return "category";
    if (productCount === 1) return "product";
    if (priceCount >= 3) return "category";
    if (priceCount === 1) return "product";
    // A single AggregateRating block without a list → product detail page.
    // Category pages may show per-card ratings but those are typically inline itemprop,
    // not a structured AggregateRating scope; one scope = one product being rated.
    if (aggregateRatingCount === 1) return "product";

    return null;
}

export function classifyPage(html: string, $: CheerioAPI): PageType {
    // Tier 1: JSON-LD Schema.org definitive product/category signal
    const jsonLd = classifyFromJsonLd($);
    if (jsonLd.strong) return jsonLd.strong;

    // Tier 1: og:type article is a definitive CMS signal
    // Strip legacy "og:" prefix (some shops emit content="og:product" instead of "product")
    const ogType = ($('meta[property="og:type"]').attr("content")?.toLowerCase() ?? "").replace(
        /^og:/,
        ""
    );
    if (ogType === "article") return "cms";

    // Tier 2: Microdata
    const fromMicrodata = classifyFromMicrodata($);
    if (fromMicrodata) return fromMicrodata;

    // Tier 2: og:type=product is a definitive product signal (Shopware, Shopify, WooCommerce).
    // Checked BEFORE price counting because product detail pages often show many variant
    // prices (10-20+) which would otherwise trigger the "≥10 prices → category" rule.
    // Also takes precedence over JSON-LD CMS hints because product pages often embed
    // FAQPage Q&A blocks about the product itself (Koro, Shopify shops with FAQ snippets).
    if (ogType === "product") return "product";

    // JSON-LD CMS hint (FAQPage, AboutPage, ContactPage, etc.) — applied only if no
    // stronger product/category signal was found.
    if (jsonLd.weakCms) return "cms";

    // Tier 3: Price count + cart-text count
    const signals = countCommerceSignals(html);
    const fromPrices = classifyFromPriceSignals(signals);
    if (fromPrices) return fromPrices;

    // og:type=product.group as tiebreaker when Tier 3 gives no price signal.
    // IKEA uses this on all category/collection pages (no prices on those pages).
    if (ogType === "product.group") return "category";

    // No prices: no cart text means an editorial page, a single cart match stays unknown
    return signals.cartCount === 0 ? "cms" : "unknown";
}

interface CommerceSignals {
    priceCount: number;
    cartCount: number;
}

/**
 * Count prices and add-to-cart texts with regexes (no DOM dependency).
 * Inline scripts are stripped first so JS variable names like openOffcanvasAfter[AddToCart]
 * don't produce false cart matches on every page.
 */
function countCommerceSignals(html: string): CommerceSignals {
    const htmlNoScript = html.replace(/<script[\s\S]*?<\/script>/gi, "");
    return {
        priceCount: (htmlNoScript.match(PRICE_RE) ?? []).length,
        cartCount: (htmlNoScript.match(CART_RE) ?? []).length,
    };
}

/** Tier 3 decision; null when the page shows no price at all */
function classifyFromPriceSignals({ priceCount, cartCount }: CommerceSignals): PageType | null {
    if (priceCount >= 10) return "category";
    if (cartCount >= 2) return "category";
    // 6–9 prices with no cart signal: listing pages that don't render full product grids
    // (e.g. Hyva/Adobe Commerce category pages that SSR only 6–8 product cards).
    if (priceCount >= 6 && cartCount === 0) return "category";
    // 1–9 prices with 0–1 cart signals → product detail page. 6–9 prices only get here
    // with one cart signal (variant-priced product pages). cartCount === 0 also covers
    // shops where the cart button is JS-only (YT Industries).
    if (priceCount >= 1) return "product";
    return null;
}
