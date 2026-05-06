import type { CheerioAPI } from "cheerio";

import type { ExampleProduct } from "../types.js";

interface JsonLdBlock {
    "@type"?: string | string[];
    "@graph"?: JsonLdBlock[];
    name?: string;
    description?: string;
    url?: string;
    brand?: { name?: string } | string;
    color?: string;
    material?: string;
    category?: string | string[];
    additionalProperty?: Array<{ "@type"?: string; name?: string; value?: string | number }>;
    item?: JsonLdBlock;
    itemListElement?: Array<JsonLdBlock & { position?: number }>;
    hasVariant?: JsonLdBlock[];
}

function parseBlocks($: CheerioAPI): JsonLdBlock[] {
    const blocks: JsonLdBlock[] = [];

    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const text = $(el).html() ?? "";
            const parsed = JSON.parse(text) as JsonLdBlock | JsonLdBlock[];

            if (Array.isArray(parsed)) {
                blocks.push(...parsed);
            } else if (parsed["@graph"]) {
                blocks.push(...(parsed["@graph"] as JsonLdBlock[]));
            } else {
                blocks.push(parsed);
            }
        } catch {
            // ignore malformed JSON-LD
        }
    });

    return blocks;
}

function normalizeType(t: string): string {
    return t.toLowerCase().replace(/^https?:\/\/schema\.org\//, "");
}

function hasType(block: JsonLdBlock, type: string): boolean {
    if (!block["@type"]) return false;
    const types = Array.isArray(block["@type"]) ? block["@type"] : [block["@type"]];
    const target = type.toLowerCase();
    return types.some((t) => normalizeType(t) === target);
}

/** Extract category names from BreadcrumbList blocks and Product/ProductGroup.category */
export function extractCategoriesFromJsonLd($: CheerioAPI): string[] {
    const blocks = parseBlocks($);
    const categories: string[] = [];

    for (const block of blocks) {
        if (hasType(block, "BreadcrumbList")) {
            for (const item of block.itemListElement ?? []) {
                const name = item.name ?? item.item?.name;
                if (name && typeof name === "string") {
                    const trimmed = name.trim();
                    if (trimmed.length > 1 && trimmed.length < 60) {
                        categories.push(trimmed);
                    }
                }
            }
        }

        // Shopify ProductGroup carries a `category` string (e.g. "shorts", "leggings")
        // when there is no BreadcrumbList — use it as a fallback category signal.
        if (hasType(block, "Product") || hasType(block, "ProductGroup")) {
            const cats = block.category;
            const raw = typeof cats === "string" ? [cats] : Array.isArray(cats) ? cats : [];
            for (const cat of raw) {
                const trimmed = cat.trim();
                if (trimmed.length > 1 && trimmed.length < 60) categories.push(trimmed);
            }
        }
    }

    return [...new Set(categories)];
}

function extractProductProperties(block: JsonLdBlock): Record<string, string> | undefined {
    const props: Record<string, string> = {};

    if (block.brand) {
        const brandName = typeof block.brand === "string" ? block.brand : block.brand.name;
        if (brandName) props["brand"] = brandName;
    }
    if (block.color && typeof block.color === "string") props["color"] = block.color;
    if (block.material && typeof block.material === "string") props["material"] = block.material;

    if (Array.isArray(block.additionalProperty)) {
        for (const ap of block.additionalProperty) {
            if (ap.name && ap.value != null) {
                const key = ap.name.toLowerCase().replace(/\s+/g, "_");
                if (!(key in props)) props[key] = String(ap.value);
            }
        }
    }

    return Object.keys(props).length > 0 ? props : undefined;
}

function productFromBlock(block: JsonLdBlock): ExampleProduct | null {
    const name = block.name?.trim();
    if (!name) return null;
    const cats = block.category;
    const category =
        typeof cats === "string" ? cats.trim() : Array.isArray(cats) ? cats[0]?.trim() : undefined;
    const desc = typeof block.description === "string" ? block.description.trim() : "";
    return {
        name,
        description: desc ? desc.slice(0, 300) : undefined,
        category: category || undefined,
        properties: extractProductProperties(block),
    };
}

/** Extract example products from Product / ProductGroup / ItemList blocks */
export function extractProductsFromJsonLd($: CheerioAPI): ExampleProduct[] {
    const blocks = parseBlocks($);
    const products: ExampleProduct[] = [];

    for (const block of blocks) {
        // ProductGroup is Shopify's standard type for variant products (hasVariant[] of Products)
        if (hasType(block, "Product") || hasType(block, "ProductGroup")) {
            const p = productFromBlock(block);
            if (p) products.push(p);
        }

        if (hasType(block, "ItemList")) {
            for (const el of block.itemListElement ?? []) {
                // Require explicit @type: "Product" — prevents category/navigation ItemLists
                // (e.g. IKEA's "Produkte" list with room/category names) from leaking through
                const candidate = el.item
                    ? hasType(el.item, "Product")
                        ? el.item
                        : null
                    : hasType(el, "Product")
                      ? el
                      : null;
                if (!candidate) continue;
                const p = productFromBlock(candidate);
                if (p) products.push(p);
            }
        }
    }

    return products;
}

/** Extract category names from microdata BreadcrumbList (Shopware 5, older Magento/WooCommerce) */
export function extractCategoriesFromMicrodata($: CheerioAPI): string[] {
    const categories: string[] = [];

    $("[itemtype]").each((_, el) => {
        const t = $(el).attr("itemtype") ?? "";
        if (!t.toLowerCase().includes("breadcrumblist")) return;

        $(el)
            .find("[itemprop='itemListElement']")
            .each((_, item) => {
                const name = $(item).find("[itemprop='name']").first().text().trim();
                if (name.length > 1 && name.length < 60) categories.push(name);
            });
    });

    return [...new Set(categories)];
}

/** Extract brand description from Organization / WebSite blocks */
export function extractBrandDescriptionFromJsonLd($: CheerioAPI): string | undefined {
    const blocks = parseBlocks($);

    for (const block of blocks) {
        if (hasType(block, "Organization") || hasType(block, "WebSite")) {
            const desc = block.description?.trim();
            if (desc && desc.length > 10) return desc;
        }
    }

    return undefined;
}
