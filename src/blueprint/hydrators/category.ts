/**
 * Category Hydrator - Fills category placeholders with AI-generated names and descriptions
 */

import { z } from "zod";

import type { BlueprintCategory, TextProvider } from "../../types/index.js";

import { executeWithRetry, logger } from "../../utils/index.js";

const CategoryResponseSchema = z.object({
    salesChannelDescription: z.string(),
    categories: z.array(
        z.object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            imageDescription: z.string().nullable(),
        })
    ),
});

type CategoryResponse = z.infer<typeof CategoryResponseSchema>;

export interface CategoryHydrationResult {
    salesChannelDescription: string;
    categories: CategoryResponse["categories"];
}

/**
 * Hydrate SalesChannel and categories with AI
 */
export async function hydrateCategories(
    textProvider: TextProvider,
    salesChannelName: string,
    salesChannelDescription: string,
    categories: BlueprintCategory[]
): Promise<CategoryHydrationResult> {
    const flatCategories = flattenCategories(categories);

    logger.debug(`Generating content for ${flatCategories.length} categories`, {
        data: { salesChannelName },
    });

    const prompt = buildCategoryPrompt(salesChannelName, salesChannelDescription, flatCategories);
    logger.debug("Category prompt built", { data: { promptLength: prompt.length } });

    const startTime = Date.now();
    let response: string;

    try {
        response = await executeWithRetry(async () => {
            logger.debug(`[AI Provider: ${textProvider.name}] Generating categories...`);
            return textProvider.generateCompletion(
                [
                    {
                        role: "system",
                        content:
                            "You are a professional e-commerce copywriter. Generate realistic, SEO-friendly content for an online store.",
                    },
                    { role: "user", content: prompt },
                ],
                CategoryResponseSchema,
                "CategoryResponse"
            );
        });
    } catch (error) {
        const elapsed = Date.now() - startTime;
        logger.error(`[AI Provider] Category generation failed after ${elapsed}ms`, {
            data: {
                provider: textProvider.name,
                error: error instanceof Error ? error.message : String(error),
            },
        });
        throw error;
    }

    const elapsed = Date.now() - startTime;
    logger.info(`[AI Provider: ${textProvider.name}] Categories generated in ${elapsed}ms`, {
        data: { responseLength: response.length },
    });

    try {
        const parsed = JSON.parse(response) as CategoryResponse;
        const validated = CategoryResponseSchema.parse(parsed);
        logger.debug(`Parsed ${validated.categories.length} categories from response`);
        return validated;
    } catch (error) {
        logger.error("Failed to parse category AI response", {
            data: {
                error: error instanceof Error ? error.message : String(error),
                responsePreview: response.slice(0, 500),
            },
        });
        throw new Error("Failed to parse category AI response");
    }
}

/**
 * Apply category hydration to the original category tree
 */
export function applyCategoryHydration(
    original: BlueprintCategory[],
    hydrated: CategoryHydrationResult["categories"]
): BlueprintCategory[] {
    const hydratedMap = new Map(hydrated.map((c) => [c.id, c]));

    const applyToTree = (cats: BlueprintCategory[]): BlueprintCategory[] => {
        return cats.map((cat) => {
            const h = hydratedMap.get(cat.id);
            return {
                ...cat,
                name: h?.name || cat.name,
                description: h?.description || cat.description,
                imageDescription: h?.imageDescription ?? undefined,
                children: applyToTree(cat.children),
            };
        });
    };

    return applyToTree(original);
}

/**
 * Flatten category tree into a flat array
 */
export function flattenCategories(categories: BlueprintCategory[]): BlueprintCategory[] {
    const result: BlueprintCategory[] = [];

    const traverse = (cats: BlueprintCategory[]) => {
        for (const cat of cats) {
            result.push(cat);
            if (cat.children.length > 0) {
                traverse(cat.children);
            }
        }
    };

    traverse(categories);
    return result;
}

function buildCategoryPrompt(
    salesChannelName: string,
    salesChannelDescription: string,
    categories: BlueprintCategory[]
): string {
    const categoryList = categories.map((c) => ({
        id: c.id,
        level: c.level,
        hasImage: c.hasImage,
        parentId: c.parentId,
    }));

    return `Generate content for an e-commerce store called "${salesChannelName}".
Store context: ${salesChannelDescription}

Create realistic content for the following structure:

1. A compelling store description (2-3 sentences)
2. Category names and descriptions for each category

Categories to fill (${categories.length} total):
${JSON.stringify(categoryList, null, 2)}

For each category:
- Generate a realistic category name that fits the store theme
- Write an SEO-friendly description (1-2 sentences)
- If hasImage is true, provide an imageDescription for banner generation

Return JSON in this exact format:
{
  "salesChannelDescription": "Store description here",
  "categories": [
    { "id": "...", "name": "...", "description": "...", "imageDescription": "..." }
  ]
}`;
}
