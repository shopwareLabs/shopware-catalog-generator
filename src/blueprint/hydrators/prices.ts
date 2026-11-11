/**
 * Price hydrator - realistic prices per product via one small AI call
 *
 * The blueprint generator only knows placeholders, so it rolls a uniform random price.
 * After hydration the product names are known: the AI returns the typical retail price
 * range for each product (with its category and pack size), and the price is rolled
 * inside that range. The roll is seeded by the product ID, so the same range always
 * gives the same price. Products the AI skips keep their price.
 *
 * The blueprint generator also hands out pack units at random ("Roll of 5 m" on a
 * T-shirt). The same call checks them: the AI keeps the pack, picks a fitting one from
 * PACKAGING_OPTIONS, or drops it. Products without a pack never get one.
 */

import { z } from "zod";

import type {
    BlueprintCategory,
    BlueprintProduct,
    HydratedBlueprint,
    ProductPackaging,
    TextProvider,
} from "../../types/index.js";
import type { StoreContext } from "./product.js";

import { findPackagingUnit, PACKAGING_OPTIONS } from "../../fixtures/index.js";
import { createSeededRandom, executeWithRetry, logger } from "../../utils/index.js";
import { flattenCategories } from "./category.js";

/** Products per AI call */
export const PRICE_BATCH_SIZE = 100;

const PriceRangeSchema = z.object({
    index: z.number().int(),
    min: z.number(),
    max: z.number(),
    /** Required by structured outputs; null for products without a pack */
    pack: z.string().nullable(),
});

/** Answer for a pack that does not fit the product */
const NO_PACK = "none";

const PriceResponseSchema = z.object({
    prices: z.array(PriceRangeSchema),
});

/** Providers without structured outputs may leave pack out */
const PriceAnswerSchema = z.object({
    prices: z.array(PriceRangeSchema.extend({ pack: z.string().nullish() })),
});

/** Typical retail price range of one product */
export interface PriceRange {
    min: number;
    max: number;
}

/** AI answer for one product: its price range and, for products with a pack, the pack */
interface PriceAnswer {
    range: PriceRange;
    /** Pack label from PACKAGING_OPTIONS, NO_PACK, or undefined (keep the pack) */
    pack?: string;
}

/** "Roll (5 Meter)" */
function describePack(pack: { packUnit: string; purchaseUnit: number; unitName: string }) {
    return `${pack.packUnit} (${pack.purchaseUnit} ${pack.unitName})`;
}

const PACK_CHOICES = PACKAGING_OPTIONS.map((o) =>
    describePack({ ...o, unitName: findPackagingUnit(o.unitShortCode)?.name ?? o.unitShortCode })
);

/** Packaging for a pack answer: unchanged, another option, or none */
export function resolvePackaging(
    current: ProductPackaging | undefined,
    answer: string | undefined
): ProductPackaging | undefined {
    if (!current || answer === undefined) return current;
    const label = answer.trim().toLowerCase();
    if (label === NO_PACK) return undefined;
    const option = PACKAGING_OPTIONS.find((o) => label.startsWith(o.packUnit.toLowerCase()));
    if (!option) return current;
    const unit = findPackagingUnit(option.unitShortCode);
    return { ...option, unitName: unit?.name ?? option.unitShortCode };
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
        pack ? `pack: ${describePack(pack)}` : "",
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
                "- for a product with a pack: return pack, the pack it is really sold in.",
                `  One of: ${PACK_CHOICES.join(", ")}, or "${NO_PACK}" when it is sold`,
                "  one by one. Price the pack you return",
                "- pack is null for a product without a pack",
                "",
                "Products:",
                ...lines,
                "",
                'Return JSON: {"prices":[{"index":1,"min":4.5,"max":9,"pack":null},{"index":2,"min":12,"max":20,"pack":"Pair"}]}',
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

function parseAnswers(response: string, count: number): Map<number, PriceAnswer> {
    const json = response
        .replace(/```json?\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
    const parsed = PriceAnswerSchema.parse(JSON.parse(json));
    return new Map(
        parsed.prices
            .filter((p) => p.index >= 1 && p.index <= count)
            .flatMap((p) => {
                const range = normalizePriceRange(p.min, p.max);
                return range ? [[p.index, { range, pack: p.pack ?? undefined }] as const] : [];
            })
    );
}

/** Ask the AI for one batch; an empty map on failure (prices stay as they are) */
async function fetchBatchAnswers(
    textProvider: TextProvider,
    products: BlueprintProduct[],
    categories: Map<string, BlueprintCategory>,
    store: StoreContext
): Promise<Map<string, PriceAnswer>> {
    const lines = products.map((p, i) => describeProduct(p, i + 1, categories));
    try {
        const response = await executeWithRetry(() =>
            textProvider.generateCompletion(
                buildMessages(lines, store),
                PriceResponseSchema,
                "PriceRanges"
            )
        );
        const byIndex = parseAnswers(response, products.length);
        return new Map(
            products.flatMap((p, i) => {
                const answer = byIndex.get(i + 1);
                return answer ? [[p.id, answer] as const] : [];
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
    /** Products whose pack changed or was dropped */
    repacked: number;
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

    const answers = new Map<string, PriceAnswer>();
    for (const batch of chunk(blueprint.products, PRICE_BATCH_SIZE)) {
        const batchAnswers = await fetchBatchAnswers(textProvider, batch, categories, store);
        for (const [id, answer] of batchAnswers) answers.set(id, answer);
    }

    const products = blueprint.products.map((product) => {
        const answer = answers.get(product.id);
        return answer ? applyAnswer(product, answer) : product;
    });
    const repacked = products.filter(
        (p, i) =>
            p.metadata.packaging?.packUnit !== blueprint.products[i]?.metadata.packaging?.packUnit
    ).length;
    return { products, priced: answers.size, repacked };
}

function applyAnswer(product: BlueprintProduct, answer: PriceAnswer): BlueprintProduct {
    const price = rollPrice(product.id, answer.range);
    const packaging = resolvePackaging(product.metadata.packaging, answer.pack);
    if (packaging === product.metadata.packaging) return { ...product, price };
    return { ...product, price, metadata: { ...product.metadata, packaging } };
}
