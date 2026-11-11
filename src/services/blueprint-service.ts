/**
 * Blueprint Service - shared application logic for blueprint create/hydrate/fix commands.
 *
 * Returns string[] (output lines) so both CLI (prints) and MCP (joins) can consume it.
 * Never calls console.log directly.
 */

import type { EstimateBlueprint, VariantSettingOverrides } from "../blueprint/index.js";
import type { DataCache } from "../cache.js";
import type {
    Blueprint,
    CostEstimate,
    HydratedBlueprint,
    HydrationScope,
    ImageProvider,
    ModelSelection,
    PendingImageCounts,
    TextProvider,
    VariantSettings,
} from "../types/index.js";
import type { ExistingProperty } from "../utils/index.js";
import type { ShopwareConnection } from "./shopware-context.js";

import {
    applyColorSystem,
    BlueprintGenerator,
    BlueprintHydrator,
    blueprintVariantSettings,
    collectShadeNames,
    buildCmsImageSpecs,
    buildThemeImageSpecs,
    countCmsTextWork,
    estimateHydrationCost,
    flattenCategories,
    formatCostEstimate,
    formatVariantSettings,
    generateCmsBlueprint,
    hydrateCmsBlueprint,
    hydrateCmsImages,
    hydrateColorShades,
    hydrateProductImages,
    hydrateThemeMedia,
    hydrateVariantImages,
    NO_EDIT_SUPPORT_WARNING,
    countVariantImages,
    normalizeProductColors,
    planVariantImages,
    resolveVariantImageViews,
    priceTokenUsage,
    resolveVariantSettings,
    VariantSettingsError,
} from "../blueprint/index.js";
import { cacheFileForDisplay, createCacheFromEnv } from "../cache.js";
import {
    createProvidersFromEnv,
    imagesEnabled,
    providerConfigFromEnv,
    resolveModelSelection,
} from "../providers/index.js";
import { countCategories, logger, PropertyCollector } from "../utils/index.js";
import { connectShopware, shopwareConnectionFromEnv } from "./shopware-context.js";
import { buildGenerationStep } from "./template-service.js";

/**
 * Resolve variant settings for a new blueprint (flag beats env var beats default).
 * Returns an "Error: ..." line for an invalid value.
 */
export function resolveNewVariantSettings(
    overrides: VariantSettingOverrides = {}
): VariantSettings | string {
    try {
        return resolveVariantSettings(overrides);
    } catch (error) {
        if (error instanceof VariantSettingsError) return `Error: ${error.message}`;
        throw error;
    }
}

export async function createBlueprint(
    salesChannelName: string,
    description: string,
    products: number,
    variantOverrides: VariantSettingOverrides = {}
): Promise<string[]> {
    const variants = resolveNewVariantSettings(variantOverrides);
    if (typeof variants === "string") return [variants];

    const maxProductsPerBranch = parseInt(process.env.PRODUCTS_PER_CATEGORY || "30", 10);
    const topLevelCategories = Math.max(1, Math.ceil(products / maxProductsPerBranch));
    const productsPerBranch = Math.ceil(products / topLevelCategories);

    const cache = createCacheFromEnv();

    const generator = new BlueprintGenerator({
        totalProducts: products,
        topLevelCategories,
        productsPerBranch,
        variants,
    });

    const blueprint = generator.generateBlueprint(salesChannelName, description);
    cache.saveBlueprint(salesChannelName, blueprint);

    const categoryCount = countCategories(blueprint.categories);
    return [
        `=== Blueprint Create ===`,
        `Name: ${salesChannelName}`,
        `Description: ${description}`,
        `Products: ${products} (${topLevelCategories} categories)`,
        `Variants: ${formatVariantSettings(variants)}`,
        ``,
        `Blueprint created:`,
        `  Categories: ${categoryCount}`,
        `  Products: ${blueprint.products.length}`,
        `  Saved to: ${cacheFileForDisplay(cache, salesChannelName, "blueprint.json")}`,
    ];
}

/** Selective hydration modes of `blueprint hydrate --only` (shared with CLI and MCP) */
export const HYDRATE_ONLY_MODES = [
    "categories",
    "properties",
    "cms",
    "variants",
    "variant-images",
    "prices",
    "names",
    "manufacturers",
] as const;

export type HydrateOnly = (typeof HYDRATE_ONLY_MODES)[number];

/** Modes that only work on an existing hydrated blueprint (no fallback to a full run) */
const NEEDS_HYDRATED: readonly HydrateOnly[] = [
    "variants",
    "variant-images",
    "prices",
    "names",
    "manufacturers",
];

/** Options shared by hydrate and estimate */
interface HydrateRunOptions {
    only?: HydrateOnly;
    /** Shopware to read existing property groups from (default: SW_ENV_URL integration) */
    connection?: ShopwareConnection;
    /** Variant setting overrides, only for --only=variants */
    variants?: VariantSettingOverrides;
}

/**
 * Variant settings for a hydration run. Overrides only apply to --only=variants, and the
 * share cannot change there (it decides which products have variants, set at create).
 * Returns an "Error: ..." line for an invalid combination or value.
 */
function resolveRunVariantSettings(
    options: HydrateRunOptions,
    stored: VariantSettings
): VariantSettings | string {
    const overrides = options.variants ?? {};
    const hasOverrides = Object.values(overrides).some((v) => v !== undefined);
    if (options.only !== "variants") {
        if (hasOverrides) {
            return (
                `Error: Variant settings can only change with --only=variants ` +
                `(or at blueprint create).`
            );
        }
        return stored;
    }
    if (overrides.share !== undefined) {
        return (
            `Error: --variant-share can only be set at blueprint create, ` +
            `because it decides which products have variants.`
        );
    }
    try {
        return { ...resolveVariantSettings(overrides, process.env, stored), share: stored.share };
    } catch (error) {
        if (error instanceof VariantSettingsError) return `Error: ${error.message}`;
        throw error;
    }
}

function missingHydratedFor(only: HydrateOnly, salesChannelName: string): string[] {
    return [
        `Error: --only=${only} needs a hydrated blueprint for "${salesChannelName}". ` +
            `Run: blueprint hydrate --name=${salesChannelName}`,
    ];
}

/** Everything a hydrate or estimate run needs, after validating mode and variant settings */
interface HydrationPlan {
    salesChannelName: string;
    cache: DataCache;
    blueprint: Blueprint;
    /** The hydrated blueprint from a previous run, if any */
    hydrated: HydratedBlueprint | null;
    only?: HydrateOnly;
    variantSettings: VariantSettings;
    estimate: CostEstimate;
}

/**
 * Load the blueprints, check the mode and variant settings and forecast the cost.
 * Returns "Error: ..." lines when the run cannot start. Shared by hydrate and estimate,
 * so both always agree on what a run does.
 */
function planHydration(
    salesChannelName: string,
    options: HydrateRunOptions,
    cache: DataCache
): HydrationPlan | string[] {
    const hydrated = cache.loadHydratedBlueprint(salesChannelName);
    const blueprint = cache.loadBlueprint(salesChannelName);
    if (!blueprint) {
        return [
            `Error: No blueprint found for "${salesChannelName}". ` +
                `Run: blueprint create --name=${salesChannelName}`,
        ];
    }
    if (options.only && NEEDS_HYDRATED.includes(options.only) && !hydrated) {
        return missingHydratedFor(options.only, salesChannelName);
    }
    const variantSettings = resolveRunVariantSettings(
        options,
        blueprintVariantSettings(hydrated ?? blueprint)
    );
    if (typeof variantSettings === "string") return [variantSettings];

    const scope = resolveHydrationScope(options.only, Boolean(hydrated));
    const source = scope === "full" || !hydrated ? blueprint : hydrated;
    const estimate = buildCostEstimate(cache, salesChannelName, scope, source, variantSettings);
    return {
        salesChannelName,
        cache,
        blueprint,
        hydrated,
        only: options.only,
        variantSettings,
        estimate,
    };
}

/**
 * Forecast the cost of `blueprint hydrate` without making any AI call.
 */
export function estimateBlueprintCost(
    salesChannelName: string,
    options: HydrateRunOptions,
    cache: DataCache = createCacheFromEnv()
): string[] {
    const plan = planHydration(salesChannelName, options, cache);
    if (Array.isArray(plan)) return plan;
    return formatCostEstimate(plan.estimate);
}

/** Mirrors hydrateBlueprint: --only=categories/properties fall back to full without a hydrated blueprint */
function resolveHydrationScope(
    only: HydrateOnly | undefined,
    hasHydrated: boolean
): HydrationScope {
    if (only === "cms") return "cms";
    if (only && hasHydrated) return only;
    return "full";
}

function buildCostEstimate(
    cache: DataCache,
    salesChannelName: string,
    scope: HydrationScope,
    blueprint: EstimateBlueprint & { salesChannel: { description: string } },
    variants: VariantSettings
): CostEstimate {
    const selection = resolveModelSelection(providerConfigFromEnv());
    const description = blueprint.salesChannel.description || `${salesChannelName} webshop`;
    return estimateHydrationCost({
        scope,
        blueprint,
        selection,
        cms: countCmsTextWork(generateCmsBlueprint(salesChannelName)),
        pendingImages: countPendingImages(cache, salesChannelName, blueprint, description, {
            scope,
            variants,
            canEditImages: selection.imageProvider === "openai",
        }),
        hasInspirationColors: Boolean(cache.loadInspiration(salesChannelName)?.brandColors),
        variants,
    });
}

/**
 * CMS and theme images are skipped when cached. Product and category images are
 * counted in full: a full hydration renames products, which makes cached images stale.
 * Colour images are counted in full for a full run, and without fresh cached ones for
 * --only=variant-images. They are 0 when the image provider cannot edit images.
 */
function countPendingImages(
    cache: DataCache,
    salesChannelName: string,
    blueprint: EstimateBlueprint,
    description: string,
    run: { scope: HydrationScope; variants: VariantSettings; canEditImages: boolean }
): PendingImageCounts {
    const isMissing =
        (mediaType: "cms_media" | "theme_media") =>
        (spec: { key: string }): boolean =>
            !cache.images.hasImageForSalesChannel(salesChannelName, spec.key, mediaType);

    return {
        cms: buildCmsImageSpecs(salesChannelName, description).filter(isMissing("cms_media"))
            .length,
        theme: buildThemeImageSpecs(salesChannelName, description).filter(isMissing("theme_media"))
            .length,
        product: blueprint.products.reduce(
            (acc, p) => acc + (p.metadata.imageDescriptions?.length ?? 0),
            0
        ),
        category: flattenCategories(blueprint.categories).filter((c) => c.hasImage).length,
        variantColor: run.canEditImages
            ? countPendingVariantImages(cache, salesChannelName, blueprint, run)
            : 0,
    };
}

function countPendingVariantImages(
    cache: DataCache,
    salesChannelName: string,
    blueprint: EstimateBlueprint,
    run: { scope: HydrationScope; variants: VariantSettings }
): number {
    const views = resolveVariantImageViews(process.env);
    if (run.scope === "variant-images") {
        return planVariantImages(cache, salesChannelName, blueprint, views).pending.length;
    }
    return countVariantImages(blueprint, run.variants, views);
}

/** Report actual token usage and cost when the text provider tracks it */
export function formatActualUsage(textProvider: TextProvider, selection: ModelSelection): string[] {
    const usage = textProvider.getUsage?.();
    if (!usage || usage.calls === 0) return [];

    const usd = priceTokenUsage(selection, usage);
    const cost = usd === null ? "unknown (no price data)" : `$${usd.toFixed(2)}`;
    return [
        ``,
        `Actual text usage: ${usage.calls} calls, ${usage.inputTokens} input + ${usage.outputTokens} output tokens ` +
            `(${usage.reasoningTokens} reasoning) -> ${cost}`,
    ];
}

/**
 * --only=variant-images: recolour the cached parent images for every colour variant.
 * Text, names and the hydrated blueprint stay untouched.
 */
async function hydrateVariantImagesOnly(
    salesChannelName: string,
    cache: DataCache,
    imageProvider: ImageProvider,
    hydrated: HydratedBlueprint,
    selection: ModelSelection
): Promise<string[]> {
    const header = [`=== Blueprint Hydrate (variant-images only) ===`, `Name: ${salesChannelName}`];
    if (!imagesEnabled(imageProvider)) {
        return [...header, ``, `Images are disabled (IMAGE_PROVIDER=none), nothing to do.`];
    }

    const result = await hydrateVariantImages(imageProvider, cache, salesChannelName, hydrated);
    if (!result.supported) {
        return [...header, ``, `Skipped: ${NO_EDIT_SUPPORT_WARNING}`];
    }
    cache.recordGenerationStep(
        salesChannelName,
        "hydrate:variant-images",
        buildGenerationStep(selection, true)
    );

    return [
        ...header,
        ``,
        `Colour images:`,
        `  Generated: ${result.generated}`,
        `  Cached: ${result.skipped}`,
        `  Stale (regenerated): ${result.stale}`,
        `  Failed: ${result.failed}`,
        ...(result.missingSource > 0
            ? [`  Skipped (parent image missing): ${result.missingSource}`]
            : []),
    ];
}

interface HydrationProviders {
    text: TextProvider;
    image: ImageProvider;
}

/** Injectable dependencies of hydrateBlueprint (tests); defaults come from the environment */
export interface HydrateDeps {
    cache?: DataCache;
    providers?: HydrationProviders;
    /** Existing Shopware property groups, reused for property names and options */
    loadExistingProperties?: () => Promise<ExistingProperty[]>;
}

export async function hydrateBlueprint(
    salesChannelName: string,
    options: HydrateRunOptions & { force?: boolean },
    deps: HydrateDeps = {}
): Promise<string[]> {
    logger.configure({ minLevel: "debug" });
    const cache = deps.cache ?? createCacheFromEnv();

    if (cache.loadHydratedBlueprint(salesChannelName) && !options.only && !options.force) {
        return [
            `Error: Hydrated blueprint already exists for "${salesChannelName}". ` +
                `Re-hydrating will change product names and trigger image regeneration. ` +
                `Use --only=categories, --only=properties, --only=variants, --only=prices, --only=names, --only=manufacturers, or --rehydrate.`,
        ];
    }
    const plan = planHydration(salesChannelName, options, cache);
    if (Array.isArray(plan)) return plan;

    for (const line of formatCostEstimate(plan.estimate)) {
        logger.info(line, { cli: true });
    }
    const providers = deps.providers ?? createProvidersFromEnv();

    if (plan.only === "cms") return hydrateCmsOnly(plan, providers);
    if (plan.only === "variant-images" && plan.hydrated) {
        return hydrateVariantImagesOnly(
            salesChannelName,
            cache,
            providers.image,
            plan.hydrated,
            plan.estimate.selection
        );
    }

    const loadProperties =
        deps.loadExistingProperties ?? (() => loadExistingProperties(options.connection));
    const existingProperties = await loadProperties();
    const hydrated = await hydrateCatalogText(plan, providers.text, existingProperties);
    if (!plan.only) await hydrateCatalogMedia(plan, providers, hydrated);

    await finalizeHydratedBlueprint(
        providers,
        cache,
        salesChannelName,
        hydrated,
        existingProperties,
        { variantImages: !plan.only }
    );
    cache.saveHydratedBlueprint(salesChannelName, hydrated);
    cache.recordGenerationStep(
        salesChannelName,
        plan.only ? `hydrate:${plan.only}` : "hydrate",
        buildGenerationStep(plan.estimate.selection, !plan.only && imagesEnabled(providers.image))
    );
    return formatHydrateResult(plan, hydrated, providers.text, Boolean(options.force));
}

/** Existing property groups from Shopware; none when Shopware is not configured or unreachable */
async function loadExistingProperties(
    connection: ShopwareConnection | undefined
): Promise<ExistingProperty[]> {
    try {
        const resolved = connection ?? shopwareConnectionFromEnv();
        if (!resolved) return [];
        const dataHydrator = await connectShopware(resolved);
        return await dataHydrator.getExistingPropertyGroups();
    } catch {
        return [];
    }
}

/** Generate and save the CMS texts and images for the store description */
async function hydrateCmsContent(
    plan: HydrationPlan,
    providers: HydrationProviders,
    description: string
): Promise<number> {
    const { cache, salesChannelName } = plan;
    const cmsBlueprint = generateCmsBlueprint(salesChannelName);
    const hydratedCms = await hydrateCmsBlueprint(cmsBlueprint, providers.text, description);
    cache.saveCmsBlueprint(salesChannelName, hydratedCms);
    await hydrateCmsImages(providers.image, cache, salesChannelName, description);
    return hydratedCms.pages.length;
}

/** --only=cms: CMS texts and images, the catalog stays untouched */
async function hydrateCmsOnly(
    plan: HydrationPlan,
    providers: HydrationProviders
): Promise<string[]> {
    const { cache, salesChannelName, estimate } = plan;
    const description = resolveCmsStoreDescription(
        salesChannelName,
        plan.blueprint.salesChannel.description,
        plan.hydrated?.salesChannel.description
    );
    const pages = await hydrateCmsContent(plan, providers, description);
    cache.recordGenerationStep(
        salesChannelName,
        "hydrate:cms",
        buildGenerationStep(estimate.selection, imagesEnabled(providers.image))
    );

    return [
        `=== Blueprint Hydrate (cms only) ===`,
        `Name: ${salesChannelName}`,
        ``,
        `CMS blueprint hydrated:`,
        `  Pages: ${pages}`,
        `  Saved to: ${cacheFileForDisplay(cache, salesChannelName, "cms-blueprint.json")}`,
        ...formatActualUsage(providers.text, estimate.selection),
    ];
}

/** Re-pick variant options and keep blueprint.json in step for a later full re-hydration */
async function hydrateVariantsPass(
    plan: HydrationPlan,
    hydrator: BlueprintHydrator,
    hydrated: HydratedBlueprint
): Promise<HydratedBlueprint> {
    const result = await hydrator.hydrateVariantsOnly(hydrated, plan.variantSettings);
    plan.cache.saveBlueprint(plan.salesChannelName, {
        ...plan.blueprint,
        variants: { ...plan.variantSettings },
    });
    return result;
}

/** Selective pass on the existing hydrated blueprint; null when the mode has none */
function hydrateSelectivePass(
    plan: HydrationPlan,
    hydrator: BlueprintHydrator,
    hydrated: HydratedBlueprint,
    existingProperties: ExistingProperty[]
): Promise<HydratedBlueprint> | null {
    switch (plan.only) {
        case "categories":
            return hydrator.hydrateCategoriesOnly(hydrated);
        case "prices":
            return hydrator.hydratePricesOnly(hydrated);
        case "names":
            return hydrator.hydrateNamesOnly(hydrated);
        case "manufacturers":
            return hydrator.hydrateManufacturersOnly(hydrated);
        case "properties":
            return hydrator.hydratePropertiesOnly(hydrated, existingProperties);
        case "variants":
            return hydrateVariantsPass(plan, hydrator, hydrated);
        default:
            return null;
    }
}

/**
 * Catalog texts for the run: a selective pass on the existing hydrated blueprint, or a
 * full hydration. --only=categories/properties fall back to full without one.
 */
async function hydrateCatalogText(
    plan: HydrationPlan,
    textProvider: TextProvider,
    existingProperties: ExistingProperty[]
): Promise<HydratedBlueprint> {
    const { cache, salesChannelName, blueprint, hydrated } = plan;
    // Property cache next to the run cache (CACHE_DIR), not always ./generated
    const hydrator = new BlueprintHydrator(textProvider, cache.getCacheDir());

    const selective =
        hydrated && hydrateSelectivePass(plan, hydrator, hydrated, existingProperties);
    if (selective) return selective;

    const inspiration = cache.loadInspiration(salesChannelName) ?? undefined;
    if (inspiration) {
        logger.info(`  Using inspiration from ${inspiration.sourceUrl}`, { cli: true });
    }
    return hydrator.hydrate(blueprint, existingProperties, inspiration);
}

/** Full hydration only: CMS content, product and category images, theme media */
async function hydrateCatalogMedia(
    plan: HydrationPlan,
    providers: HydrationProviders,
    hydrated: HydratedBlueprint
): Promise<void> {
    const { cache, salesChannelName, blueprint } = plan;
    await hydrateCmsContent(
        plan,
        providers,
        resolveCmsStoreDescription(
            salesChannelName,
            blueprint.salesChannel.description,
            hydrated.salesChannel.description
        )
    );
    if (!imagesEnabled(providers.image)) return;

    await hydrateProductImages(providers.image, cache, salesChannelName, hydrated);
    const storeDescription =
        hydrated.salesChannel.description ||
        blueprint.salesChannel.description ||
        `${salesChannelName} webshop`;
    await hydrateThemeMedia(
        providers.image,
        cache,
        salesChannelName,
        storeDescription,
        hydrated.brandColors
    );
}

function hydrateModeLabel(only: HydrateOnly | undefined, force: boolean): string {
    if (only) return `${only} only`;
    return force ? "full (--rehydrate)" : "full";
}

function formatHydrateResult(
    plan: HydrationPlan,
    hydrated: HydratedBlueprint,
    textProvider: TextProvider,
    force: boolean
): string[] {
    const { cache, salesChannelName, only } = plan;
    const brandColors = hydrated.brandColors
        ? [`  Brand colors: ${hydrated.brandColors.primary} / ${hydrated.brandColors.secondary}`]
        : [];
    const variantImagesHint =
        only === "variants"
            ? [
                  ``,
                  `Colour images follow the new colours with: ` +
                      `blueprint hydrate --name=${salesChannelName} --only=variant-images`,
              ]
            : [];

    return [
        `=== Blueprint Hydrate ===`,
        `Name: ${salesChannelName}`,
        `Mode: ${hydrateModeLabel(only, force)}`,
        `Log file: ${logger.getLogFile()}`,
        ``,
        `Hydrated blueprint saved:`,
        `  Mode: ${only || "full"}`,
        `  Property groups: ${hydrated.propertyGroups.length}`,
        `  Manufacturers: ${new PropertyCollector().collectManufacturers(hydrated).length}`,
        `  Variants: ${formatVariantSettings(blueprintVariantSettings(hydrated))}`,
        ...brandColors,
        `  Saved to: ${cacheFileForDisplay(cache, salesChannelName, "hydrated-blueprint.json")}`,
        ...formatActualUsage(textProvider, plan.estimate.selection),
        ...variantImagesHint,
    ];
}

/**
 * Build the property groups of a hydrated blueprint, with the colour system:
 * normalise colour values, classify new shade names via AI (learned per store),
 * collect the groups, then add shade families and the "Color family" group.
 */
export async function buildPropertyGroups(
    textProvider: TextProvider,
    cache: DataCache,
    salesChannelName: string,
    blueprint: HydratedBlueprint,
    existingProperties: ExistingProperty[]
): Promise<void> {
    normalizeProductColors(blueprint);
    const learned = await hydrateColorShades(
        textProvider,
        collectShadeNames(blueprint),
        {
            name: blueprint.salesChannel.name || salesChannelName,
            description: blueprint.salesChannel.description || `${salesChannelName} webshop`,
        },
        cache.loadColorShades(salesChannelName)
    );
    cache.saveColorShades(salesChannelName, learned);

    blueprint.propertyGroups = new PropertyCollector().collectFromBlueprint(
        blueprint,
        existingProperties
    );
    applyColorSystem(blueprint, learned);
}

/**
 * Last hydration step: property groups with the colour system, then (full hydration
 * only) the colour variant images. The order matters: the colour system sets
 * `variantColors`, and the variant image pass plans its edits from them.
 */
export async function finalizeHydratedBlueprint(
    providers: { text: TextProvider; image: ImageProvider },
    cache: DataCache,
    salesChannelName: string,
    blueprint: HydratedBlueprint,
    existingProperties: ExistingProperty[],
    options: { variantImages: boolean }
): Promise<void> {
    await buildPropertyGroups(
        providers.text,
        cache,
        salesChannelName,
        blueprint,
        existingProperties
    );
    if (!options.variantImages || !imagesEnabled(providers.image)) return;
    await hydrateVariantImages(providers.image, cache, salesChannelName, blueprint);
}

export async function fixBlueprint(salesChannelName: string): Promise<string[]> {
    logger.configure({ minLevel: "debug" });

    const cache = createCacheFromEnv();
    const blueprint = cache.loadHydratedBlueprint(salesChannelName);

    if (!blueprint) {
        return [
            `Error: No hydrated blueprint found for "${salesChannelName}". ` +
                `Run: blueprint hydrate --name=${salesChannelName}`,
        ];
    }

    const { text: textProvider } = createProvidersFromEnv();
    // Property cache next to the run cache (CACHE_DIR), not always ./generated
    const hydrator = new BlueprintHydrator(textProvider, cache.getCacheDir());

    const placeholderCategories = hydrator.findPlaceholderCategories(blueprint.categories);
    const placeholderProducts = hydrator.findPlaceholderProducts(blueprint.products);

    if (placeholderCategories.length === 0 && placeholderProducts.length === 0) {
        return [
            `=== Blueprint Fix ===`,
            `Name: ${salesChannelName}`,
            ``,
            `No placeholders to fix. Blueprint is complete.`,
        ];
    }

    const fixedBlueprint = await hydrator.fixPlaceholders(blueprint);

    if (placeholderProducts.length > 0) {
        const existingProperties: ExistingProperty[] = blueprint.propertyGroups.map((pg) => ({
            id: pg.id,
            name: pg.name,
            displayType: pg.displayType || "text",
            options: pg.options.map((o) => ({
                id: o.id,
                name: o.name,
                colorHexCode: o.colorHexCode,
            })),
        }));
        await buildPropertyGroups(
            textProvider,
            cache,
            salesChannelName,
            fixedBlueprint,
            existingProperties
        );
    }

    cache.saveHydratedBlueprint(salesChannelName, fixedBlueprint);

    return [
        `=== Blueprint Fix ===`,
        `Name: ${salesChannelName}`,
        ``,
        `Fixed blueprint saved:`,
        `  Categories fixed: ${placeholderCategories.length}`,
        `  Products fixed: ${placeholderProducts.length}`,
        `  Saved to: ${cacheFileForDisplay(cache, salesChannelName, "hydrated-blueprint.json")}`,
    ];
}

export async function inspireBlueprint(url: string, salesChannelName: string): Promise<string[]> {
    const { crawlForInspiration } = await import("../crawlers/index.js");

    const cache = createCacheFromEnv();

    let inspiration;
    try {
        inspiration = await crawlForInspiration(url);
    } catch (error) {
        return [`Error: ${error instanceof Error ? error.message : String(error)}`];
    }

    cache.saveInspiration(salesChannelName, inspiration);

    const results = [
        `=== Blueprint Inspire ===`,
        `Name: ${salesChannelName}`,
        `Source: ${url}`,
        ``,
        `Inspiration saved:`,
        `  Categories found: ${inspiration.categories.length}`,
        `  Example products: ${inspiration.exampleProducts.length}`,
    ];

    if (inspiration.categories.length > 0) {
        results.push(
            `  Category hints: ${inspiration.categories.slice(0, 5).join(", ")}${inspiration.categories.length > 5 ? ", ..." : ""}`
        );
    }

    if (inspiration.brandDescription) {
        results.push(
            `  Brand description: "${inspiration.brandDescription.slice(0, 80)}${inspiration.brandDescription.length > 80 ? "..." : ""}"`
        );
    }

    if (inspiration.brandColors) {
        results.push(
            `  Brand colors: ${inspiration.brandColors.primary} / ${inspiration.brandColors.secondary}`
        );
    }

    results.push(
        ``,
        `  Saved to: ${cacheFileForDisplay(cache, salesChannelName, "inspiration.json")}`,
        ``,
        `Next step: bun run blueprint hydrate --name=${salesChannelName}`,
        `  (inspiration.json will be used automatically to guide AI generation)`
    );

    return results;
}

export function resolveCmsStoreDescription(
    salesChannelName: string,
    blueprintDescription?: string,
    hydratedDescription?: string
): string {
    const normalizedHydrated = hydratedDescription?.trim();
    if (normalizedHydrated) return normalizedHydrated;

    const normalizedBlueprint = blueprintDescription?.trim();
    if (normalizedBlueprint) return normalizedBlueprint;

    return `${salesChannelName} webshop`;
}
