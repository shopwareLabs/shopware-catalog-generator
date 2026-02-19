/**
 * Blueprint Hydrator - Orchestrates filling a blueprint with AI-generated content
 *
 * Coordinates category, product, and CMS hydration phases.
 * Delegates actual AI calls to specialized hydrators.
 */

import type {
    Blueprint,
    BlueprintCategory,
    BlueprintProduct,
    HydratedBlueprint,
    ProductProperty,
    TextProvider,
} from "../types/index.js";
import type { ExistingProperty } from "../utils/index.js";

import { PropertyCache } from "../property-cache.js";
import { findClosestColor, logger, toKebabCase } from "../utils/index.js";
import {
    findPlaceholderCategories,
    findPlaceholderProducts,
    fixPlaceholders as fixHydratedPlaceholders,
} from "./fix-placeholders.js";
import { applyCategoryHydration, hydrateCategories, ProductHydrator } from "./hydrators/index.js";
import { VariantResolver } from "./variant-resolver.js";

/** Store context passed through hydration methods */
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
        this.propertyCache = new PropertyCache(cacheDir);
        this.propertyCache.ensureDefaults();
    }

    /**
     * Hydrate a blueprint with AI-generated content
     */
    async hydrate(
        blueprint: Blueprint,
        existingProperties: ExistingProperty[] = []
    ): Promise<HydratedBlueprint> {
        logger.info("Hydrating blueprint with AI...", { cli: true });
        logger.info("Starting blueprint hydration", {
            data: {
                salesChannel: blueprint.salesChannel.name,
                categories: blueprint.categories.length,
                products: blueprint.products.length,
                existingProperties: existingProperties.length,
            },
        });

        const storeSlug = toKebabCase(blueprint.salesChannel.name);
        this.propertyCache = PropertyCache.forStore(this.cacheDir, storeSlug);
        this.propertyCache.ensureDefaults();

        const storeContext: StoreContext = {
            name: blueprint.salesChannel.name,
            description: blueprint.salesChannel.description,
        };

        // Step 1: Hydrate categories
        logger.info("  [1/2] Generating category names and descriptions...", { cli: true });
        logger.info("Hydrating categories...");
        const hydratedCategories = await hydrateCategories(
            this.textProvider,
            blueprint.salesChannel.name,
            blueprint.salesChannel.description,
            blueprint.categories
        );
        logger.info("Categories hydrated", {
            data: { count: hydratedCategories.categories.length },
        });

        // Step 2: Hydrate products
        logger.info("  [2/2] Generating product content...", { cli: true });
        logger.info("Hydrating products...");
        const productHydrator = this.createProductHydrator();
        productHydrator.clearBatchCounter();
        const hydratedProducts = await productHydrator.hydrateProducts(
            blueprint.products,
            hydratedCategories.categories,
            blueprint.categories,
            existingProperties,
            storeContext
        );
        logger.info("Products hydrated", { data: { count: hydratedProducts.length } });

        const hydrated: HydratedBlueprint = {
            ...blueprint,
            salesChannel: {
                ...blueprint.salesChannel,
                description: hydratedCategories.salesChannelDescription,
            },
            categories: applyCategoryHydration(blueprint.categories, hydratedCategories.categories),
            products: hydratedProducts,
            propertyGroups: [],
            hydratedAt: new Date().toISOString(),
        };

        logger.info("  Blueprint hydrated successfully", { cli: true });
        logger.info("Blueprint hydration complete");
        return hydrated;
    }

    /**
     * Hydrate only categories in an existing hydrated blueprint.
     * Preserves all product data unchanged.
     */
    async hydrateCategoriesOnly(existingBlueprint: HydratedBlueprint): Promise<HydratedBlueprint> {
        logger.info("Hydrating categories only (preserving product data)...");
        logger.info("Starting categories-only hydration", {
            data: {
                salesChannel: existingBlueprint.salesChannel.name,
                categories: existingBlueprint.categories.length,
                products: existingBlueprint.products.length,
            },
        });

        logger.info("  Generating category names and descriptions...", { cli: true });
        const hydratedCategories = await hydrateCategories(
            this.textProvider,
            existingBlueprint.salesChannel.name,
            existingBlueprint.salesChannel.description,
            existingBlueprint.categories
        );
        logger.info("Categories hydrated", {
            data: { count: hydratedCategories.categories.length },
        });

        const hydrated: HydratedBlueprint = {
            ...existingBlueprint,
            salesChannel: {
                ...existingBlueprint.salesChannel,
                description: hydratedCategories.salesChannelDescription,
            },
            categories: applyCategoryHydration(
                existingBlueprint.categories,
                hydratedCategories.categories
            ),
            products: existingBlueprint.products,
            propertyGroups: existingBlueprint.propertyGroups,
            hydratedAt: new Date().toISOString(),
        };

        logger.info("  Categories hydrated successfully (products preserved)", { cli: true });
        logger.info("Categories-only hydration complete");
        return hydrated;
    }

    /**
     * Hydrate only product properties in an existing hydrated blueprint.
     * Preserves product names, descriptions, and image prompts.
     */
    async hydratePropertiesOnly(
        existingBlueprint: HydratedBlueprint,
        existingProperties: ExistingProperty[] = []
    ): Promise<HydratedBlueprint> {
        logger.info("Hydrating properties only (preserving product names)...");
        logger.info("Starting properties-only hydration", {
            data: {
                salesChannel: existingBlueprint.salesChannel.name,
                products: existingBlueprint.products.length,
            },
        });

        const storeSlug = toKebabCase(existingBlueprint.salesChannel.name);
        this.propertyCache = PropertyCache.forStore(this.cacheDir, storeSlug);
        this.propertyCache.ensureDefaults();

        const storeContext: StoreContext = {
            name: existingBlueprint.salesChannel.name,
            description: existingBlueprint.salesChannel.description,
        };

        const productsByBranch = new Map<string, BlueprintProduct[]>();
        for (const product of existingBlueprint.products) {
            const branch = product.primaryCategoryId;
            const existing = productsByBranch.get(branch);
            if (existing) {
                existing.push(product);
            } else {
                productsByBranch.set(branch, [product]);
            }
        }

        const categoryNameMap = new Map<string, string>();
        const flatCats = (cats: BlueprintCategory[]): void => {
            for (const cat of cats) {
                categoryNameMap.set(cat.id, cat.name);
                if (cat.children.length > 0) flatCats(cat.children);
            }
        };
        flatCats(existingBlueprint.categories);

        const productHydrator = this.createProductHydrator();
        const variantResolver = new VariantResolver(this.textProvider, this.propertyCache);

        const updatedProducts: BlueprintProduct[] = [];
        const branches = Array.from(productsByBranch.entries());

        for (const [branchId, branchProducts] of branches) {
            const branchName = categoryNameMap.get(branchId) || "Unknown";
            logger.info(`  Processing ${branchName} (${branchProducts.length} products)...`);

            const propertyUpdates = await productHydrator.hydratePropertiesForBranch(
                branchProducts,
                branchName,
                existingProperties,
                storeContext
            );

            for (const product of branchProducts) {
                const update = propertyUpdates.get(product.id);
                if (update) {
                    let variantConfigs = product.metadata.variantConfigs;
                    if (update.suggestedVariantGroups && update.suggestedVariantGroups.length > 0) {
                        variantConfigs = await variantResolver.resolveVariantConfigs(
                            update.suggestedVariantGroups,
                            { name: product.name, category: branchName }
                        );
                    }

                    updatedProducts.push({
                        ...product,
                        metadata: {
                            ...product.metadata,
                            properties: update.properties as ProductProperty[],
                            variantConfigs:
                                variantConfigs && variantConfigs.length > 0
                                    ? variantConfigs
                                    : undefined,
                        },
                    });
                } else {
                    updatedProducts.push(product);
                }
            }
        }

        const hydrated: HydratedBlueprint = {
            ...existingBlueprint,
            products: updatedProducts,
            hydratedAt: new Date().toISOString(),
        };

        logger.info("  Properties hydrated successfully (names preserved)", { cli: true });
        logger.info("Properties-only hydration complete");
        return hydrated;
    }

    /**
     * Find all categories with placeholder names
     */
    findPlaceholderCategories(categories: BlueprintCategory[]): BlueprintCategory[] {
        return findPlaceholderCategories(categories);
    }

    /**
     * Find all products with placeholder names
     */
    findPlaceholderProducts(products: BlueprintProduct[]): BlueprintProduct[] {
        return findPlaceholderProducts(products);
    }

    /**
     * Fix all placeholders in a hydrated blueprint
     */
    async fixPlaceholders(blueprint: HydratedBlueprint): Promise<HydratedBlueprint> {
        return fixHydratedPlaceholders(this.textProvider, blueprint);
    }

    private createProductHydrator(): ProductHydrator {
        const variantResolver = new VariantResolver(this.textProvider, this.propertyCache);
        return new ProductHydrator(
            this.textProvider,
            this.propertyCache,
            variantResolver,
            (name, props) => this.generateBaseImagePrompt(name, props)
        );
    }

    /**
     * Generate a consistent base image prompt from product name and properties
     */
    private generateBaseImagePrompt(
        productName: string,
        properties: Array<{ group: string; value: string }>
    ): string {
        const material = properties.find((p) => p.group.toLowerCase() === "material")?.value;
        const color = properties.find((p) => p.group.toLowerCase() === "color")?.value;
        const style = properties.find((p) => p.group.toLowerCase() === "style")?.value;

        let basePrompt = productName;

        if (material && !productName.toLowerCase().includes(material.toLowerCase())) {
            basePrompt += `, ${material} construction`;
        }

        if (color) {
            const colorMatch = findClosestColor(color);
            const colorName = colorMatch?.name ?? color;
            if (!productName.toLowerCase().includes(color.toLowerCase())) {
                basePrompt += `, ${colorName} finish`;
            }
        }

        if (style && !productName.toLowerCase().includes(style.toLowerCase())) {
            basePrompt += `, ${style} design`;
        }

        return basePrompt;
    }
}
