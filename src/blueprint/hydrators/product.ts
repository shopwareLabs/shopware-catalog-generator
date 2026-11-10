/**
 * Product Hydrator - Fills product placeholders with AI-generated content
 *
 * Handles product names, descriptions, properties, image prompts, and manufacturer assignment.
 * Uses parallel processing when the provider supports concurrency.
 */

import { z } from "zod";

import type { InspirationData } from "../../crawlers/types.js";
import type {
    BlueprintCategory,
    BlueprintProduct,
    ImageDescription,
    ProductProperty,
    TextProvider,
    VariantConfig,
    VariantSettings,
} from "../../types/index.js";
import type { ExistingProperty } from "../../utils/index.js";
import type { VariantResolver } from "../variant-resolver.js";

import { PropertyCache } from "../../property-cache.js";
import { DEFAULT_VARIANT_SETTINGS } from "../../types/index.js";
import {
    ConcurrencyLimiter,
    deriveProductSeoMeta,
    executeWithRetry,
    logger,
} from "../../utils/index.js";

// =============================================================================
// Zod Schemas for AI Response Validation
// =============================================================================

const ProductResponseSchema = z.object({
    products: z.array(
        z.object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            properties: z.array(
                z.object({
                    group: z.string(),
                    value: z.string(),
                })
            ),
            manufacturerName: z.string(),
            imageDescriptions: z.array(
                z.object({
                    view: z.enum(["front", "side", "detail", "lifestyle", "packaging"]),
                    prompt: z.string(),
                })
            ),
            suggestedVariantGroups: z.array(z.string()).nullable(),
            variantColors: z.array(z.string()).nullable(),
            assignedCategories: z.array(z.string()).nullable(),
        })
    ),
});

const PropertyOnlyResponseSchema = z.object({
    products: z.array(
        z.object({
            id: z.string(),
            properties: z.array(
                z.object({
                    group: z.string(),
                    value: z.string(),
                })
            ),
            suggestedVariantGroups: z.array(z.string()).nullable(),
            variantColors: z.array(z.string()).nullable(),
        })
    ),
});

const VariantColorsResponseSchema = z.object({
    products: z.array(
        z.object({
            id: z.string(),
            variantColors: z.array(z.string()),
        })
    ),
});

type ProductResponse = z.infer<typeof ProductResponseSchema>;
type PropertyOnlyResponse = z.infer<typeof PropertyOnlyResponseSchema>;

/** New properties (and variant suggestions) for one product in properties-only mode */
export type PropertyUpdate = PropertyOnlyResponse["products"][number];

// =============================================================================
// Token Estimation
// =============================================================================

const CHARS_PER_TOKEN: Record<string, number> = {
    openai: 4.0,
    pollinations: 3.5,
    default: 3.5,
};

const JSON_OVERHEAD_MULTIPLIER = 1.15;

function estimateTokens(payload: unknown, providerName?: string): number {
    const json = JSON.stringify(payload);
    const defaultCharsPerToken = CHARS_PER_TOKEN.default ?? 3.5;
    const charsPerToken = providerName
        ? (CHARS_PER_TOKEN[providerName.toLowerCase()] ?? defaultCharsPerToken)
        : defaultCharsPerToken;
    return Math.ceil((json.length / charsPerToken) * JSON_OVERHEAD_MULTIPLIER);
}

function fitsInTokenLimit(payload: unknown, tokenLimit: number, providerName?: string): boolean {
    const estimated = estimateTokens(payload, providerName);
    return estimated < tokenLimit * 0.7;
}

// =============================================================================
// Types
// =============================================================================

/** Prompt rules for the "Color" group (the colour system derives families from it) */
const COLOR_PROPERTY_RULES = `- "Color" is the only predefined property group - use it when color is relevant for the product
- Color values: one specific shade name a shopper of THIS store would recognise (e.g. "Navy", "Dusty Rose", "Natural Oak"), not vague values like "3 colors" or "Various"
- Reuse the existing Color values listed above when one fits; for a pattern or several colours use "Multicolor"
- Never create a "Color family" group: families are added automatically`;

/** True for the "Color" group name (any case) */
function isColorGroupName(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return normalized === "color" || normalized === "colour";
}

/**
 * Preferred colours for a colour variant product: its own Color value first (the colour of
 * the main image), then the colours the AI chose.
 */
export function productColorPreferences(
    properties: ReadonlyArray<{ group: string; value: string }>,
    variantColors: readonly string[] | null | undefined
): string[] {
    const own = properties.find((p) => isColorGroupName(p.group))?.value;
    return [...(own ? [own] : []), ...(variantColors ?? [])];
}

/** Product whose colour variants are filled by hydrateVariantColors() */
export interface VariantColorRequest {
    id: string;
    name: string;
    /** The product's own colour (first colour variant) */
    color?: string;
}

/** Products per AI call when only colours are requested */
export const VARIANT_COLOR_BATCH_SIZE = 25;

export interface StoreContext {
    name: string;
    description: string;
}

interface HydratedCategory {
    id: string;
    name: string;
}

type GenerateBaseImagePromptFn = (
    productName: string,
    properties: Array<{ group: string; value: string }>
) => string;

// =============================================================================
// Product Hydrator Class
// =============================================================================

/** Maximum products per API call to avoid timeouts */
const MAX_BATCH_SIZE = 10;

export class ProductHydrator {
    private readonly batchCounter: Map<string, { current: number; total: number }> = new Map();

    constructor(
        private readonly textProvider: TextProvider,
        private readonly propertyCache: PropertyCache,
        private readonly variantResolver: VariantResolver,
        private readonly generateBaseImagePrompt: GenerateBaseImagePromptFn,
        private readonly inspiration?: InspirationData,
        private readonly variantSettings: VariantSettings = DEFAULT_VARIANT_SETTINGS
    ) {}

    /** Prompt rule for the colour variants of variant products */
    private variantColorRule(step: string): string {
        const count = this.variantSettings.colors;
        return `${step} For products with isVariant: true whose "suggestedVariantGroups" include "Color", return EXACTLY ${count} shade names in "variantColors"
   - The FIRST entry is the product's own Color property value
   - The others are realistic alternative shades this product is sold in, all different
   - Use null for all other products`;
    }

    /**
     * Hydrate products with AI, one task per top-level category branch.
     * Uses parallel processing when the provider supports concurrency. Failed branches are
     * dropped (with a warning) unless every branch failed.
     */
    async hydrateProducts(
        products: BlueprintProduct[],
        hydratedCategories: HydratedCategory[],
        categoryTree: BlueprintCategory[],
        existingProperties: ExistingProperty[],
        storeContext: StoreContext
    ): Promise<BlueprintProduct[]> {
        const categoryNameMap = new Map(hydratedCategories.map((c) => [c.id, c.name]));
        const context: BranchContext = {
            existingProperties,
            categoryNameMap,
            categoryIdByName: new Map(hydratedCategories.map((c) => [c.name.toLowerCase(), c.id])),
            storeContext,
        };
        const subcategories = this.buildBranchSubcategoryMap(categoryTree, categoryNameMap);
        const branches = [...groupProductsByBranch(products)].map(
            ([branchId, branchProducts], index): ProductBranch => ({
                products: branchProducts,
                name: categoryNameMap.get(branchId) || `Branch ${index + 1}`,
                subcategories: subcategories.get(branchId) || [],
            })
        );
        this.logBranchProcessingMode(branches.length);

        const limiter = new ConcurrencyLimiter(this.textProvider.maxConcurrency);
        const progress = { completed: 0, total: branches.length };
        const settled = await Promise.allSettled(
            branches.map((branch, index) =>
                limiter.schedule(() => this.hydrateBranch(branch, index, progress, context))
            )
        );
        return collectBranchResults(settled, branches, storeContext.name);
    }

    private logBranchProcessingMode(totalBranches: number): void {
        const maxConcurrency = this.textProvider.maxConcurrency;
        if (maxConcurrency > 1) {
            logger.info(
                `    Using parallel processing (max ${maxConcurrency} concurrent branches)`,
                { cli: true }
            );
            logger.info(`Parallel branch processing enabled`, {
                data: { maxConcurrency, totalBranches },
            });
            return;
        }
        logger.info(`    Using sequential processing (provider: ${this.textProvider.name})`, {
            cli: true,
        });
        logger.info(`Sequential branch processing`, {
            data: { provider: this.textProvider.name },
        });
    }

    private async hydrateBranch(
        branch: ProductBranch,
        index: number,
        progress: { completed: number; total: number },
        context: BranchContext
    ): Promise<BlueprintProduct[]> {
        const store = context.storeContext.name;
        logger.info(
            `    [Branch ${index + 1}/${progress.total}] ${store} > ${branch.name}${formatSubcategoryPreview(branch.subcategories)} (${branch.products.length} products)`,
            { cli: true }
        );

        const hydrated = await this.hydrateBranchProducts(
            branch.products,
            branch.name,
            context.existingProperties,
            context.categoryNameMap,
            context.categoryIdByName,
            branch.subcategories,
            context.storeContext
        );

        progress.completed++;
        logger.info(
            `    ✓ ${store} > ${branch.name} complete (${progress.completed}/${progress.total} branches)`,
            { cli: true }
        );
        return hydrated;
    }

    /**
     * Hydrate properties for a branch of products (properties-only mode)
     */
    async hydratePropertiesForBranch(
        products: BlueprintProduct[],
        branchName: string,
        existingProperties: ExistingProperty[],
        storeContext: StoreContext
    ): Promise<Map<string, PropertyUpdate>> {
        const prompt = this.buildPropertyOnlyPrompt(
            products,
            branchName,
            existingProperties,
            storeContext
        );

        const responseText = await executeWithRetry(() =>
            this.textProvider.generateCompletion(
                [
                    {
                        role: "system",
                        content:
                            "You are a product property generator. Generate properties for existing products based on their names. Output ONLY valid JSON.",
                    },
                    { role: "user", content: prompt },
                ],
                PropertyOnlyResponseSchema,
                "PropertyOnlyResponse"
            )
        );

        const validated = PropertyOnlyResponseSchema.parse(parseJsonResponse(responseText));

        return new Map(validated.products.map((p) => [p.id, p]));
    }

    /**
     * Ask the AI for exactly `variantSettings.colors` shades per product (own colour first).
     * Used by `hydrate --only=variants` for products that need more colours than they have.
     * Returns product ID → colours; products the AI skipped are missing.
     */
    async hydrateVariantColors(
        products: VariantColorRequest[],
        storeContext: StoreContext
    ): Promise<Map<string, string[]>> {
        const batches = Array.from(
            { length: Math.ceil(products.length / VARIANT_COLOR_BATCH_SIZE) },
            (_, i) =>
                products.slice(i * VARIANT_COLOR_BATCH_SIZE, (i + 1) * VARIANT_COLOR_BATCH_SIZE)
        );
        const limiter = new ConcurrencyLimiter(this.textProvider.maxConcurrency);
        const results = await limiter.all(
            batches.map((batch) => () => this.hydrateVariantColorBatch(batch, storeContext))
        );
        return new Map(results.flatMap((result) => [...result]));
    }

    private async hydrateVariantColorBatch(
        products: VariantColorRequest[],
        storeContext: StoreContext
    ): Promise<Map<string, string[]>> {
        const count = this.variantSettings.colors;
        const prompt = `Choose the colour variants for products of this store.

STORE CONTEXT:
- Store name: "${storeContext.name}"
- Store description: "${storeContext.description}"

Products (${products.length} total):
${JSON.stringify(products, null, 2)}

For each product return EXACTLY ${count} shade names in "variantColors":
- The FIRST entry is the product's own "color" (keep it exactly when it is given)
- The others are realistic alternative shades this product is sold in, all different
- Shade names a shopper of THIS store would recognise (e.g. "Navy", "Dusty Rose"), not "Various"

Return JSON: { "products": [{ "id": "...", "variantColors": ["...", "..."] }] }`;

        const responseText = await executeWithRetry(() =>
            this.textProvider.generateCompletion(
                [
                    {
                        role: "system",
                        content: "You are a JSON generator. Output ONLY valid JSON.",
                    },
                    { role: "user", content: prompt },
                ],
                VariantColorsResponseSchema,
                "VariantColorsResponse"
            )
        );

        const validated = VariantColorsResponseSchema.parse(parseJsonResponse(responseText));
        return new Map(validated.products.map((p) => [p.id, p.variantColors]));
    }

    /** Clear batch progress state (call before starting hydration) */
    clearBatchCounter(): void {
        this.batchCounter.clear();
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private buildBranchSubcategoryMap(
        categoryTree: BlueprintCategory[],
        categoryNameMap: Map<string, string>
    ): Map<string, string[]> {
        const result = new Map<string, string[]>();

        const collectDescendantNames = (category: BlueprintCategory): string[] => {
            const names: string[] = [];
            for (const child of category.children || []) {
                const childName = categoryNameMap.get(child.id);
                if (childName) {
                    names.push(childName);
                }
                names.push(...collectDescendantNames(child));
            }
            return names;
        };

        for (const branch of categoryTree) {
            const subcatNames = collectDescendantNames(branch);
            result.set(branch.id, subcatNames.sort());
        }

        return result;
    }

    private calculateManufacturerCount(productCount: number): number {
        return Math.max(2, Math.ceil(productCount / 15));
    }

    private generateManufacturerNames(branchName: string, count: number): string[] {
        const suffixes = ["Co.", "Inc.", "Designs", "Home", "Living", "Works", "Studio", "Craft"];
        const prefixes = [
            "Artisan",
            "Premium",
            "Modern",
            "Classic",
            "Urban",
            "Nordic",
            "Elite",
            "Signature",
        ];

        const names: string[] = [];
        for (let i = 0; i < count; i++) {
            const prefix = prefixes[i % prefixes.length];
            const suffix = suffixes[(i + branchName.length) % suffixes.length];
            names.push(`${prefix} ${suffix}`);
        }
        return names;
    }

    private shouldSplitBatch(products: BlueprintProduct[], branchName: string): boolean {
        if (products.length > MAX_BATCH_SIZE) return true;
        const payload = { products: products.map((p) => p.id), branchName };
        return !fitsInTokenLimit(payload, this.textProvider.tokenLimit, this.textProvider.name);
    }

    private async hydrateSplitBatch(
        products: BlueprintProduct[],
        branchName: string,
        existingProperties: ExistingProperty[],
        categoryNameMap: Map<string, string>,
        categoryIdByName: Map<string, string>,
        availableSubcategories: string[],
        storeContext: StoreContext,
        manufacturerNames: string[]
    ): Promise<BlueprintProduct[]> {
        const midpoint = Math.ceil(products.length / 2);
        const batch1 = products.slice(0, midpoint);
        const batch2 = products.slice(midpoint);

        if (this.textProvider.maxConcurrency > 1) {
            const [hydrated1, hydrated2] = await Promise.all([
                this.hydrateBranchProducts(
                    batch1,
                    branchName,
                    existingProperties,
                    categoryNameMap,
                    categoryIdByName,
                    availableSubcategories,
                    storeContext,
                    manufacturerNames
                ),
                this.hydrateBranchProducts(
                    batch2,
                    branchName,
                    existingProperties,
                    categoryNameMap,
                    categoryIdByName,
                    availableSubcategories,
                    storeContext,
                    manufacturerNames
                ),
            ]);
            return [...hydrated1, ...hydrated2];
        }

        const hydrated1 = await this.hydrateBranchProducts(
            batch1,
            branchName,
            existingProperties,
            categoryNameMap,
            categoryIdByName,
            availableSubcategories,
            storeContext,
            manufacturerNames
        );
        const hydrated2 = await this.hydrateBranchProducts(
            batch2,
            branchName,
            existingProperties,
            categoryNameMap,
            categoryIdByName,
            availableSubcategories,
            storeContext,
            manufacturerNames
        );
        return [...hydrated1, ...hydrated2];
    }

    private async hydrateSingleBatch(
        products: BlueprintProduct[],
        branchName: string,
        existingProperties: ExistingProperty[],
        categoryNameMap: Map<string, string>,
        categoryIdByName: Map<string, string>,
        availableSubcategories: string[],
        storeContext: StoreContext,
        manufacturerNames: string[]
    ): Promise<BlueprintProduct[]> {
        const counter = this.batchCounter.get(branchName);
        if (counter) {
            counter.current++;
            logger.info(
                `      [Batch ${counter.current}/${counter.total}] Generating ${products.length} products...`,
                { cli: true }
            );
        }

        const prompt = this.buildProductPrompt(
            products,
            branchName,
            existingProperties,
            availableSubcategories,
            storeContext,
            manufacturerNames
        );
        const subCatPreview = availableSubcategories.slice(0, 3).join(", ");
        logger.debug(
            `[AI Provider: ${this.textProvider.name}] ${storeContext.name} > ${branchName} (${subCatPreview}) - ${products.length} products`,
            {
                data: {
                    productIds: products.map((p) => p.id.slice(0, 8)),
                    promptLength: prompt.length,
                    availableSubcategories,
                },
            }
        );

        const startTime = Date.now();
        const response = await this.callProductApi(branchName, prompt, startTime);
        return this.parseProductResponse(
            response,
            products,
            branchName,
            categoryNameMap,
            categoryIdByName,
            startTime
        );
    }

    private async callProductApi(
        branchName: string,
        prompt: string,
        startTime: number
    ): Promise<string> {
        try {
            return await executeWithRetry(async () => {
                logger.debug(
                    `[AI Provider: ${this.textProvider.name}] Generating products for "${branchName}"...`,
                    { data: { promptLength: prompt.length } }
                );
                return this.textProvider.generateCompletion(
                    [
                        {
                            role: "system",
                            content:
                                "You are a professional e-commerce copywriter. Generate realistic product content with consistent naming patterns.",
                        },
                        { role: "user", content: prompt },
                    ],
                    ProductResponseSchema,
                    "ProductResponse"
                );
            });
        } catch (error) {
            const elapsed = Date.now() - startTime;
            logger.error(
                `[AI Provider] Product generation failed for "${branchName}" after ${elapsed}ms`,
                {
                    data: {
                        provider: this.textProvider.name,
                        error: error instanceof Error ? error.message : String(error),
                    },
                }
            );
            throw error;
        }
    }

    private async parseProductResponse(
        response: string,
        products: BlueprintProduct[],
        branchName: string,
        categoryNameMap: Map<string, string>,
        categoryIdByName: Map<string, string>,
        startTime: number
    ): Promise<BlueprintProduct[]> {
        const elapsed = Date.now() - startTime;
        const elapsedSec = (elapsed / 1000).toFixed(1);
        logger.info(
            `[AI Provider: ${this.textProvider.name}] Products generated for "${branchName}" in ${elapsed}ms`,
            { data: { responseLength: response.length } }
        );

        try {
            const parsed = JSON.parse(response) as ProductResponse;
            const validated = ProductResponseSchema.parse(parsed);
            logger.info(
                `        ✓ Generated ${validated.products.length} products (${elapsedSec}s)`,
                { cli: true }
            );
            logger.debug(`Parsed ${validated.products.length} products for "${branchName}"`);
            return await this.applyProductHydration(
                products,
                validated.products,
                categoryNameMap,
                categoryIdByName,
                branchName
            );
        } catch (error) {
            logger.error(`Failed to parse AI response for "${branchName}"`, {
                data: {
                    error: error instanceof Error ? error.message : String(error),
                    responsePreview: response.slice(0, 500),
                },
            });
            throw new Error(`Failed to parse product AI response for branch ${branchName}`);
        }
    }

    private async hydrateBranchProducts(
        products: BlueprintProduct[],
        branchName: string,
        existingProperties: ExistingProperty[],
        categoryNameMap: Map<string, string>,
        categoryIdByName: Map<string, string>,
        availableSubcategories: string[],
        storeContext: StoreContext,
        manufacturerNames?: string[]
    ): Promise<BlueprintProduct[]> {
        if (!manufacturerNames) {
            const manufacturerCount = this.calculateManufacturerCount(products.length);
            manufacturerNames = this.generateManufacturerNames(branchName, manufacturerCount);
            const totalBatches = Math.ceil(products.length / MAX_BATCH_SIZE);
            this.batchCounter.set(branchName, { current: 0, total: totalBatches });
        }

        if (this.shouldSplitBatch(products, branchName)) {
            return this.hydrateSplitBatch(
                products,
                branchName,
                existingProperties,
                categoryNameMap,
                categoryIdByName,
                availableSubcategories,
                storeContext,
                manufacturerNames
            );
        }

        return this.hydrateSingleBatch(
            products,
            branchName,
            existingProperties,
            categoryNameMap,
            categoryIdByName,
            availableSubcategories,
            storeContext,
            manufacturerNames
        );
    }

    private buildInspirationSection(branchName: string): string {
        if (!this.inspiration || this.inspiration.exampleProducts.length === 0) return "";

        // Match example products that belong to a category similar to this branch
        const branchLower = branchName.toLowerCase();
        const relevant = this.inspiration.exampleProducts.filter((p) => {
            if (!p.category) return true;
            return (
                p.category.toLowerCase().includes(branchLower) ||
                branchLower.includes(p.category.toLowerCase())
            );
        });

        const examples = (relevant.length > 0 ? relevant : this.inspiration.exampleProducts).slice(
            0,
            5
        );

        const lines = [
            ``,
            `INSPIRATION FROM REAL STORE (${this.inspiration.sourceUrl}):`,
            `Example products from the actual store that belong in this product area:`,
            ...examples.map((p) => {
                let line = `  - "${p.name}"`;
                if (p.description) line += `: ${p.description.slice(0, 120)}`;
                if (p.properties && Object.keys(p.properties).length > 0) {
                    const propStr = Object.entries(p.properties)
                        .slice(0, 4)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(", ");
                    line += ` [${propStr}]`;
                }
                return line;
            }),
            `→ Generate products that feel like they belong in the same store.`,
            `  Match the naming style, product range, and tone — but don't copy names.`,
        ];

        return lines.join("\n");
    }

    private buildProductPrompt(
        products: BlueprintProduct[],
        branchName: string,
        existingProperties: ExistingProperty[],
        availableSubcategories: string[],
        storeContext: StoreContext,
        manufacturerNames: string[]
    ): string {
        const productList = products.map((p) => ({
            id: p.id,
            imageCount: p.metadata.imageCount,
            imageViews: p.metadata.imageDescriptions.map((d) => d.view),
            isVariant: p.metadata.isVariant,
            variantGroups: p.metadata.variantConfigs?.map((c) => c.group) ?? [],
        }));

        const existingPropsText =
            existingProperties.length > 0
                ? `
Existing properties in Shopware (reuse when applicable):
${JSON.stringify(existingProperties, null, 2)}
`
                : "";

        const cachedGroups = this.propertyCache.listNames();
        const cachedGroupsText =
            cachedGroups.length > 0
                ? `\nALREADY KNOWN property groups for this store (prefer these): ${cachedGroups.join(", ")}`
                : "";

        const availableCategoriesText =
            availableSubcategories.length > 0
                ? `\nAVAILABLE SUBCATEGORIES for "${branchName}" (assign 1-2 that MATCH the product type):
${availableSubcategories.map((c) => `- "${c}"`).join("\n")}`
                : "";

        return `Generate product content for the "${branchName}" category.

STORE CONTEXT:
- Store name: "${storeContext.name}"
- Store description: "${storeContext.description}"
${this.buildInspirationSection(branchName)}
${existingPropsText}
${cachedGroupsText}
${availableCategoriesText}

CATEGORY ASSIGNMENT (CRITICAL):
- You MUST assign each product to 1-2 subcategories that MATCH the product type
- A "Guitar Strings" product should be in "Guitar Accessories" or "Guitar Strings", NOT in "Violins" or "Pianos"
- A "Piano Bench" should be in "Piano Accessories", NOT in "Guitar Accessories"
- Use the product name to determine the correct category
- Only use categories from the AVAILABLE SUBCATEGORIES list above

PROPERTY GUIDELINES:
${COLOR_PROPERTY_RULES}
- STRONGLY PREFER reusing the ALREADY KNOWN property groups listed above - use their EXACT names
- Only create NEW property groups if none of the existing ones fit
- Keep property groups BROAD and REUSABLE across multiple products:
  * Use "Size" not "Pot Size", "Fruit Size", "Bush Size" - just "Size"
  * Use "Material" not "Handle Material", "Blade Material" - just "Material"
  * Use "Type" not "Fruit Type", "Herb Type", "Leaf Type" - just "Type"
- Maximum 5-6 unique property groups per category (not per product!)
- Property values should be specific, but groups should be generic
- Do NOT use generic properties that don't fit the product (e.g., don't use "Material: Metal" for shampoo)

Products to fill (${products.length} total):
${JSON.stringify(productList, null, 2)}

IMPORTANT: You MUST use ONLY these manufacturer names (distribute evenly across products):
${manufacturerNames.map((n) => `- "${n}"`).join("\n")}

For each product:
1. Generate a name in format: "Product Type - Property1 - Property2"
   Example for furniture: "Dining Chair - Oak - High Back"
   Example for beauty: "Hydrating Cream - Rose Scent - 50ml"
2. Write a detailed description (200+ words, HTML formatted)
3. Generate 2-3 properties that are APPROPRIATE for this store type and product
4. Assign one of the manufacturer names listed above (distribute evenly!)
5. For each imageView, provide an AI image generation prompt
6. For products with isVariant: true, suggest 1-3 property group NAMES in "suggestedVariantGroups"
   - MUST use EXACT names from the ALREADY KNOWN groups when possible
   - Only suggest new group names if absolutely no existing group fits
   - Use BROAD group names: "Size" not "Pot Size", "Material" not "Handle Material"
   - Just group names, not the options (options come from cache or will be generated later)
${this.variantColorRule("6b.")}
7. ASSIGN 1-2 subcategories from the AVAILABLE SUBCATEGORIES list that MATCH the product type
   - Use "assignedCategories" field with EXACT category names from the list
   - Choose categories that logically fit the product (e.g., guitar products → guitar categories)

Return JSON in this exact format:
{
  "products": [
    {
      "id": "...",
      "name": "Product Name - Property1 - Property2",
      "description": "<p>Detailed HTML description...</p>",
      "properties": [{ "group": "PropertyGroup", "value": "Value" }, ...],
      "manufacturerName": "${manufacturerNames[0]}",
      "imageDescriptions": [
        { "view": "front", "prompt": "Product description for image generation" }
      ],
      "suggestedVariantGroups": ["PropertyGroup1", "PropertyGroup2"],
      "variantColors": null,
      "assignedCategories": ["Subcategory1", "Subcategory2"]
    }
  ]
}`;
    }

    private buildPropertyOnlyPrompt(
        products: BlueprintProduct[],
        branchName: string,
        existingProperties: ExistingProperty[],
        storeContext: StoreContext
    ): string {
        const productList = products.map((p) => ({
            id: p.id,
            name: p.name,
            isVariant: p.metadata.isVariant,
        }));

        const existingPropsText =
            existingProperties.length > 0
                ? `
Existing properties in Shopware (reuse when applicable):
${JSON.stringify(existingProperties, null, 2)}
`
                : "";

        const cachedGroups = this.propertyCache.listNames();
        const cachedGroupsText =
            cachedGroups.length > 0
                ? `\nALREADY KNOWN property groups (prefer these): ${cachedGroups.join(", ")}`
                : "";

        return `Generate properties for existing products in the "${branchName}" category.

STORE CONTEXT:
- Store name: "${storeContext.name}"
- Store description: "${storeContext.description}"

${existingPropsText}
${cachedGroupsText}

PROPERTY GUIDELINES:
${COLOR_PROPERTY_RULES}
- STRONGLY PREFER reusing the ALREADY KNOWN property groups listed above
- Keep property groups BROAD and REUSABLE: "Size", "Material", "Type", "Style"
- Maximum 5-6 unique property groups per category
- Properties should match the EXISTING product name

Products to update (${products.length} total):
${JSON.stringify(productList, null, 2)}

For each product:
1. Generate 2-3 properties that MATCH the existing product name
   Example: "Garden Hose - 20m - Green" → properties: [{ group: "Length", value: "20m" }, { group: "Color", value: "Green" }]
2. For products with isVariant: true, suggest 1-3 property group names in "suggestedVariantGroups"
${this.variantColorRule("3.")}

Return JSON in this exact format:
{
  "products": [
    {
      "id": "...",
      "properties": [{ "group": "PropertyGroup", "value": "Value" }, ...],
      "suggestedVariantGroups": ["PropertyGroup1", "PropertyGroup2"],
      "variantColors": null
    }
  ]
}`;
    }

    private async applyProductHydration(
        original: BlueprintProduct[],
        hydrated: ProductResponse["products"],
        categoryNameMap: Map<string, string>,
        categoryIdByName: Map<string, string>,
        branchName: string
    ): Promise<BlueprintProduct[]> {
        const hydratedMap = new Map(hydrated.map((p) => [p.id, p]));
        const categories: CategoryLookup = {
            nameById: categoryNameMap,
            idByName: categoryIdByName,
            branchId: categoryIdByName.get(branchName.toLowerCase()),
        };

        // Sequential on purpose: the variant resolver shares its property cache
        const results: BlueprintProduct[] = [];
        for (const product of original) {
            const content = hydratedMap.get(product.id);
            results.push(
                content ? await this.applyProductContent(product, content, categories) : product
            );
        }
        return results;
    }

    /** Merge the AI content into one product (SEO meta is derived, no extra AI call) */
    private async applyProductContent(
        product: BlueprintProduct,
        content: HydratedProductContent,
        categories: CategoryLookup
    ): Promise<BlueprintProduct> {
        const variantConfigs = await this.resolveProductVariants(product, content, categories);
        const { metaTitle, metaDescription } = deriveProductSeoMeta(
            content.name,
            content.description
        );

        return {
            ...product,
            name: content.name,
            description: content.description,
            ...assignCategories(product, content.assignedCategories, categories),
            metaTitle,
            metaDescription,
            metadata: {
                ...product.metadata,
                properties: content.properties as ProductProperty[],
                manufacturerName: content.manufacturerName,
                imageDescriptions: content.imageDescriptions as ImageDescription[],
                baseImagePrompt: this.generateBaseImagePrompt(content.name, content.properties),
                variantConfigs,
            },
        };
    }

    /** Variant configs for a variant product with AI-suggested groups (undefined when none) */
    private async resolveProductVariants(
        product: BlueprintProduct,
        content: HydratedProductContent,
        categories: CategoryLookup
    ): Promise<VariantConfig[] | undefined> {
        const groups = content.suggestedVariantGroups;
        if (!product.metadata.isVariant || !groups || groups.length === 0) return undefined;

        const configs = await this.variantResolver.resolveVariantConfigs(groups, {
            name: content.name,
            category: categories.nameById.get(product.primaryCategoryId) || "Unknown",
            productId: product.id,
            colors: productColorPreferences(content.properties, content.variantColors),
        });
        return configs.length > 0 ? configs : undefined;
    }
}

/** Products of one top-level category branch, hydrated in one task */
interface ProductBranch {
    products: BlueprintProduct[];
    name: string;
    subcategories: string[];
}

/** Lookups shared by all branch tasks of one hydrateProducts() run */
interface BranchContext {
    existingProperties: ExistingProperty[];
    categoryNameMap: Map<string, string>;
    categoryIdByName: Map<string, string>;
    storeContext: StoreContext;
}

/** Category lookups for applying the AI response of one branch */
interface CategoryLookup {
    nameById: Map<string, string>;
    idByName: Map<string, string>;
    /** ID of the branch category, matched by name */
    branchId: string | undefined;
}

type HydratedProductContent = ProductResponse["products"][number];

/** Products grouped by their primary (top-level) category, in first-seen order */
export function groupProductsByBranch(
    products: BlueprintProduct[]
): Map<string, BlueprintProduct[]> {
    const byBranch = new Map<string, BlueprintProduct[]>();
    for (const product of products) {
        const branch = byBranch.get(product.primaryCategoryId) ?? [];
        branch.push(product);
        byBranch.set(product.primaryCategoryId, branch);
    }
    return byBranch;
}

/** " → A, B, C..." for the branch log line, or "" without subcategories */
function formatSubcategoryPreview(subcategories: string[]): string {
    if (subcategories.length === 0) return "";
    const more = subcategories.length > 3 ? "..." : "";
    return ` → ${subcategories.slice(0, 3).join(", ")}${more}`;
}

/**
 * Products of all successful branches. Logs each failed branch, warns on a partial result
 * and throws when no branch succeeded.
 */
function collectBranchResults(
    settled: PromiseSettledResult<BlueprintProduct[]>[],
    branches: ProductBranch[],
    storeName: string
): BlueprintProduct[] {
    const failures = settled.flatMap((result, index) =>
        result.status === "rejected"
            ? [
                  {
                      index,
                      name: branches[index]?.name ?? `Branch ${index + 1}`,
                      error: toError(result.reason),
                  },
              ]
            : []
    );
    for (const failure of failures) logBranchFailure(storeName, failure);

    const products = settled.flatMap((result) =>
        result.status === "fulfilled" ? result.value : []
    );
    if (failures.length === 0) return products;
    if (products.length === 0) {
        const reason = failures[0]?.error.message ?? "Unknown error";
        throw new Error(
            `All ${failures.length} hydration branches failed — no products were generated. ` +
                `Reason: ${reason}`
        );
    }
    warnPartialHydration(failures.length, settled.length, products.length);
    return products;
}

function toError(reason: unknown): Error {
    return reason instanceof Error ? reason : new Error(String(reason));
}

function logBranchFailure(
    storeName: string,
    failure: { index: number; name: string; error: Error }
): void {
    logger.error(`    ✗ ${storeName} > ${failure.name} failed: ${failure.error.message}`, {
        cli: true,
    });
    logger.error(`Branch ${failure.name} failed`, {
        data: { error: failure.error.message, branchIndex: failure.index },
    });
}

function warnPartialHydration(failedCount: number, totalCount: number, productCount: number): void {
    const successCount = totalCount - failedCount;
    logger.warn(
        `\n    ⚠ ${failedCount}/${totalCount} branches failed. ` +
            `${productCount} products from ${successCount} successful branches will be used.`,
        { cli: true }
    );
    logger.warn(`Partial hydration: ${failedCount} branches failed`, {
        data: { failedCount, successCount, productsHydrated: productCount },
    });
}

/**
 * Categories from the AI: the branch category first (also the new primary category), then
 * the known assigned names. Keeps the current categories when nothing is assigned or known.
 */
function assignCategories(
    product: BlueprintProduct,
    assignedNames: string[] | null,
    categories: CategoryLookup
): Pick<BlueprintProduct, "categoryIds" | "primaryCategoryId"> {
    if (!assignedNames || assignedNames.length === 0) {
        return { categoryIds: product.categoryIds, primaryCategoryId: product.primaryCategoryId };
    }
    const ids = [
        categories.branchId,
        ...assignedNames.map((name) => categories.idByName.get(name.toLowerCase())),
    ].filter((id): id is string => Boolean(id));
    const uniqueIds = [...new Set(ids)];

    return {
        categoryIds: uniqueIds.length > 0 ? uniqueIds : product.categoryIds,
        primaryCategoryId: categories.branchId ?? product.primaryCategoryId,
    };
}

/** Parse a JSON response, also when the model wrapped it in a Markdown code fence */
function parseJsonResponse(responseText: string): unknown {
    const trimmed = responseText.trim();
    const fenced = trimmed.startsWith("```")
        ? trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim()
        : undefined;
    return JSON.parse(fenced || trimmed);
}
