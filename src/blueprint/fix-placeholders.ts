/**
 * Fix Placeholders - Repair incomplete hydration by sending placeholder names to AI
 */

import { z } from "zod";

import type {
    BlueprintCategory,
    BlueprintProduct,
    HydratedBlueprint,
    TextProvider,
} from "../types/index.js";

import { ConcurrencyLimiter, executeWithRetry, logger } from "../utils/index.js";
import { flattenCategories } from "./hydrators/category.js";

const PLACEHOLDER_PATTERNS = [
    /^Top Category \d+$/,
    /^Category L\d+-\d+$/,
    /^Product \d+$/,
    /^(First |Second |Third |Fourth |Fifth )?Top Level Category$/,
    /^Subcategory [A-Z]$/,
];

function isPlaceholder(name: string): boolean {
    return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Find all categories with placeholder names
 */
export function findPlaceholderCategories(categories: BlueprintCategory[]): BlueprintCategory[] {
    const placeholders: BlueprintCategory[] = [];

    const traverse = (cats: BlueprintCategory[]) => {
        for (const cat of cats) {
            if (isPlaceholder(cat.name)) {
                placeholders.push(cat);
            }
            if (cat.children.length > 0) {
                traverse(cat.children);
            }
        }
    };

    traverse(categories);
    return placeholders;
}

/**
 * Find all products with placeholder names
 */
export function findPlaceholderProducts(products: BlueprintProduct[]): BlueprintProduct[] {
    return products.filter((p) => isPlaceholder(p.name));
}

/**
 * Fix placeholder categories by sending them to AI
 */
export async function fixPlaceholderCategories(
    textProvider: TextProvider,
    blueprint: HydratedBlueprint,
    placeholderCategories: BlueprintCategory[]
): Promise<BlueprintCategory[]> {
    if (placeholderCategories.length === 0) {
        return blueprint.categories;
    }

    logger.info(`Fixing ${placeholderCategories.length} placeholder categories...`);

    const uniqueCategories = Array.from(
        new Map(placeholderCategories.map((c) => [c.id, c])).values()
    );

    const FixCategorySchema = z.object({
        categories: z.array(
            z.object({
                id: z.string(),
                name: z.string(),
                description: z.string().optional().default(""),
            })
        ),
    });

    const prompt = `Generate category names for this webshop.

Store: "${blueprint.salesChannel.name}"
Description: ${blueprint.salesChannel.description}

Fix these ${uniqueCategories.length} categories with placeholder names:
${uniqueCategories.map((c) => `- ID: "${c.id}" (current: "${c.name}")`).join("\n")}

Requirements:
- Names should be realistic subcategories appropriate for this store type
- Names like "Category L2-1" should become top-level categories relevant to the store
- Names like "Category L3-1" should become specific product types
- Each name should be unique and descriptive

RESPOND ONLY WITH JSON. No explanation, no markdown. Just the JSON object:`;

    try {
        const responseText = await executeWithRetry(() =>
            textProvider.generateCompletion(
                [
                    {
                        role: "system",
                        content:
                            "You are a JSON generator. You ONLY output valid JSON, never any other text or explanation.",
                    },
                    { role: "user", content: prompt },
                ],
                FixCategorySchema
            )
        );

        let jsonStr = responseText.trim();
        if (jsonStr.startsWith("```")) {
            const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (match) {
                jsonStr = match[1]?.trim() || jsonStr;
            }
        }

        const parsed = JSON.parse(jsonStr);
        const validated = FixCategorySchema.parse(parsed);

        logger.info(`Fixed ${validated.categories.length} categories`);

        const fixMap = new Map(validated.categories.map((c) => [c.id, c]));

        const applyFixes = (cats: BlueprintCategory[]): BlueprintCategory[] => {
            return cats.map((cat) => {
                const fix = fixMap.get(cat.id);
                return {
                    ...cat,
                    name: fix?.name ?? cat.name,
                    description: fix?.description ?? cat.description,
                    children: applyFixes(cat.children),
                };
            });
        };

        return applyFixes(blueprint.categories);
    } catch (error) {
        logger.error("Failed to fix placeholder categories", { data: error });
        throw error;
    }
}

/**
 * Fix placeholder products by sending them to AI in batches
 */
export async function fixPlaceholderProducts(
    textProvider: TextProvider,
    blueprint: HydratedBlueprint,
    placeholderProducts: BlueprintProduct[]
): Promise<BlueprintProduct[]> {
    if (placeholderProducts.length === 0) {
        return blueprint.products;
    }

    logger.info(`Fixing ${placeholderProducts.length} placeholder products...`);

    const categoryMap = new Map<string, BlueprintCategory>();
    const flatCats = flattenCategories(blueprint.categories);
    for (const cat of flatCats) {
        categoryMap.set(cat.id, cat);
    }

    const SimpleProductSchema = z.object({
        products: z.array(
            z.object({
                id: z.string(),
                name: z.string(),
                description: z.string().optional().default(""),
            })
        ),
    });

    const BATCH_SIZE = 10;
    const batches: BlueprintProduct[][] = [];
    for (let i = 0; i < placeholderProducts.length; i += BATCH_SIZE) {
        batches.push(placeholderProducts.slice(i, i + BATCH_SIZE));
    }

    const maxConcurrency = textProvider.isSequential ? 1 : textProvider.maxConcurrency;
    const limiter = new ConcurrencyLimiter(maxConcurrency);
    const totalBatches = batches.length;

    logger.info(
        `Processing ${totalBatches} batches with concurrency: ${maxConcurrency} (provider: ${textProvider.name})`
    );

    const processBatch = async (
        batch: BlueprintProduct[],
        batchIdx: number
    ): Promise<Array<{ id: string; name: string; description: string }>> => {
        logger.info(
            `Fixing product batch ${batchIdx + 1}/${totalBatches} (${batch.length} products)...`
        );

        const prompt = `Generate product names for this webshop.

Store: "${blueprint.salesChannel.name}"
Description: ${blueprint.salesChannel.description}

Fix these ${batch.length} products with placeholder names:
${batch
    .map((p) => {
        const catNames = p.categoryIds
            .map((id) => categoryMap.get(id)?.name)
            .filter(Boolean)
            .join(", ");
        return `- ID: "${p.id}" (current: "${p.name}", categories: ${catNames || "unknown"})`;
    })
    .join("\n")}

Requirements:
- Name pattern: "[Product Type] - [Property1] - [Property2]"
- Names should be appropriate for the store type and categories
- Description: 1-2 sentences about the product

RESPOND ONLY WITH JSON:
{"products": [{"id": "...", "name": "...", "description": "..."}]}`;

        try {
            const responseText = await executeWithRetry(() =>
                textProvider.generateCompletion(
                    [
                        {
                            role: "system",
                            content:
                                "You are a JSON generator. Output ONLY valid JSON, no other text.",
                        },
                        { role: "user", content: prompt },
                    ],
                    SimpleProductSchema
                )
            );

            let jsonStr = responseText.trim();
            if (jsonStr.startsWith("```")) {
                const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (match) {
                    jsonStr = match[1]?.trim() || jsonStr;
                }
            }

            const parsed = JSON.parse(jsonStr);
            const validated = SimpleProductSchema.parse(parsed);
            logger.info(`  Batch ${batchIdx + 1}: Fixed ${validated.products.length} products`);
            return validated.products;
        } catch (error) {
            logger.error(`Failed to fix product batch ${batchIdx + 1}`, { data: error });
            return [];
        }
    };

    const batchTasks = batches.map((batch, batchIdx) =>
        limiter.schedule(() => processBatch(batch, batchIdx))
    );

    const batchResults = await Promise.all(batchTasks);
    type FixedProduct = { id: string; name: string; description: string };
    const allFixedProducts: FixedProduct[] = batchResults.flat();

    logger.info(`Fixed ${allFixedProducts.length} products total`);

    const fixMap = new Map<string, FixedProduct>(
        allFixedProducts.map((p: FixedProduct) => [p.id, p])
    );

    return blueprint.products.map((product) => {
        const fix = fixMap.get(product.id);
        if (!fix) return product;

        return {
            ...product,
            name: fix.name,
            description: fix.description || product.description,
        };
    });
}

/**
 * Fix all placeholders in a hydrated blueprint
 */
export async function fixPlaceholders(
    textProvider: TextProvider,
    blueprint: HydratedBlueprint
): Promise<HydratedBlueprint> {
    const placeholderCats = findPlaceholderCategories(blueprint.categories);
    const placeholderProds = findPlaceholderProducts(blueprint.products);

    logger.info(
        `Found ${placeholderCats.length} placeholder categories and ${placeholderProds.length} placeholder products`
    );

    if (placeholderCats.length === 0 && placeholderProds.length === 0) {
        logger.info("No placeholders to fix");
        return blueprint;
    }

    let fixedCategories = blueprint.categories;
    let fixedProducts = blueprint.products;

    if (placeholderCats.length > 0) {
        fixedCategories = await fixPlaceholderCategories(textProvider, blueprint, placeholderCats);
    }

    if (placeholderProds.length > 0) {
        fixedProducts = await fixPlaceholderProducts(
            textProvider,
            { ...blueprint, categories: fixedCategories },
            placeholderProds
        );
    }

    return {
        ...blueprint,
        categories: fixedCategories,
        products: fixedProducts,
        hydratedAt: new Date().toISOString(),
    };
}
