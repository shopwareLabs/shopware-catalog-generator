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
function isSubstantialProduct(block: Record<string, unknown>): boolean {
    return !!(
        block.offers ||
        block.sku ||
        block.gtin ||
        block.mpn ||
        block.description ||
        block.brand ||
        block.color ||
        block.material ||
        block.additionalProperty ||
        block.aggregateRating ||
        block.review
    );
}

interface JsonLdSignals {
    /** Definitive product/category signal — wins over og:type. */
    strong: PageType | null;
    /** CMS hint (FAQPage, AboutPage, …) — overridable by og:type=product because
     * product detail pages frequently embed FAQPage Q&A about the product itself. */
    weakCms: boolean;
}

function classifyFromJsonLd($: CheerioAPI): JsonLdSignals {
    const blocks: Record<string, unknown>[] = [];

    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const parsed: unknown = JSON.parse($(el).html() ?? "");
            blocks.push(...flattenBlocks(parsed));
        } catch {
            /* ignore malformed */
        }
    });

    let strong: PageType | null = null;
    let weakCms = false;

    for (const block of blocks) {
        const types = getTypes(block);
        if (types.length === 0) continue;

        if (!strong && types.some((t) => PRODUCT_TYPES.has(t)) && isSubstantialProduct(block)) {
            strong = "product";
        } else if (
            !strong &&
            types.some((t) => CATEGORY_TYPES.has(t)) &&
            !types.includes("breadcrumblist")
        ) {
            // ItemList subtypes are CATEGORY — except BreadcrumbList which is navigation
            strong = "category";
        }

        if (types.some((t) => CMS_TYPES.has(t))) weakCms = true;
    }

    return { strong, weakCms };
}

function classifyFromMicrodata($: CheerioAPI): PageType | null {
    let productCount = 0;
    let listCount = 0;
    let priceCount = 0;
    let aggregateRatingCount = 0;

    $("[itemtype]").each((_, el) => {
        const t = $(el).attr("itemtype")?.toLowerCase() ?? "";
        if (t.includes("schema.org/product")) productCount++;
        if (t.includes("schema.org/itemlist") && !t.includes("breadcrumb")) listCount++;
        if (t.includes("schema.org/aggregaterating")) aggregateRatingCount++;
    });

    $("[itemprop='price'], [itemprop='offers']").each((_i, _el) => {
        priceCount++;
    });

    // Multiple Product scopes without an explicit ItemList → product cards on a listing page.
    // A single Product scope without any list → product detail page.
    if (productCount >= 2 && listCount === 0) return "category";
    if (productCount === 1 && listCount === 0) return "product";
    if (listCount > 0) return "category";
    if (priceCount >= 3) return "category";
    if (priceCount === 1) return "product";
    // A single AggregateRating block without a list → product detail page.
    // Category pages may show per-card ratings but those are typically inline itemprop,
    // not a structured AggregateRating scope; one scope = one product being rated.
    if (aggregateRatingCount === 1 && listCount === 0) return "product";

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

    // Tier 3: Price count + cart-text count (regex, no DOM dependency).
    // Strip inline scripts first so JS variable names like openOffcanvasAfter[AddToCart]
    // don't produce false cart matches on every page.
    const htmlNoScript = html.replace(/<script[\s\S]*?<\/script>/gi, "");
    const priceCount = (htmlNoScript.match(PRICE_RE) ?? []).length;
    const cartCount = (htmlNoScript.match(CART_RE) ?? []).length;

    if (priceCount >= 10) return "category";
    if (cartCount >= 2) return "category";
    // 6–9 prices with no cart signal: listing pages that don't render full product grids
    // (e.g. Hyva/Adobe Commerce category pages that SSR only 6–8 product cards).
    // Placed before the 1–5 product rule so it catches the gap between the two thresholds.
    if (priceCount >= 6 && cartCount === 0) return "category";
    // 1–9 prices with 0–1 cart signals → product detail page.
    // The ≥6 category rule above already handled 6–9 prices with 0 cart (listing pages).
    // Reaching here with 6–9 prices means cartCount === 1 (variant-priced product pages).
    // cartCount === 0 also covers shops where the cart button is JS-only (YT Industries).
    if (priceCount >= 1 && priceCount <= 9 && cartCount <= 1) return "product";

    // og:type=product.group as tiebreaker when Tier 3 gives no price signal.
    // IKEA uses this on all category/collection pages (no prices on those pages).
    if (ogType === "product.group") return "category";

    if (priceCount === 0 && cartCount === 0) return "cms";

    return "unknown";
}
