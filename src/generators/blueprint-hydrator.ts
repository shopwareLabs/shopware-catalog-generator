/**
 * Blueprint Hydrator - Fills blueprint with AI-generated content
 *
 * This hydrator takes a raw blueprint and fills it with:
 * - SalesChannel descriptions
 * - Category names and descriptions
 * - Product names, descriptions, and properties
 * - Image descriptions for post-processors
 * - Manufacturer names
 *
 * It makes multiple AI calls:
 * 1. One call for SalesChannel + all categories
 * 2. One call per top-level category branch for products
 */

import { z } from "zod";

import { PropertyCache } from "../property-cache.js";
import type {
    Blueprint,
    BlueprintCategory,
    BlueprintProduct,
    CachedPropertyGroup,
    HydratedBlueprint,
    ImageDescription,
    ProductProperty,
    TextProvider,
    VariantConfig,
} from "../types/index.js";
import type { ExistingProperty } from "../utils/index.js";
import {
    ConcurrencyLimiter,
    executeWithRetry,
    findClosestColor,
    logger,
    randomSamplePercent,
    toKebabCase,
} from "../utils/index.js";

// =============================================================================
// Zod Schemas for AI Response Validation
// =============================================================================

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
            // For variant products: AI suggests 1-3 property group names
            suggestedVariantGroups: z.array(z.string()).nullable(),
        })
    ),
});

// Schema for AI-generated property options (when cache miss)
// Note: Using array of objects instead of Record for OpenAI structured outputs compatibility
const PropertyOptionsResponseSchema = z.object({
    groupName: z.string(),
    options: z.array(z.string()),
    priceModifiers: z.array(
        z.object({
            option: z.string(),
            modifier: z.number(),
        })
    ).nullable(),
});

type CategoryResponse = z.infer<typeof CategoryResponseSchema>;
type ProductResponse = z.infer<typeof ProductResponseSchema>;

// =============================================================================
// Token Estimation
// =============================================================================

/**
 * Estimate token count for a payload (rough estimate: 1 token ≈ 4 chars)
 */
function estimateTokens(payload: unknown): number {
    return Math.ceil(JSON.stringify(payload).length / 4);
}

/**
 * Check if payload fits within token limit (using 70% of limit for safety)
 */
function fitsInTokenLimit(payload: unknown, tokenLimit: number): boolean {
    const estimated = estimateTokens(payload);
    return estimated < tokenLimit * 0.7;
}

// =============================================================================
// Blueprint Hydrator Class
// =============================================================================

/**
 * Store context passed through hydration methods
 */
interface StoreContext {
    name: string;
    description: string;
}

export class BlueprintHydrator {
    private readonly textProvider: TextProvider;
    private readonly cacheDir: string;
    private propertyCache: PropertyCache;

    constructor(textProvider: TextProvider, cacheDir = "./generated") {
        this.textProvider = textProvider;
        this.cacheDir = cacheDir;
        // Initialize with global cache, will be replaced with store-scoped on hydrate
        this.propertyCache = new PropertyCache(cacheDir);
        // Seed with universal property groups (Color) if cache is empty
        this.propertyCache.ensureDefaults();
    }

    /**
     * Hydrate a blueprint with AI-generated content
     */
    async hydrate(
        blueprint: Blueprint,
        existingProperties: ExistingProperty[] = []
    ): Promise<HydratedBlueprint> {
        console.log("Hydrating blueprint with AI...");
        logger.info("Starting blueprint hydration", {
            salesChannel: blueprint.salesChannel.name,
            categories: blueprint.categories.length,
            products: blueprint.products.length,
            existingProperties: existingProperties.length,
        });

        // Create store-scoped PropertyCache for this sales channel
        const storeSlug = toKebabCase(blueprint.salesChannel.name);
        this.propertyCache = PropertyCache.forStore(this.cacheDir, storeSlug);
        // Ensure universal properties (Color) are available
        this.propertyCache.ensureDefaults();

        // Store context for property generation
        const storeContext: StoreContext = {
            name: blueprint.salesChannel.name,
            description: blueprint.salesChannel.description,
        };

        // Step 1: Hydrate SalesChannel and categories
        console.log("  [1/2] Generating category names and descriptions...");
        logger.info("Hydrating categories...");
        const hydratedCategories = await this.hydrateCategories(
            blueprint.salesChannel.name,
            blueprint.salesChannel.description,
            blueprint.categories
        );
        logger.info("Categories hydrated", {
            count: hydratedCategories.categories.length,
        });

        // Step 2: Hydrate products per top-level branch
        console.log("  [2/2] Generating product content...");
        logger.info("Hydrating products...");
        const hydratedProducts = await this.hydrateProducts(
            blueprint.products,
            hydratedCategories.categories,
            existingProperties,
            storeContext
        );
        logger.info("Products hydrated", { count: hydratedProducts.length });

        // Build hydrated blueprint
        const hydrated: HydratedBlueprint = {
            ...blueprint,
            salesChannel: {
                ...blueprint.salesChannel,
                description: hydratedCategories.salesChannelDescription,
            },
            categories: this.applyCategoryHydration(
                blueprint.categories,
                hydratedCategories.categories
            ),
            products: hydratedProducts,
            propertyGroups: [], // Will be filled by property collector
            hydratedAt: new Date().toISOString(),
        };

        console.log("  Blueprint hydrated successfully");
        logger.info("Blueprint hydration complete");
        return hydrated;
    }

    /**
     * Hydrate SalesChannel and categories with AI
     */
    private async hydrateCategories(
        salesChannelName: string,
        salesChannelDescription: string,
        categories: BlueprintCategory[]
    ): Promise<CategoryResponse> {
        const flatCategories = this.flattenCategories(categories);

        logger.debug(`Generating content for ${flatCategories.length} categories`, {
            salesChannelName,
        });

        const prompt = this.buildCategoryPrompt(
            salesChannelName,
            salesChannelDescription,
            flatCategories
        );

        logger.debug("Category prompt built", { promptLength: prompt.length });

        const startTime = Date.now();
        let response: string;

        try {
            response = await executeWithRetry(async () => {
                logger.debug("Calling text provider for categories...");
                return this.textProvider.generateCompletion(
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
            logger.error(`Category API call failed after ${elapsed}ms`, {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }

        const elapsed = Date.now() - startTime;
        logger.info(`Category API call completed in ${elapsed}ms`, {
            responseLength: response.length,
        });

        try {
            const parsed = JSON.parse(response) as CategoryResponse;
            const validated = CategoryResponseSchema.parse(parsed);
            logger.debug(`Parsed ${validated.categories.length} categories from response`);
            return validated;
        } catch (error) {
            logger.error("Failed to parse category AI response", {
                error: error instanceof Error ? error.message : String(error),
                responsePreview: response.slice(0, 500),
            });
            throw new Error("Failed to parse category AI response");
        }
    }

    /**
     * Build the prompt for category hydration
     */
    private buildCategoryPrompt(
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

    /**
     * Hydrate products with AI
     * Uses parallel processing when the provider supports concurrency
     */
    private async hydrateProducts(
        products: BlueprintProduct[],
        hydratedCategories: CategoryResponse["categories"],
        existingProperties: ExistingProperty[],
        storeContext: StoreContext
    ): Promise<BlueprintProduct[]> {
        // Group products by primary category (top-level branch)
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

        // Build category name lookup
        const categoryNameMap = new Map<string, string>();
        for (const cat of hydratedCategories) {
            categoryNameMap.set(cat.id, cat.name);
        }

        const totalBranches = productsByBranch.size;
        const maxConcurrency = this.textProvider.maxConcurrency;

        // Log parallelization strategy
        if (maxConcurrency > 1) {
            console.log(
                `    Using parallel processing (max ${maxConcurrency} concurrent branches)`
            );
            logger.info(`Parallel branch processing enabled`, { maxConcurrency, totalBranches });
        } else {
            console.log(`    Using sequential processing (provider: ${this.textProvider.name})`);
            logger.info(`Sequential branch processing`, { provider: this.textProvider.name });
        }

        // Create concurrency limiter for parallel processing
        const limiter = new ConcurrencyLimiter(maxConcurrency);

        // Build branch tasks
        const branches = Array.from(productsByBranch.entries());
        let completedBranches = 0;

        const branchTasks = branches.map(([branchId, branchProducts], index) => {
            const branchName = categoryNameMap.get(branchId) || `Branch ${index + 1}`;

            // Collect sub-categories for this branch
            const subCategories = new Set<string>();
            for (const product of branchProducts) {
                for (const catId of product.categoryIds) {
                    const catName = categoryNameMap.get(catId);
                    if (catName && catName !== branchName) {
                        subCategories.add(catName);
                    }
                }
            }
            const subCatPreview = Array.from(subCategories).slice(0, 3).join(", ");

            return limiter.schedule(async () => {
                const branchNum = index + 1;
                const subCatText = subCatPreview ? ` → ${subCatPreview}${subCategories.size > 3 ? "..." : ""}` : "";
                console.log(
                    `    [Branch ${branchNum}/${totalBranches}] ${storeContext.name} > ${branchName}${subCatText} (${branchProducts.length} products)`
                );

                const hydrated = await this.hydrateBranchProducts(
                    branchProducts,
                    branchName,
                    existingProperties,
                    categoryNameMap,
                    storeContext
                );

                completedBranches++;
                console.log(
                    `    ✓ ${storeContext.name} > ${branchName} complete (${completedBranches}/${totalBranches} branches)`
                );

                return hydrated;
            });
        });

        // Execute all branches (with concurrency limiting)
        const results = await Promise.all(branchTasks);

        // Flatten results
        return results.flat();
    }

    /**
     * Calculate manufacturer count based on product count (1 per ~15 products, min 2)
     */
    private calculateManufacturerCount(productCount: number): number {
        return Math.max(2, Math.ceil(productCount / 15));
    }

    /**
     * Generate manufacturer names for a branch based on product count
     */
    private generateManufacturerNames(branchName: string, count: number): string[] {
        // Generate predictable manufacturer names based on branch
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

    // Track batch progress for logging
    private batchCounter: Map<string, { current: number; total: number }> = new Map();

    /** Maximum products per API call to avoid timeouts */
    private static readonly MAX_BATCH_SIZE = 10;

    /**
     * Check if a batch needs to be split (too large or exceeds token limit)
     */
    private shouldSplitBatch(products: BlueprintProduct[], branchName: string): boolean {
        if (products.length > BlueprintHydrator.MAX_BATCH_SIZE) return true;
        const payload = { products: products.map((p) => p.id), branchName };
        return !fitsInTokenLimit(payload, this.textProvider.tokenLimit);
    }

    /**
     * Split batch in half and process recursively (parallel if supported)
     */
    private async hydrateSplitBatch(
        products: BlueprintProduct[],
        branchName: string,
        existingProperties: ExistingProperty[],
        categoryNameMap: Map<string, string>,
        storeContext: StoreContext,
        manufacturerNames: string[]
    ): Promise<BlueprintProduct[]> {
        const midpoint = Math.ceil(products.length / 2);
        const batch1 = products.slice(0, midpoint);
        const batch2 = products.slice(midpoint);

        // Parallel processing when provider supports it
        if (this.textProvider.maxConcurrency > 1) {
            const [hydrated1, hydrated2] = await Promise.all([
                this.hydrateBranchProducts(batch1, branchName, existingProperties, categoryNameMap, storeContext, manufacturerNames),
                this.hydrateBranchProducts(batch2, branchName, existingProperties, categoryNameMap, storeContext, manufacturerNames),
            ]);
            return [...hydrated1, ...hydrated2];
        }

        // Sequential processing for rate-limited providers
        const hydrated1 = await this.hydrateBranchProducts(batch1, branchName, existingProperties, categoryNameMap, storeContext, manufacturerNames);
        const hydrated2 = await this.hydrateBranchProducts(batch2, branchName, existingProperties, categoryNameMap, storeContext, manufacturerNames);
        return [...hydrated1, ...hydrated2];
    }

    /**
     * Make single AI API call for a batch of products
     */
    private async hydrateSingleBatch(
        products: BlueprintProduct[],
        branchName: string,
        existingProperties: ExistingProperty[],
        categoryNameMap: Map<string, string>,
        storeContext: StoreContext,
        manufacturerNames: string[]
    ): Promise<BlueprintProduct[]> {
        // Collect unique sub-categories for this batch
        const subCategories = new Set<string>();
        for (const product of products) {
            for (const catId of product.categoryIds) {
                const catName = categoryNameMap.get(catId);
                if (catName && catName !== branchName) {
                    subCategories.add(catName);
                }
            }
        }
        const subCatList = Array.from(subCategories).slice(0, 3); // Show up to 3
        const subCatText = subCatList.length > 0 ? ` (${subCatList.join(", ")})` : "";

        // Update batch progress
        const counter = this.batchCounter.get(branchName);
        if (counter) {
            counter.current++;
            console.log(`      [Batch ${counter.current}/${counter.total}] Generating ${products.length} products...`);
        }

        const prompt = this.buildProductPrompt(products, branchName, existingProperties, categoryNameMap, storeContext, manufacturerNames);
        logger.debug(`API call: ${storeContext.name} > ${branchName}${subCatText} - ${products.length} products`, {
            productIds: products.map((p) => p.id.slice(0, 8)),
            promptLength: prompt.length,
            subCategories: Array.from(subCategories),
        });

        const startTime = Date.now();
        const response = await this.callProductApi(branchName, prompt, startTime);
        return this.parseProductResponse(response, products, branchName, categoryNameMap, startTime);
    }

    /**
     * Call text provider API with retry logic
     */
    private async callProductApi(branchName: string, prompt: string, startTime: number): Promise<string> {
        try {
            return await executeWithRetry(async () => {
                logger.debug(`Calling text provider for "${branchName}"...`, { promptLength: prompt.length });
                return this.textProvider.generateCompletion(
                    [
                        { role: "system", content: "You are a professional e-commerce copywriter. Generate realistic product content with consistent naming patterns." },
                        { role: "user", content: prompt },
                    ],
                    ProductResponseSchema,
                    "ProductResponse"
                );
            });
        } catch (error) {
            const elapsed = Date.now() - startTime;
            logger.error(`API call failed for "${branchName}" after ${elapsed}ms`, {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    /**
     * Parse and validate API response, apply hydration
     */
    private async parseProductResponse(
        response: string,
        products: BlueprintProduct[],
        branchName: string,
        categoryNameMap: Map<string, string>,
        startTime: number
    ): Promise<BlueprintProduct[]> {
        const elapsed = Date.now() - startTime;
        const elapsedSec = (elapsed / 1000).toFixed(1);
        logger.info(`API call completed for "${branchName}" in ${elapsed}ms`, { responseLength: response.length });

        try {
            const parsed = JSON.parse(response) as ProductResponse;
            const validated = ProductResponseSchema.parse(parsed);
            console.log(`        ✓ Generated ${validated.products.length} products (${elapsedSec}s)`);
            logger.debug(`Parsed ${validated.products.length} products for "${branchName}"`);
            return await this.applyProductHydration(products, validated.products, categoryNameMap);
        } catch (error) {
            logger.error(`Failed to parse AI response for "${branchName}"`, {
                error: error instanceof Error ? error.message : String(error),
                responsePreview: response.slice(0, 500),
            });
            throw new Error(`Failed to parse product AI response for branch ${branchName}`);
        }
    }

    /**
     * Hydrate products for a single branch
     * Splits into smaller batches if needed to avoid API timeouts
     */
    private async hydrateBranchProducts(
        products: BlueprintProduct[],
        branchName: string,
        existingProperties: ExistingProperty[],
        categoryNameMap: Map<string, string>,
        storeContext: StoreContext,
        manufacturerNames?: string[]
    ): Promise<BlueprintProduct[]> {
        // Generate manufacturer names if not provided (first call for this branch)
        if (!manufacturerNames) {
            const manufacturerCount = this.calculateManufacturerCount(products.length);
            manufacturerNames = this.generateManufacturerNames(branchName, manufacturerCount);
            const totalBatches = Math.ceil(products.length / BlueprintHydrator.MAX_BATCH_SIZE);
            this.batchCounter.set(branchName, { current: 0, total: totalBatches });
        }

        // Split batch if too large or exceeds token limit
        if (this.shouldSplitBatch(products, branchName)) {
            return this.hydrateSplitBatch(products, branchName, existingProperties, categoryNameMap, storeContext, manufacturerNames);
        }

        // Process single batch
        return this.hydrateSingleBatch(products, branchName, existingProperties, categoryNameMap, storeContext, manufacturerNames);
    }

    /**
     * Build the prompt for product hydration
     *
     * Uses store context (name + description) and category context to let the AI
     * generate domain-appropriate properties. No hardcoded property groups except Color.
     */
    private buildProductPrompt(
        products: BlueprintProduct[],
        branchName: string,
        existingProperties: ExistingProperty[],
        categoryNameMap: Map<string, string>,
        storeContext: StoreContext,
        manufacturerNames: string[]
    ): string {
        const productList = products.map((p) => ({
            id: p.id,
            imageCount: p.metadata.imageCount,
            imageViews: p.metadata.imageDescriptions.map((d) => d.view),
            isVariant: p.metadata.isVariant,
            variantGroups: p.metadata.variantConfigs?.map((c) => c.group) ?? [],
            categories: p.categoryIds.map((id) => categoryNameMap.get(id) || id),
        }));

        const existingPropsText =
            existingProperties.length > 0
                ? `
Existing properties in Shopware (reuse when applicable):
${JSON.stringify(existingProperties, null, 2)}
`
                : "";

        // List cached property groups for AI context (includes Color and any previously generated groups)
        const cachedGroups = this.propertyCache.listNames();
        const cachedGroupsText = cachedGroups.length > 0
            ? `\nALREADY KNOWN property groups for this store (prefer these): ${cachedGroups.join(", ")}`
            : "";

        return `Generate product content for the "${branchName}" category.

STORE CONTEXT:
- Store name: "${storeContext.name}"
- Store description: "${storeContext.description}"

${existingPropsText}
${cachedGroupsText}

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
      "suggestedVariantGroups": ["PropertyGroup1", "PropertyGroup2"]
    }
  ]
}`;
    }

    /**
     * Apply category hydration to the original category tree
     */
    private applyCategoryHydration(
        original: BlueprintCategory[],
        hydrated: CategoryResponse["categories"]
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
     * Generate a consistent base image prompt from product name and properties
     *
     * This base prompt is used with view-specific suffixes to ensure
     * all product images look like the same product from different angles.
     */
    private generateBaseImagePrompt(
        productName: string,
        properties: Array<{ group: string; value: string }>
    ): string {
        // Extract key properties for image description
        const material = properties.find((p) => p.group.toLowerCase() === "material")?.value;
        const color = properties.find((p) => p.group.toLowerCase() === "color")?.value;
        const style = properties.find((p) => p.group.toLowerCase() === "style")?.value;

        // Start with the product name (often already descriptive)
        let basePrompt = productName;

        // Add material if not already in name
        if (material && !productName.toLowerCase().includes(material.toLowerCase())) {
            basePrompt += `, ${material} construction`;
        }

        // Add color/finish with proper color name
        if (color) {
            const colorMatch = findClosestColor(color);
            const colorName = colorMatch?.name ?? color;
            if (!productName.toLowerCase().includes(color.toLowerCase())) {
                basePrompt += `, ${colorName} finish`;
            }
        }

        // Add style if not already in name
        if (style && !productName.toLowerCase().includes(style.toLowerCase())) {
            basePrompt += `, ${style} design`;
        }

        return basePrompt;
    }

    /**
     * Apply product hydration to the original products
     * Resolves variant configs from cache or AI for variant products
     */
    private async applyProductHydration(
        original: BlueprintProduct[],
        hydrated: ProductResponse["products"],
        categoryNameMap: Map<string, string>
    ): Promise<BlueprintProduct[]> {
        const hydratedMap = new Map(hydrated.map((p) => [p.id, p]));
        const results: BlueprintProduct[] = [];

        for (const product of original) {
            const h = hydratedMap.get(product.id);
            if (!h) {
                results.push(product);
                continue;
            }

            // Generate base image prompt for consistent multi-view images
            const baseImagePrompt = this.generateBaseImagePrompt(h.name, h.properties);

            // For variant products: resolve variant configs from AI suggestions
            let variantConfigs: VariantConfig[] | undefined;
            if (product.metadata.isVariant && h.suggestedVariantGroups && h.suggestedVariantGroups.length > 0) {
                // Get category name for context
                const categoryName = categoryNameMap.get(product.primaryCategoryId) || "Unknown";
                variantConfigs = await this.resolveVariantConfigs(
                    h.suggestedVariantGroups,
                    { name: h.name, category: categoryName }
                );
            }

            results.push({
                ...product,
                name: h.name,
                description: h.description,
                metadata: {
                    ...product.metadata,
                    properties: h.properties as ProductProperty[],
                    manufacturerName: h.manufacturerName,
                    imageDescriptions: h.imageDescriptions as ImageDescription[],
                    baseImagePrompt,
                    variantConfigs: variantConfigs && variantConfigs.length > 0 ? variantConfigs : undefined,
                },
            });
        }

        return results;
    }

    /**
     * Resolve variant configs from AI-suggested group names
     * Uses cache for known groups, generates options for unknown groups
     */
    private async resolveVariantConfigs(
        suggestedGroups: string[] | undefined,
        productContext: { name: string; category: string }
    ): Promise<VariantConfig[]> {
        if (!suggestedGroups || suggestedGroups.length === 0) {
            return [];
        }

        const configs: VariantConfig[] = [];

        for (const groupName of suggestedGroups) {
            // Normalize the group name for cache lookup
            const normalizedName = this.normalizeGroupName(groupName);

            if (this.propertyCache.has(normalizedName)) {
                // Cache hit - reuse existing options
                const cached = this.propertyCache.get(normalizedName);
                if (cached) {
                    // Select 40-60% of options for this product
                    const selectedOptions = randomSamplePercent(cached.options, 0.4, 0.6);
                    // Ensure at least 2 options for meaningful variants
                    const finalOptions = selectedOptions.length >= 2
                        ? selectedOptions
                        : cached.options.slice(0, Math.min(2, cached.options.length));

                    // Build price modifiers for selected options
                    const priceModifiers: Record<string, number> = {};
                    for (const opt of finalOptions) {
                        priceModifiers[opt] = cached.priceModifiers?.[opt] ?? 1.0;
                    }

                    configs.push({
                        group: cached.name,
                        selectedOptions: finalOptions,
                        priceModifiers,
                    });

                    logger.debug(`Property cache hit for "${groupName}" -> "${cached.name}"`, {
                        options: finalOptions.length,
                    });
                }
            } else {
                // Never generate Color via AI - it should always come from universal cache
                if (normalizedName.toLowerCase() === "color" || groupName.toLowerCase() === "color") {
                    logger.warn(`AI suggested "Color" but it's not in cache - this shouldn't happen. Skipping.`);
                    // Try to get Color from cache one more time with exact name
                    const colorFromCache = this.propertyCache.get("Color");
                    if (colorFromCache) {
                        const selectedOptions = randomSamplePercent(colorFromCache.options, 0.4, 0.6);
                        const finalOptions = selectedOptions.length >= 2
                            ? selectedOptions
                            : colorFromCache.options.slice(0, Math.min(2, colorFromCache.options.length));
                        configs.push({
                            group: colorFromCache.name,
                            selectedOptions: finalOptions,
                            priceModifiers: {},
                        });
                    }
                    continue;
                }

                // Cache miss - ask AI to generate options
                logger.info(`Property cache miss for "${groupName}", generating options...`);
                try {
                    const generated = await this.generatePropertyOptions(groupName, productContext);
                    configs.push(generated);
                } catch (error) {
                    logger.error(`Failed to generate options for "${groupName}"`, error);
                    // Continue with other groups
                }
            }
        }

        return configs;
    }

    /**
     * Normalize a property group name for cache lookup
     * Uses fuzzy matching against cached groups to consolidate similar names
     */
    private normalizeGroupName(name: string): string {
        const normalized = name.trim();

        // Try exact match first (case-insensitive)
        if (this.propertyCache.has(normalized)) {
            return normalized;
        }

        // Try to find a cached group that the input name ends with
        // e.g., "Pot Size" matches cached "Size", "Handle Material" matches cached "Material"
        const cachedGroups = this.propertyCache.listNames();
        for (const cached of cachedGroups) {
            const cachedLower = cached.toLowerCase();
            const normalizedLower = normalized.toLowerCase();

            // Check if input ends with cached name (e.g., "Pot Size" ends with "Size")
            if (normalizedLower.endsWith(cachedLower) && normalizedLower !== cachedLower) {
                return cached;
            }

            // Check if input starts with cached name (e.g., "Size Large" starts with "Size")
            if (normalizedLower.startsWith(`${cachedLower} `)) {
                return cached;
            }
        }

        return normalized;
    }

    /**
     * Generate property options using AI for a new group
     * Note: Color should NEVER be generated here - it must come from universal cache
     */
    private async generatePropertyOptions(
        groupName: string,
        productContext: { name: string; category: string }
    ): Promise<VariantConfig> {
        // Safety net: refuse to generate Color (must use universal cache)
        if (groupName.toLowerCase() === "color") {
            throw new Error("Color must not be generated via AI - use universal cache");
        }

        const prompt = `Generate property options for a variant property group.

Product context:
- Product: "${productContext.name}"
- Category: "${productContext.category}"
- Property group: "${groupName}"

Generate 5-8 realistic options for this property group.
Options should be:
- Appropriate for the product type
- Realistic for e-commerce variants
- Short (1-3 words each)

Also suggest price modifiers (multipliers) where appropriate:
- 1.0 = base price
- 0.9 = 10% cheaper
- 1.1 = 10% more expensive

Return JSON:
{
  "groupName": "${groupName}",
  "options": ["Option 1", "Option 2", ...],
  "priceModifiers": [{"option": "Option 1", "modifier": 1.0}, {"option": "Option 2", "modifier": 1.1}, ...]
}`;

        const response = await executeWithRetry(() =>
            this.textProvider.generateCompletion(
                [
                    {
                        role: "system",
                        content: "You are a JSON generator. Output ONLY valid JSON.",
                    },
                    { role: "user", content: prompt },
                ],
                PropertyOptionsResponseSchema,
                "PropertyOptionsResponse"
            )
        );

        const parsed = JSON.parse(response);
        const validated = PropertyOptionsResponseSchema.parse(parsed);

        // Convert array format to Record format for priceModifiers
        const priceModifiersRecord: Record<string, number> = {};
        if (validated.priceModifiers) {
            for (const pm of validated.priceModifiers) {
                priceModifiersRecord[pm.option] = pm.modifier;
            }
        }

        // Save to cache for future use
        const displayType = PropertyCache.inferDisplayType(groupName);
        const cachedGroup: CachedPropertyGroup = {
            name: validated.groupName,
            slug: toKebabCase(validated.groupName),
            displayType,
            options: validated.options,
            priceModifiers: Object.keys(priceModifiersRecord).length > 0 ? priceModifiersRecord : undefined,
            createdAt: new Date().toISOString(),
            source: "ai-generated",
        };
        this.propertyCache.save(cachedGroup);

        logger.info(`Generated and cached new property group "${groupName}"`, {
            options: validated.options.length,
        });

        // Select 40-60% of options for this product
        const selectedOptions = randomSamplePercent(validated.options, 0.4, 0.6);
        const finalOptions = selectedOptions.length >= 2
            ? selectedOptions
            : validated.options.slice(0, 2);

        // Build price modifiers for selected options
        const priceModifiers: Record<string, number> = {};
        for (const opt of finalOptions) {
            priceModifiers[opt] = priceModifiersRecord[opt] ?? 1.0;
        }

        return {
            group: validated.groupName,
            selectedOptions: finalOptions,
            priceModifiers,
        };
    }

    /**
     * Flatten category tree for prompts
     */
    private flattenCategories(categories: BlueprintCategory[]): BlueprintCategory[] {
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

    // =============================================================================
    // Fix Placeholders - Repair incomplete hydration
    // =============================================================================

    /** Pattern to detect placeholder names */
    private static readonly PLACEHOLDER_PATTERNS = [
        /^Top Category \d+$/,
        /^Category L\d+-\d+$/,
        /^Product \d+$/,
        /^(First |Second |Third |Fourth |Fifth )?Top Level Category$/,
        /^Subcategory [A-Z]$/,
    ];

    /** Check if a name is a placeholder */
    private isPlaceholder(name: string): boolean {
        return BlueprintHydrator.PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(name));
    }

    /**
     * Find all categories with placeholder names
     */
    findPlaceholderCategories(categories: BlueprintCategory[]): BlueprintCategory[] {
        const placeholders: BlueprintCategory[] = [];

        const traverse = (cats: BlueprintCategory[]) => {
            for (const cat of cats) {
                if (this.isPlaceholder(cat.name)) {
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
    findPlaceholderProducts(products: BlueprintProduct[]): BlueprintProduct[] {
        return products.filter((p) => this.isPlaceholder(p.name));
    }

    /**
     * Fix placeholder categories by sending them to AI
     */
    async fixPlaceholderCategories(
        blueprint: HydratedBlueprint,
        placeholderCategories: BlueprintCategory[]
    ): Promise<BlueprintCategory[]> {
        if (placeholderCategories.length === 0) {
            return blueprint.categories;
        }

        logger.info(`Fixing ${placeholderCategories.length} placeholder categories...`);

        // Deduplicate by ID
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
                this.textProvider.generateCompletion(
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

            // Try to extract JSON if wrapped in markdown
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

            // Apply fixes to the category tree
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
            logger.error("Failed to fix placeholder categories", error);
            throw error;
        }
    }

    /**
     * Fix placeholder products by sending them to AI in batches
     * Uses a simplified schema that just fixes names and descriptions
     */
    async fixPlaceholderProducts(
        blueprint: HydratedBlueprint,
        placeholderProducts: BlueprintProduct[]
    ): Promise<BlueprintProduct[]> {
        if (placeholderProducts.length === 0) {
            return blueprint.products;
        }

        logger.info(`Fixing ${placeholderProducts.length} placeholder products...`);

        // Group products by their category for context
        const categoryMap = new Map<string, BlueprintCategory>();
        const flatCats = this.flattenCategories(blueprint.categories);
        for (const cat of flatCats) {
            categoryMap.set(cat.id, cat);
        }

        // Simplified schema for fixing - just names and descriptions
        const SimpleProductSchema = z.object({
            products: z.array(
                z.object({
                    id: z.string(),
                    name: z.string(),
                    description: z.string().optional().default(""),
                })
            ),
        });

        // Process in batches of 10 to avoid token limits
        const BATCH_SIZE = 10;
        const batches: BlueprintProduct[][] = [];
        for (let i = 0; i < placeholderProducts.length; i += BATCH_SIZE) {
            batches.push(placeholderProducts.slice(i, i + BATCH_SIZE));
        }

        const allFixedProducts: Array<{ id: string; name: string; description: string }> = [];

        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
            const batch = batches[batchIdx];
            if (!batch) continue;

            logger.info(
                `Fixing product batch ${batchIdx + 1}/${batches.length} (${batch.length} products)...`
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
                    this.textProvider.generateCompletion(
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

                // Try to extract JSON if wrapped in markdown
                let jsonStr = responseText.trim();
                if (jsonStr.startsWith("```")) {
                    const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
                    if (match) {
                        jsonStr = match[1]?.trim() || jsonStr;
                    }
                }

                const parsed = JSON.parse(jsonStr);
                const validated = SimpleProductSchema.parse(parsed);
                allFixedProducts.push(...validated.products);
                logger.info(`  Batch ${batchIdx + 1}: Fixed ${validated.products.length} products`);
            } catch (error) {
                logger.error(`Failed to fix product batch ${batchIdx + 1}`, error);
                // Continue with other batches
            }
        }

        logger.info(`Fixed ${allFixedProducts.length} products total`);

        // Apply fixes to products (only name and description)
        const fixMap = new Map(allFixedProducts.map((p) => [p.id, p]));

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
    async fixPlaceholders(blueprint: HydratedBlueprint): Promise<HydratedBlueprint> {
        const placeholderCategories = this.findPlaceholderCategories(blueprint.categories);
        const placeholderProducts = this.findPlaceholderProducts(blueprint.products);

        logger.info(
            `Found ${placeholderCategories.length} placeholder categories and ${placeholderProducts.length} placeholder products`
        );

        if (placeholderCategories.length === 0 && placeholderProducts.length === 0) {
            logger.info("No placeholders to fix");
            return blueprint;
        }

        let fixedCategories = blueprint.categories;
        let fixedProducts = blueprint.products;

        if (placeholderCategories.length > 0) {
            fixedCategories = await this.fixPlaceholderCategories(blueprint, placeholderCategories);
        }

        if (placeholderProducts.length > 0) {
            fixedProducts = await this.fixPlaceholderProducts(
                { ...blueprint, categories: fixedCategories },
                placeholderProducts
            );
        }

        return {
            ...blueprint,
            categories: fixedCategories,
            products: fixedProducts,
            hydratedAt: new Date().toISOString(),
        };
    }
}
