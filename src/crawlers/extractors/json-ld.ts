import type { CheerioAPI } from "cheerio";

import type { ExampleProduct } from "../types.js";

interface JsonLdBlock {
    "@type"?: string | string[];
    "@graph"?: JsonLdBlock[];
    name?: string;
    description?: string;
    url?: string;
    item?: { name?: string; description?: string; url?: string };
    itemListElement?: Array<{
        "@type"?: string;
        name?: string;
        item?: { "@type"?: string; name?: string; description?: string; url?: string };
        position?: number;
    }>;
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

function hasType(block: JsonLdBlock, type: string): boolean {
    if (!block["@type"]) return false;
    const types = Array.isArray(block["@type"]) ? block["@type"] : [block["@type"]];
    return types.some((t) => t.toLowerCase() === type.toLowerCase());
}

/** Extract category names from BreadcrumbList blocks */
export function extractCategoriesFromJsonLd($: CheerioAPI): string[] {
    const blocks = parseBlocks($);
    const categories: string[] = [];

    for (const block of blocks) {
        if (!hasType(block, "BreadcrumbList")) continue;

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

    return [...new Set(categories)];
}

/** Extract example products from Product / ItemList blocks */
export function extractProductsFromJsonLd($: CheerioAPI): ExampleProduct[] {
    const blocks = parseBlocks($);
    const products: ExampleProduct[] = [];

    for (const block of blocks) {
        if (hasType(block, "Product")) {
            const name = block.name?.trim();
            if (name) {
                products.push({
                    name,
                    description:
                        typeof block.description === "string"
                            ? block.description.trim().slice(0, 300)
                            : undefined,
                });
            }
        }

        if (hasType(block, "ItemList")) {
            for (const el of block.itemListElement ?? []) {
                const candidate = el.item ?? (hasType(el as JsonLdBlock, "Product") ? (el as { name?: string; description?: string }) : null);
                if (!candidate) continue;
                const name = candidate.name?.trim();
                if (name) {
                    products.push({
                        name,
                        description:
                            typeof candidate.description === "string"
                                ? candidate.description.trim().slice(0, 300)
                                : undefined,
                    });
                }
            }
        }
    }

    return products;
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
