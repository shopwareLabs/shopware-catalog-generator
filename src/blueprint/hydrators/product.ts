/**
 * Product Hydrator - Fills product placeholders with AI-generated content
 *
 * Handles product names, descriptions, properties, image prompts, and manufacturer assignment.
 * Uses parallel processing when the provider supports concurrency.
 */

import { z } from "zod";

import type {
    BlueprintCategory,
    BlueprintProduct,
    ImageDescription,
    ProductProperty,
    TextProvider,
    VariantConfig,
} from "../../types/index.js";
import type { ExistingProperty } from "../../utils/index.js";
import type { VariantResolver } from "../variant-resolver.js";

import { PropertyCache } from "../../property-cache.js";
import { ConcurrencyLimiter, executeWithRetry, logger } from "../../utils/index.js";

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
        })
    ),
});

type ProductResponse = z.infer<typeof ProductResponseSchema>;
type PropertyOnlyResponse = z.infer<typeof PropertyOnlyResponseSchema>;

// =============================================================================
// Token Estimation
// =============================================================================

const CHARS_PER_TOKEN: Record<string, number> = {
    openai: 4.0,
    "github-models": 4.0,
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
        private readonly generateBaseImagePrompt: GenerateBaseImagePromptFn
    ) {}

    /**
     * Hydrate products with AI
     * Uses parallel processing when the provider supports concurrency
     */
    async hydrateProducts(
        products: BlueprintProduct[],
        hydratedCategories: HydratedCategory[],
        categoryTree: BlueprintCategory[],
        existingProperties: ExistingProperty[],
        storeContext: StoreContext
    ): Promise<BlueprintProduct[]> {
        const productsByBranch = new Map<string, BlueprintProduct[]>();

        for (const product of products) {
            const branch = product.primaryCategoryId;
            const existing = productsByBranch.get(branch);
            if (existing) {
                existing.push(product);
            } else {
                productsByBranch.set(branch, [product]);
            }
        }

        const categoryNameMap = new Map<string, string>();
        const categoryIdByName = new Map<string, string>();
        for (const cat of hydratedCategories) {
            categoryNameMap.set(cat.id, cat.name);
            categoryIdByName.set(cat.name.toLowerCase(), cat.id);
        }

        const branchSubcategories = this.buildBranchSubcategoryMap(categoryTree, categoryNameMap);

        const totalBranches = productsByBranch.size;
        const maxConcurrency = this.textProvider.maxConcurrency;

        if (maxConcurrency > 1) {
            logger.info(
                `    Using parallel processing (max ${maxConcurrency} concurrent branches)`,
                { cli: true }
            );
            logger.info(`Parallel branch processing enabled`, {
                data: { maxConcurrency, totalBranches },
            });
        } else {
            logger.info(`    Using sequential processing (provider: ${this.textProvider.name})`, {
                cli: true,
            });
            logger.info(`Sequential branch processing`, {
                data: { provider: this.textProvider.name },
            });
        }

        const limiter = new ConcurrencyLimiter(maxConcurrency);
        const branches = Array.from(productsByBranch.entries());
        let completedBranches = 0;

        const branchTasks = branches.map(([branchId, branchProducts], index) => {
            const branchName = categoryNameMap.get(branchId) || `Branch ${index + 1}`;
            const availableSubcategories = branchSubcategories.get(branchId) || [];
            const subCatPreview = availableSubcategories.slice(0, 3).join(", ");

            return limiter.schedule(async () => {
                const branchNum = index + 1;
                const subCatText = subCatPreview
                    ? ` → ${subCatPreview}${availableSubcategories.length > 3 ? "..." : ""}`
                    : "";
                logger.info(
                    `    [Branch ${branchNum}/${totalBranches}] ${storeContext.name} > ${branchName}${subCatText} (${branchProducts.length} products)`,
                    { cli: true }
                );

                const hydrated = await this.hydrateBranchProducts(
                    branchProducts,
                    branchName,
                    existingProperties,
                    categoryNameMap,
                    categoryIdByName,
                    availableSubcategories,
                    storeContext
                );

                completedBranches++;
                logger.info(
                    `    ✓ ${storeContext.name} > ${branchName} complete (${completedBranches}/${totalBranches} branches)`,
                    { cli: true }
                );

                return hydrated;
            });
        });

        const settledResults = await Promise.allSettled(branchTasks);

        const fulfilledProducts: BlueprintProduct[] = [];
        const failedBranches: { branchIndex: number; error: Error }[] = [];

        for (const [i, result] of settledResults.entries()) {
            if (result.status === "fulfilled") {
                fulfilledProducts.push(...result.value);
            } else {
                const branchEntry = branches[i];
                const branchName = branchEntry
                    ? categoryNameMap.get(branchEntry[0]) || `Branch ${i + 1}`
                    : `Branch ${i + 1}`;
                const error =
                    result.reason instanceof Error
                        ? result.reason
                        : new Error(String(result.reason));
                failedBranches.push({ branchIndex: i, error });
                logger.error(
                    `    ✗ ${storeContext.name} > ${branchName} failed: ${error.message}`,
                    { cli: true }
                );
                logger.error(`Branch ${branchName} failed`, {
                    data: { error: error.message, branchIndex: i },
                });
            }
        }

        if (failedBranches.length > 0) {
            const successCount = settledResults.length - failedBranches.length;
            logger.warn(
                `\n    ⚠ ${failedBranches.length}/${settledResults.length} branches failed. ` +
                    `${fulfilledProducts.length} products from ${successCount} successful branches will be used.`,
                { cli: true }
            );
            logger.warn(`Partial hydration: ${failedBranches.length} branches failed`, {
                data: {
                    failedCount: failedBranches.length,
                    successCount,
                    productsHydrated: fulfilledProducts.length,
                },
            });
        }

        return fulfilledProducts;
    }

    /**
     * Hydrate properties for a branch of products (properties-only mode)
     */
    async hydratePropertiesForBranch(
        products: BlueprintProduct[],
        branchName: string,
        existingProperties: ExistingProperty[],
        storeContext: StoreContext
    ): Promise<Map<string, PropertyOnlyResponse["products"][0]>> {
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

        let jsonStr = responseText.trim();
        if (jsonStr.startsWith("```")) {
            const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (match) {
                jsonStr = match[1]?.trim() || jsonStr;
            }
        }

        const parsed = JSON.parse(jsonStr);
        const validated = PropertyOnlyResponseSchema.parse(parsed);

        return new Map(validated.products.map((p) => [p.id, p]));
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
- "Color" is the only predefined property group - use it when color is relevant for the product
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
- "Color" is the only predefined property group - use it when color is relevant
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

Return JSON in this exact format:
{
  "products": [
    {
      "id": "...",
      "properties": [{ "group": "PropertyGroup", "value": "Value" }, ...],
      "suggestedVariantGroups": ["PropertyGroup1", "PropertyGroup2"]
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
        const results: BlueprintProduct[] = [];

        const branchCategoryId = categoryIdByName.get(branchName.toLowerCase());

        for (const product of original) {
            const h = hydratedMap.get(product.id);
            if (!h) {
                results.push(product);
                continue;
            }

            const baseImagePrompt = this.generateBaseImagePrompt(h.name, h.properties);

            let variantConfigs: VariantConfig[] | undefined;
            if (
                product.metadata.isVariant &&
                h.suggestedVariantGroups &&
                h.suggestedVariantGroups.length > 0
            ) {
                const categoryName = categoryNameMap.get(product.primaryCategoryId) || "Unknown";
                variantConfigs = await this.variantResolver.resolveVariantConfigs(
                    h.suggestedVariantGroups,
                    { name: h.name, category: categoryName }
                );
            }

            let categoryIds = product.categoryIds;
            let primaryCategoryId = product.primaryCategoryId;

            if (h.assignedCategories && h.assignedCategories.length > 0) {
                const newCategoryIds: string[] = [];
                if (branchCategoryId) {
                    newCategoryIds.push(branchCategoryId);
                    primaryCategoryId = branchCategoryId;
                }

                for (const catName of h.assignedCategories) {
                    const catId = categoryIdByName.get(catName.toLowerCase());
                    if (catId && !newCategoryIds.includes(catId)) {
                        newCategoryIds.push(catId);
                    }
                }

                if (newCategoryIds.length > 0) {
                    categoryIds = newCategoryIds;
                }
            }

            results.push({
                ...product,
                name: h.name,
                description: h.description,
                categoryIds,
                primaryCategoryId,
                metadata: {
                    ...product.metadata,
                    properties: h.properties as ProductProperty[],
                    manufacturerName: h.manufacturerName,
                    imageDescriptions: h.imageDescriptions as ImageDescription[],
                    baseImagePrompt,
                    variantConfigs:
                        variantConfigs && variantConfigs.length > 0 ? variantConfigs : undefined,
                },
            });
        }

        return results;
    }
}
