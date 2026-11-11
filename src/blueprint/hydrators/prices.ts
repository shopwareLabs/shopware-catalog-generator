/**
 * Price hydrator - realistic prices per product via one small AI call
 *
 * The blueprint generator only knows placeholders, so it rolls a uniform random price.
 * After hydration the product names are known: the AI returns the typical retail price
 * range for each product (with its category and pack size), and the price is rolled
 * inside that range. The roll is seeded by the product ID, so the same range always
 * gives the same price. Products the AI skips keep their price.
 */

import { z } from "zod";

import type {
    BlueprintCategory,
    BlueprintProduct,
    HydratedBlueprint,
    TextProvider,
} from "../../types/index.js";
import type { StoreContext } from "./product.js";

import { createSeededRandom, executeWithRetry, logger } from "../../utils/index.js";
import { flattenCategories } from "./category.js";

/** Products per AI call */
export const PRICE_BATCH_SIZE = 100;

const PriceRangeSchema = z.object({
    index: z.number().int(),
    min: z.number(),
    max: z.number(),
});

const PriceResponseSchema = z.object({
    prices: z.array(PriceRangeSchema),
});

/** Typical retail price range of one product */
export interface PriceRange {
    min: number;
    max: number;
}

/** Name of the most specific category the product is assigned to */
function productCategoryName(
    product: BlueprintProduct,
    categories: Map<string, BlueprintCategory>
): string {
    const assigned = product.categoryIds
        .map((id) => categories.get(id))
        .filter((c): c is BlueprintCategory => c !== undefined);
    const deepest = assigned.reduce<BlueprintCategory | undefined>(
        (best, c) => (!best || c.level > best.level ? c : best),
        undefined
    );
    return deepest?.name ?? "";
}

function describeProduct(
    product: BlueprintProduct,
    index: number,
    categories: Map<string, BlueprintCategory>
): string {
    const category = productCategoryName(product, categories);
    const pack = product.metadata.packaging;
    const parts = [
        `${index}. ${product.name}`,
        category ? `category: ${category}` : "",
        pack ? `pack: ${pack.purchaseUnit} ${pack.unitName}` : "",
    ];
    return parts.filter(Boolean).join(" | ");
}

function buildMessages(
    lines: string[],
    store: StoreContext
): Array<{ role: "system" | "user"; content: string }> {
    return [
        {
            role: "system",
            content:
                "You are a retail pricing expert. For each product, give the price range a " +
                "typical online shop of this kind charges for it in USD, including tax.",
        },
        {
            role: "user",
            content: [
                `Store: "${store.name}"`,
                `Description: ${store.description}`,
                "",
                "Rules:",
                "- min and max in USD for one sales unit (the whole pack if a pack is given)",
                "- a realistic range for this product, not for the whole category",
                "- max at most 3 times min",
                "- keep the index of each product",
                "",
                "Products:",
                ...lines,
                "",
                'Return JSON: {"prices":[{"index":1,"min":4.5,"max":9}]}',
            ].join("\n"),
        },
    ];
}

/** A usable range: positive, ordered, rounded to cents */
export function normalizePriceRange(min: number, max: number): PriceRange | null {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    if (low <= 0) return null;
    return { min: Math.round(low * 100) / 100, max: Math.round(high * 100) / 100 };
}

function parseRanges(response: string, count: number): Map<number, PriceRange> {
    const json = response
        .replace(/```json?\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
    const parsed = PriceResponseSchema.parse(JSON.parse(json));
    const entries = parsed.prices
        .filter((p) => p.index >= 1 && p.index <= count)
        .map((p) => [p.index, normalizePriceRange(p.min, p.max)] as const)
        .filter((entry): entry is readonly [number, PriceRange] => entry[1] !== null);
    return new Map(entries);
}

/** Ask the AI for one batch; an empty map on failure (prices stay as they are) */
async function fetchBatchRanges(
    textProvider: TextProvider,
    products: BlueprintProduct[],
    categories: Map<string, BlueprintCategory>,
    store: StoreContext
): Promise<Map<string, PriceRange>> {
    const lines = products.map((p, i) => describeProduct(p, i + 1, categories));
    try {
        const response = await executeWithRetry(() =>
            textProvider.generateCompletion(
                buildMessages(lines, store),
                PriceResponseSchema,
                "PriceRanges"
            )
        );
        const byIndex = parseRanges(response, products.length);
        return new Map(
            products.flatMap((p, i) => {
                const range = byIndex.get(i + 1);
                return range ? [[p.id, range] as const] : [];
            })
        );
    } catch (error) {
        logger.warn("Price range request failed, keeping the current prices", {
            cli: true,
            data: { error: error instanceof Error ? error.message : String(error) },
        });
        return new Map();
    }
}

/**
 * Round to a shop price: x.99 below 100, steps of 5 below 1000, steps of 10 above
 * (e.g. 7.99, 149.99, 1249.99).
 */
export function toShopPrice(value: number): number {
    const step = value < 100 ? 1 : value < 1000 ? 5 : 10;
    const rounded = Math.max(step, Math.round(value / step) * step);
    return Math.round((rounded - 0.01) * 100) / 100;
}

/** Deterministic price inside the range (log-uniform, seeded by the product ID) */
export function rollPrice(productId: string, range: PriceRange): number {
    const random = createSeededRandom(`price:${productId}`);
    const logMin = Math.log(range.min);
    const logMax = Math.log(range.max);
    return toShopPrice(Math.exp(logMin + random() * (logMax - logMin)));
}

function chunk<T>(items: T[], size: number): T[][] {
    return Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
        items.slice(i * size, (i + 1) * size)
    );
}

/** Result of a price pass */
export interface PriceHydrationResult {
    products: BlueprintProduct[];
    /** Products that got a new price */
    priced: number;
}

/**
 * Give every product a realistic price. One AI call per PRICE_BATCH_SIZE products.
 */
export async function hydratePrices(
    textProvider: TextProvider,
    blueprint: Pick<HydratedBlueprint, "categories" | "products">,
    store: StoreContext
): Promise<PriceHydrationResult> {
    const categories = new Map(flattenCategories(blueprint.categories).map((c) => [c.id, c]));
    logger.info(`  Pricing ${blueprint.products.length} products...`, { cli: true });

    const ranges = new Map<string, PriceRange>();
    for (const batch of chunk(blueprint.products, PRICE_BATCH_SIZE)) {
        const batchRanges = await fetchBatchRanges(textProvider, batch, categories, store);
        for (const [id, range] of batchRanges) ranges.set(id, range);
    }

    const products = blueprint.products.map((product) => {
        const range = ranges.get(product.id);
        return range ? { ...product, price: rollPrice(product.id, range) } : product;
    });
    return { products, priced: ranges.size };
}
