/**
 * Product name hydrator - unique names, and variant parents without a variant value
 *
 * Product hydration runs per category branch, so two branches sometimes name a product
 * the same ("Acoustic Guitar - Natural Spruce - Dreadnought" twice), or almost the same
 * ("1.5 L" and "1.5L"). The products differ in description, properties and images, only
 * the name collides. The upload used to add "(2)" to such names.
 *
 * Variant parents often name one of their variant values ("Ankle Boots - Black - Block
 * Heel" with Black, Burgundy, ...), or a value that is not even an option ("Sunscreen -
 * 100ml" with 500ml / 750ml / 1L). Shopware shows the parent name for every variant.
 *
 * This pass first drops those segments from variant parent names (no AI), then asks the
 * AI for a new name for every product whose name is already taken (one call per
 * NAME_BATCH_SIZE products). Descriptions, properties and images stay as they are.
 */

import { z } from "zod";

import type {
    BlueprintCategory,
    BlueprintProduct,
    HydratedBlueprint,
    TextProvider,
} from "../../types/index.js";
import type { StoreContext } from "./product.js";

import { deriveProductSeoMeta, executeWithRetry, logger, stripHtml } from "../../utils/index.js";
import { flattenCategories } from "./category.js";

/** Products per AI call */
export const NAME_BATCH_SIZE = 25;

const NAME_SEPARATOR = " - ";
const DESCRIPTION_CHARS = 200;

const NameResponseSchema = z.object({
    names: z.array(z.object({ index: z.number().int(), name: z.string() })),
});

/** Key two names share when a shopper would read them as the same name */
export function productNameKey(name: string): string {
    return name
        .replace(/\s*\(\d+\)\s*$/, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Variant values a parent name must not carry: its options and its own value per group */
function variantValueKeys(product: BlueprintProduct): Set<string> {
    const configs = product.metadata.variantConfigs ?? [];
    const groups = new Set(configs.map((c) => c.group.toLowerCase()));
    const ownValues = product.metadata.properties
        .filter((p) => groups.has(p.group.toLowerCase()))
        .map((p) => p.value);
    return new Set(
        [...configs.flatMap((c) => c.selectedOptions), ...ownValues].map(productNameKey)
    );
}

/**
 * Drop the name segments of a variant parent that name a variant value.
 * The first segment (the product type) always stays.
 */
export function stripVariantValues(product: BlueprintProduct): string {
    if (!product.metadata.isVariant) return product.name;
    const values = variantValueKeys(product);
    const [type, ...details] = product.name.split(NAME_SEPARATOR);
    const kept = details.filter((segment) => !values.has(productNameKey(segment)));
    return [type, ...kept].join(NAME_SEPARATOR);
}

/** Product with a new name; a derived meta title follows the name, so the SEO title is not stale */
function withName(product: BlueprintProduct, name: string): BlueprintProduct {
    if (name === product.name) return product;
    if (!product.metaTitle) return { ...product, name };
    const { metaTitle } = deriveProductSeoMeta(name, product.description);
    return { ...product, name, metaTitle };
}

/** All products after the first one of each name */
export function findDuplicateNameProducts(products: BlueprintProduct[]): BlueprintProduct[] {
    const seen = new Set<string>();
    return products.filter((p) => {
        const key = productNameKey(p.name);
        if (seen.has(key)) return true;
        seen.add(key);
        return false;
    });
}

function deepestCategoryName(
    product: BlueprintProduct,
    categories: Map<string, BlueprintCategory>
): string {
    const assigned = product.categoryIds
        .map((id) => categories.get(id))
        .filter((c): c is BlueprintCategory => c !== undefined);
    return assigned.sort((a, b) => b.level - a.level)[0]?.name ?? "";
}

function describeProduct(
    product: BlueprintProduct,
    index: number,
    categories: Map<string, BlueprintCategory>
): string {
    const variantGroups = (product.metadata.variantConfigs ?? []).map((c) => c.group);
    const properties = product.metadata.properties.map((p) => `${p.group}: ${p.value}`);
    const parts = [
        `${index}. ${product.name}`,
        `category: ${deepestCategoryName(product, categories)}`,
        properties.length > 0 ? `properties: ${properties.join(", ")}` : "",
        variantGroups.length > 0 ? `sold in variants of: ${variantGroups.join(", ")}` : "",
        `description: ${stripHtml(product.description).trim().slice(0, DESCRIPTION_CHARS)}`,
    ];
    return parts.filter(Boolean).join(" | ");
}

function buildMessages(
    lines: string[],
    takenNames: string[],
    store: StoreContext
): Array<{ role: "system" | "user"; content: string }> {
    return [
        {
            role: "system",
            content: "You name products for an online shop. You ONLY output valid JSON.",
        },
        {
            role: "user",
            content: [
                `Store: "${store.name}"`,
                `Description: ${store.description}`,
                "",
                "Another product in the shop already has the name of each product below.",
                "Give each product a new name that tells it apart, based on its own",
                "description and properties.",
                "",
                "Rules:",
                '- same pattern: "[Product Type] - [Detail] - [Detail]"',
                "- never one of the names that are taken",
                "- no value of a variant group in the name (a variant product is sold in all of them)",
                "- keep the index of each product",
                "",
                "Taken names:",
                ...takenNames.map((n) => `- ${n}`),
                "",
                "Products:",
                ...lines,
                "",
                'Return JSON: {"names":[{"index":1,"name":"..."}]}',
            ].join("\n"),
        },
    ];
}

function parseNames(response: string, count: number): Map<number, string> {
    const json = response
        .replace(/```json?\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
    const parsed = NameResponseSchema.parse(JSON.parse(json));
    return new Map(
        parsed.names
            .filter((n) => n.index >= 1 && n.index <= count && n.name.trim() !== "")
            .map((n) => [n.index, n.name.trim()])
    );
}

/** Ask the AI for one batch; an empty map on failure (names stay as they are) */
async function fetchBatchNames(
    textProvider: TextProvider,
    batch: BlueprintProduct[],
    takenNames: string[],
    categories: Map<string, BlueprintCategory>,
    store: StoreContext
): Promise<Map<string, string>> {
    const lines = batch.map((p, i) => describeProduct(p, i + 1, categories));
    try {
        const response = await executeWithRetry(() =>
            textProvider.generateCompletion(
                buildMessages(lines, takenNames, store),
                NameResponseSchema,
                "ProductNames"
            )
        );
        const byIndex = parseNames(response, batch.length);
        return new Map(
            batch.flatMap((p, i) => {
                const name = byIndex.get(i + 1);
                return name ? [[p.id, name] as const] : [];
            })
        );
    } catch (error) {
        logger.warn("Product name request failed, keeping the duplicate names", {
            cli: true,
            data: { error: error instanceof Error ? error.message : String(error) },
        });
        return new Map();
    }
}

/** Result of a name pass */
export interface NameHydrationResult {
    products: BlueprintProduct[];
    /** Variant parents that lost a variant value from their name */
    cleaned: number;
    /** Products that got a new name because theirs was taken */
    renamed: number;
    /** Products that still share their name (AI failed or returned a taken name) */
    stillDuplicate: number;
}

/** Accept the AI names that are still free; a taken proposal keeps the old name */
function applyNames(
    products: BlueprintProduct[],
    proposals: Map<string, string>
): { products: BlueprintProduct[]; renamed: number } {
    const taken = new Set(
        products.filter((p) => !proposals.has(p.id)).map((p) => productNameKey(p.name))
    );
    let renamed = 0;
    const result = products.map((product) => {
        const proposal = proposals.get(product.id);
        if (!proposal) return product;
        const candidate = stripVariantValues({ ...product, name: proposal });
        if (taken.has(productNameKey(candidate))) return product;
        taken.add(productNameKey(candidate));
        renamed++;
        return withName(product, candidate);
    });
    return { products: result, renamed };
}

function chunk<T>(items: T[], size: number): T[][] {
    return Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
        items.slice(i * size, (i + 1) * size)
    );
}

/**
 * Clean variant parent names, then rename every product whose name is taken.
 */
export async function hydrateProductNames(
    textProvider: TextProvider,
    blueprint: Pick<HydratedBlueprint, "categories" | "products">,
    store: StoreContext
): Promise<NameHydrationResult> {
    const cleanedProducts = blueprint.products.map((p) => withName(p, stripVariantValues(p)));
    const cleaned = cleanedProducts.filter((p, i) => p.name !== blueprint.products[i]?.name).length;
    const duplicates = findDuplicateNameProducts(cleanedProducts);
    if (duplicates.length === 0) {
        return { products: cleanedProducts, cleaned, renamed: 0, stillDuplicate: 0 };
    }

    logger.info(`  Renaming ${duplicates.length} products with a duplicate name...`, {
        cli: true,
    });
    const categories = new Map(flattenCategories(blueprint.categories).map((c) => [c.id, c]));
    const takenNames = [...new Set(cleanedProducts.map((p) => p.name))];
    const proposals = new Map<string, string>();
    for (const batch of chunk(duplicates, NAME_BATCH_SIZE)) {
        const names = await fetchBatchNames(textProvider, batch, takenNames, categories, store);
        for (const [id, name] of names) proposals.set(id, name);
    }

    const { products, renamed } = applyNames(cleanedProducts, proposals);
    const stillDuplicate = findDuplicateNameProducts(products).length;
    return { products, cleaned, renamed, stillDuplicate };
}
