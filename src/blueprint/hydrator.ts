/**
 * Blueprint Hydrator - Orchestrates filling a blueprint with AI-generated content
 *
 * Coordinates category, product, and CMS hydration phases.
 * Delegates actual AI calls to specialized hydrators.
 */

import type { InspirationData } from "../crawlers/types.js";
import type {
    Blueprint,
    BlueprintCategory,
    BlueprintProduct,
    HydratedBlueprint,
    TextProvider,
    VariantConfig,
    VariantSettings,
} from "../types/index.js";
import type { ExistingProperty } from "../utils/index.js";
import type { PropertyUpdate } from "./hydrators/product.js";

import { PropertyCache } from "../property-cache.js";
import { buildBaseImagePrompt, logger, toKebabCase } from "../utils/index.js";
import {
    findPlaceholderCategories,
    findPlaceholderProducts,
    fixPlaceholders as fixHydratedPlaceholders,
} from "./fix-placeholders.js";
import {
    applyCategoryHydration,
    flattenCategories,
    hydrateBrandColors,
    hydrateCategories,
    ProductHydrator,
} from "./hydrators/index.js";
import { groupProductsByBranch, productColorPreferences } from "./hydrators/product.js";
import { VariantResolver } from "./variant-resolver.js";
import {
    blueprintVariantSettings,
    productDefaultColor,
    productsMissingColors,
    repickVariantConfigs,
} from "./variant-settings.js";

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
        existingProperties: ExistingProperty[] = [],
        inspiration?: InspirationData
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

        // Step 1: Hydrate categories + brand colors in parallel
        // If inspiration provides real brand colors, skip the AI brand color call
        logger.info("  [1/3] Generating category names, descriptions, and brand colors...", {
            cli: true,
        });
        if (inspiration?.brandColors) {
            logger.info("  Using brand colors from inspiration (skipping AI call)", { cli: true });
        }
        logger.info("Hydrating categories + brand colors...");
        const [hydratedCategories, brandColors] = await Promise.all([
            hydrateCategories(
                this.textProvider,
                blueprint.salesChannel.name,
                blueprint.salesChannel.description,
                blueprint.categories,
                inspiration
            ),
            inspiration?.brandColors
                ? Promise.resolve(inspiration.brandColors)
                : hydrateBrandColors(
                      this.textProvider,
                      blueprint.salesChannel.name,
                      blueprint.salesChannel.description
                  ),
        ]);
        logger.info("Categories hydrated", {
            data: { count: hydratedCategories.categories.length },
        });

        // Step 2: Hydrate products
        logger.info("  [2/3] Generating product content...", { cli: true });
        logger.info("Hydrating products...");
        const productHydrator = this.createProductHydrator(
            blueprintVariantSettings(blueprint),
            inspiration
        );
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
            brandColors,
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

        const settings = blueprintVariantSettings(existingBlueprint);
        const run: PropertyRun = {
            productHydrator: this.createProductHydrator(settings),
            variantResolver: new VariantResolver(this.textProvider, this.propertyCache, settings),
            existingProperties,
            storeContext: {
                name: existingBlueprint.salesChannel.name,
                description: existingBlueprint.salesChannel.description,
            },
        };
        const categoryNames = new Map(
            flattenCategories(existingBlueprint.categories).map((c) => [c.id, c.name])
        );

        // Branches run one after the other: each one is a single AI call
        const products: BlueprintProduct[] = [];
        for (const [branchId, branchProducts] of groupProductsByBranch(
            existingBlueprint.products
        )) {
            const branchName = categoryNames.get(branchId) || "Unknown";
            products.push(...(await updateBranchProperties(branchProducts, branchName, run)));
        }

        logger.info("  Properties hydrated successfully (names preserved)", { cli: true });
        logger.info("Properties-only hydration complete");
        return { ...existingBlueprint, products, hydratedAt: new Date().toISOString() };
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

    /**
     * Re-pick the variant options of an existing hydrated blueprint for new settings.
     * Keeps names, properties and images. Only products that need more colours than they
     * have cost an AI call (one per 25 products); everything else comes from the cache.
     */
    async hydrateVariantsOnly(
        existingBlueprint: HydratedBlueprint,
        settings: VariantSettings
    ): Promise<HydratedBlueprint> {
        const storeSlug = toKebabCase(existingBlueprint.salesChannel.name);
        this.propertyCache = PropertyCache.forStore(this.cacheDir, storeSlug);
        this.propertyCache.ensureDefaults();

        const variantProducts = existingBlueprint.products.filter(
            (p) => p.metadata.isVariant && (p.metadata.variantConfigs?.length ?? 0) > 0
        );
        const aiColors = await this.fetchMissingVariantColors(
            existingBlueprint,
            variantProducts,
            settings
        );

        const poolFor = (group: string): string[] =>
            this.propertyCache.get(this.propertyCache.resolveGroupName(group))?.options ?? [];

        const products = existingBlueprint.products.map((product) => {
            const configs = product.metadata.variantConfigs;
            if (!product.metadata.isVariant || !configs || configs.length === 0) return product;
            const variantConfigs = repickVariantConfigs({
                productId: product.id,
                configs,
                settings,
                poolFor,
                defaultColor: productDefaultColor(product),
                extraColors: aiColors.get(product.id) ?? [],
            });
            return { ...product, metadata: { ...product.metadata, variantConfigs } };
        });

        const skipped = existingBlueprint.products.filter(
            (p) => p.metadata.isVariant && (p.metadata.variantConfigs?.length ?? 0) === 0
        ).length;
        if (skipped > 0) {
            logger.warn(
                `  ${skipped} variant product(s) have no variant groups yet; run --only=properties to add them`,
                { cli: true }
            );
        }

        logger.info(`  Variant options re-picked for ${variantProducts.length} products`, {
            cli: true,
        });
        return {
            ...existingBlueprint,
            variants: { ...settings },
            products,
            hydratedAt: new Date().toISOString(),
        };
    }

    /** Ask the AI for colours of products that need more than they have (empty on failure) */
    private async fetchMissingVariantColors(
        blueprint: HydratedBlueprint,
        variantProducts: BlueprintProduct[],
        settings: VariantSettings
    ): Promise<Map<string, string[]>> {
        const requests = productsMissingColors(variantProducts, settings).map((p) => ({
            id: p.id,
            name: p.name,
            color: productDefaultColor(p),
        }));
        if (requests.length === 0) return new Map();

        logger.info(`  Choosing more colours for ${requests.length} products...`, { cli: true });
        try {
            return await this.createProductHydrator(settings).hydrateVariantColors(requests, {
                name: blueprint.salesChannel.name,
                description: blueprint.salesChannel.description,
            });
        } catch (error) {
            logger.warn("  Colour choice failed, topping up from known colours instead", {
                cli: true,
                data: error,
            });
            return new Map();
        }
    }

    private createProductHydrator(
        settings: VariantSettings,
        inspiration?: InspirationData
    ): ProductHydrator {
        const variantResolver = new VariantResolver(
            this.textProvider,
            this.propertyCache,
            settings
        );
        return new ProductHydrator(
            this.textProvider,
            this.propertyCache,
            variantResolver,
            buildBaseImagePrompt,
            inspiration,
            settings
        );
    }
}

/** Shared state of one hydratePropertiesOnly() run */
interface PropertyRun {
    productHydrator: ProductHydrator;
    variantResolver: VariantResolver;
    existingProperties: ExistingProperty[];
    storeContext: StoreContext;
}

/** New properties for one branch; products the AI left out stay unchanged */
async function updateBranchProperties(
    products: BlueprintProduct[],
    branchName: string,
    run: PropertyRun
): Promise<BlueprintProduct[]> {
    logger.info(`  Processing ${branchName} (${products.length} products)...`);
    const updates = await run.productHydrator.hydratePropertiesForBranch(
        products,
        branchName,
        run.existingProperties,
        run.storeContext
    );

    const updated: BlueprintProduct[] = [];
    for (const product of products) {
        const update = updates.get(product.id);
        updated.push(
            update ? await applyPropertyUpdate(product, update, branchName, run) : product
        );
    }
    return updated;
}

async function applyPropertyUpdate(
    product: BlueprintProduct,
    update: PropertyUpdate,
    branchName: string,
    run: PropertyRun
): Promise<BlueprintProduct> {
    const variantConfigs = await resolveUpdatedVariants(product, update, branchName, run);
    return {
        ...product,
        metadata: {
            ...product.metadata,
            properties: update.properties,
            variantConfigs:
                variantConfigs && variantConfigs.length > 0 ? variantConfigs : undefined,
        },
    };
}

/** New variant configs for variant products with suggested groups, else the existing ones */
async function resolveUpdatedVariants(
    product: BlueprintProduct,
    update: PropertyUpdate,
    branchName: string,
    run: PropertyRun
): Promise<VariantConfig[] | undefined> {
    const groups = update.suggestedVariantGroups ?? [];
    if (!product.metadata.isVariant || groups.length === 0) return product.metadata.variantConfigs;

    return run.variantResolver.resolveVariantConfigs(groups, {
        name: product.name,
        category: branchName,
        productId: product.id,
        colors: productColorPreferences(update.properties, update.variantColors),
    });
}

/** The product's default colour: stored default, else its own Color, else the first colour variant */
