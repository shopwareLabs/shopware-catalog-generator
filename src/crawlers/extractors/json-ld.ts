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

/** ProductGroup is Shopify's standard type for variant products (hasVariant[] of Products) */
function isProductBlock(block: JsonLdBlock): boolean {
    return hasType(block, "Product") || hasType(block, "ProductGroup");
}

function isCategoryNameLength(name: string): boolean {
    return name.length > 1 && name.length < 60;
}

function categoryValues(category: JsonLdBlock["category"]): string[] {
    if (typeof category === "string") return [category];
    return Array.isArray(category) ? category : [];
}

function breadcrumbNames(block: JsonLdBlock): string[] {
    if (!hasType(block, "BreadcrumbList")) return [];
    return (block.itemListElement ?? [])
        .map((item) => item.name ?? item.item?.name)
        .filter((name): name is string => typeof name === "string")
        .map((name) => name.trim())
        .filter(isCategoryNameLength);
}

/** Shopify ProductGroup carries a `category` string (e.g. "shorts", "leggings")
 * when there is no BreadcrumbList — use it as a fallback category signal. */
function productCategoryNames(block: JsonLdBlock): string[] {
    if (!isProductBlock(block)) return [];
    return categoryValues(block.category)
        .map((cat) => cat.trim())
        .filter(isCategoryNameLength);
}

/** Extract category names from BreadcrumbList blocks and Product/ProductGroup.category */
export function extractCategoriesFromJsonLd($: CheerioAPI): string[] {
    const categories = parseBlocks($).flatMap((block) => [
        ...breadcrumbNames(block),
        ...productCategoryNames(block),
    ]);
    return [...new Set(categories)];
}

function brandNameOf(brand: JsonLdBlock["brand"]): string | undefined {
    if (!brand) return undefined;
    return typeof brand === "string" ? brand : brand.name;
}

function basicProductProperties(block: JsonLdBlock): Record<string, string> {
    const props: Record<string, string> = {};
    const brandName = brandNameOf(block.brand);
    if (brandName) props["brand"] = brandName;
    if (block.color && typeof block.color === "string") props["color"] = block.color;
    if (block.material && typeof block.material === "string") props["material"] = block.material;
    return props;
}

/** Add additionalProperty entries (snake_case keys) without overwriting existing keys. */
function addAdditionalProperties(
    props: Record<string, string>,
    additional: JsonLdBlock["additionalProperty"]
): void {
    if (!Array.isArray(additional)) return;
    for (const ap of additional) {
        if (!ap.name || ap.value == null) continue;
        const key = ap.name.toLowerCase().replace(/\s+/g, "_");
        if (!(key in props)) props[key] = String(ap.value);
    }
}

function extractProductProperties(block: JsonLdBlock): Record<string, string> | undefined {
    const props = basicProductProperties(block);
    addAdditionalProperties(props, block.additionalProperty);
    return Object.keys(props).length > 0 ? props : undefined;
}

function productFromBlock(block: JsonLdBlock): ExampleProduct | null {
    const name = block.name?.trim();
    if (!name) return null;
    const category = categoryValues(block.category)[0]?.trim();
    const desc = typeof block.description === "string" ? block.description.trim() : "";
    return {
        name,
        description: desc ? desc.slice(0, 300) : undefined,
        category: category || undefined,
        properties: extractProductProperties(block),
    };
}

/** Require explicit @type: "Product" — prevents category/navigation ItemLists
 * (e.g. IKEA's "Produkte" list with room/category names) from leaking through */
function itemListProduct(element: JsonLdBlock): JsonLdBlock | null {
    if (element.item) return hasType(element.item, "Product") ? element.item : null;
    return hasType(element, "Product") ? element : null;
}

function productBlocksOf(block: JsonLdBlock): JsonLdBlock[] {
    const own = isProductBlock(block) ? [block] : [];
    if (!hasType(block, "ItemList")) return own;
    const listed = (block.itemListElement ?? [])
        .map(itemListProduct)
        .filter((candidate): candidate is JsonLdBlock => candidate !== null);
    return [...own, ...listed];
}

/** Extract example products from Product / ProductGroup / ItemList blocks */
export function extractProductsFromJsonLd($: CheerioAPI): ExampleProduct[] {
    return parseBlocks($)
        .flatMap(productBlocksOf)
        .map(productFromBlock)
        .filter((product): product is ExampleProduct => product !== null);
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
