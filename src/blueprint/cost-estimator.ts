/**
 * Cost Estimator - forecast tokens, images and USD cost of a hydration run
 * before any AI call is made.
 *
 * Pure functions only: callers pass in the blueprint shape, the resolved
 * model selection and how many images are still missing from the cache.
 *
 * Token heuristics are calibrated from actual usage reported by OpenAI during
 * a hydration run with the default gpt-6-luna (reasoning disabled). Other models
 * write more or less, so treat the result as a forecast, not a quote.
 */

import type {
    BlueprintCategory,
    BlueprintProduct,
    CostEstimate,
    HydrationScope,
    ImageCostItem,
    LocaleTranslationCost,
    ModelSelection,
    PendingImageCounts,
    TextCostItem,
    TextModelPrice,
    TokenUsage,
    TranslationCostEstimate,
    TranslationSource,
    VariantSettings,
} from "../types/index.js";

import { OPENAI_IMAGE_PRICES, OPENAI_TEXT_PRICES, PRICING_AS_OF } from "../fixtures/index.js";
import { countCategories } from "../utils/index.js";
import { findDuplicateNameProducts, NAME_BATCH_SIZE } from "./hydrators/names.js";
import { PRICE_BATCH_SIZE } from "./hydrators/prices.js";
import { VARIANT_COLOR_BATCH_SIZE } from "./hydrators/product.js";
import {
    collectTerms,
    TRANSLATION_BATCH_SIZES,
    translatableProductFields,
} from "./hydrators/translation.js";
import { formatVariantSettings, productsMissingColors } from "./variant-settings.js";

/** Products per AI batch (mirrors ProductHydrator MAX_BATCH_SIZE) */
const PRODUCT_BATCH_SIZE = 10;

/** Share of products whose properties miss the property cache and need an options call */
const PROPERTY_CALLS_PER_PRODUCT = 0.1;

/**
 * Token heuristics per call type, from OpenAI usage of a gpt-6-luna run (19 categories,
 * 20 products, 8 CMS pages). The product prompt carries the category tree and the
 * property context, so its input is large per batch.
 */
const TOKENS = {
    category: { input: 300, inputPerCategory: 67, outputPerCategory: 85 },
    brandColors: { input: 200, output: 40 },
    productBatch: { input: 13700, outputPerProduct: 440 },
    propertyBatch: { input: 10000, outputPerProduct: 120 },
    propertyOptions: { input: 300, output: 100 },
    cmsPage: { input: 350, inputPerSlot: 60, outputPerSlot: 65 },
    variantColors: { input: 400, inputPerProduct: 25, outputPerProduct: 45 },
    prices: { input: 250, inputPerProduct: 25, outputPerProduct: 20 },
    names: { input: 1800, inputPerProduct: 90, outputPerProduct: 25 },
    manufacturers: { input: 300, inputPerBranch: 60, outputPerBranch: 30 },
} as const;

/** Blueprint shape the estimator needs */
export interface EstimateBlueprint {
    categories: BlueprintCategory[];
    products: BlueprintProduct[];
}

/** Input for estimateHydrationCost */
export interface CostEstimateInput {
    scope: HydrationScope;
    blueprint: EstimateBlueprint;
    selection: ModelSelection;
    cms: { pages: number; slots: number };
    pendingImages: PendingImageCounts;
    /** Inspiration brand colors replace the brand-colors AI call */
    hasInspirationColors: boolean;
    /** Variant settings of the run (scope "variants": the new settings) */
    variants?: VariantSettings;
}

/**
 * Forecast the cost of one hydration run.
 */
export function estimateHydrationCost(input: CostEstimateInput): CostEstimate {
    const textItems = buildTextItems(input);
    const imageItems = buildImageItems(input);

    const calls = sum(textItems.map((i) => i.calls));
    const inputTokens = sum(textItems.map((i) => i.inputTokens));
    const outputTokens = sum(textItems.map((i) => i.outputTokens));
    const textPrice = lookupTextPrice(input.selection);
    const textUsd = textPrice ? priceTokens(textPrice, inputTokens, outputTokens) : null;

    const imageCount = sum(imageItems.map((i) => i.count));
    const unitUsd = lookupImageUnitPrice(input.selection);
    const editUnitUsd = lookupImageUnitPrice(input.selection, "edit");
    const imageUsd = priceImageItems(imageItems, unitUsd, editUnitUsd);

    return {
        scope: input.scope,
        selection: input.selection,
        text: { items: textItems, calls, inputTokens, outputTokens, usd: textUsd },
        images: { items: imageItems, count: imageCount, unitUsd, editUnitUsd, usd: imageUsd },
        totalUsd: textUsd === null || imageUsd === null ? null : textUsd + imageUsd,
        notes: buildNotes(input),
    };
}

/**
 * Price actual token usage reported by a provider. Null when the model has no price data.
 */
export function priceTokenUsage(selection: ModelSelection, usage: TokenUsage): number | null {
    const price = lookupTextPrice(selection);
    if (!price) return null;
    return priceTokens(price, usage.inputTokens, usage.outputTokens);
}

/**
 * Render an estimate as CLI output lines.
 */
export function formatCostEstimate(estimate: CostEstimate): string[] {
    const { selection, text, images } = estimate;
    const lines = [
        `=== Cost forecast (${estimate.scope}) ===`,
        `Text:   ${selection.textProvider} / ${selection.textModel}`,
        ...text.items.map(
            (i) =>
                `  ${i.label.padEnd(22)} ${String(i.calls).padStart(4)} calls  ~${formatTokens(i.inputTokens)} in / ~${formatTokens(i.outputTokens)} out`
        ),
        `  Total: ${text.calls} calls, ~${formatTokens(text.inputTokens)} input + ~${formatTokens(text.outputTokens)} output tokens -> ${formatUsd(text.usd)}`,
    ];

    lines.push(`Images: ${describeImageSelection(selection)}`);
    lines.push(
        ...images.items
            .filter((i) => i.count > 0)
            .map(
                (i) =>
                    `  ${i.label.padEnd(22)} ${String(i.count).padStart(4)} images` +
                    (i.edit && images.editUnitUsd !== null
                        ? ` (edits x ${formatUsd(images.editUnitUsd, 3)})`
                        : "")
            )
    );
    const unit = images.unitUsd === null ? "" : ` x ${formatUsd(images.unitUsd, 3)}`;
    lines.push(`  Total: ${images.count} images${unit} -> ${formatUsd(images.usd)}`);

    lines.push(`Estimated total: ${formatUsd(estimate.totalUsd)}`);
    lines.push(...estimate.notes.map((n) => `  Note: ${n}`));
    return lines;
}

// =============================================================================
// Translation
// =============================================================================

/**
 * Translation call overhead: system prompt, instructions and the glossary slice.
 * Payload tokens are counted from the English source (about 4 characters per token).
 * Output is the payload again plus ~15% (most languages run longer than English).
 */
const TRANSLATION_TOKENS = {
    callOverhead: 900,
    charsPerToken: 4,
    outputFactor: 1.15,
    formalityCall: { input: 250, output: 10 },
} as const;

function tokensOf(value: unknown): number {
    return Math.ceil(JSON.stringify(value).length / TRANSLATION_TOKENS.charsPerToken);
}

/** Calls and payload tokens of one locale (the same for every locale) */
function translationWorkload(source: TranslationSource): { calls: number; payloadTokens: number } {
    const batches = (count: number, size: number) => Math.ceil(count / size);
    const reviewCount = sum(Object.values(source.reviews).map((r) => r.length));
    const terms = collectTerms(source);

    const calls =
        1 + // formality decision
        batches(terms.length, TRANSLATION_BATCH_SIZES.terms) +
        batches(Object.keys(source.categories).length, TRANSLATION_BATCH_SIZES.categories) +
        batches(Object.keys(source.products).length, TRANSLATION_BATCH_SIZES.products) +
        batches(reviewCount, TRANSLATION_BATCH_SIZES.reviews) +
        Object.keys(source.cms).length +
        batches(Object.keys(source.fixtures).length, TRANSLATION_BATCH_SIZES.fixtures);

    const categoryDescriptions = Object.values(source.categories).map((c) => c.description);
    const payloadTokens =
        tokensOf(terms) +
        tokensOf(categoryDescriptions) +
        tokensOf(Object.values(source.products).map(translatableProductFields)) +
        tokensOf(source.reviews) +
        tokensOf(source.cms) +
        tokensOf(source.fixtures);

    return { calls, payloadTokens };
}

/**
 * Typical lengths of hydrated texts (characters), measured on cached catalogs.
 * Used to forecast translation before hydration, when the blueprint has no texts yet.
 */
const TYPICAL_TEXT_LENGTH = {
    productName: 40,
    productDescription: 800,
    categoryName: 18,
    categoryDescription: 120,
    /** Property group and option names collected per product (variants, filters) */
    termsPerProduct: 0.7,
    term: 12,
} as const;

/**
 * Build a translation source with typical text lengths from an unhydrated blueprint,
 * so `generate` can forecast translation cost before hydration.
 */
export function estimateTranslationSource(
    blueprint: EstimateBlueprint,
    base: Pick<TranslationSource, "cms" | "fixtures" | "reviews">
): TranslationSource {
    const filler = (length: number, seed: string) => seed.padEnd(length, "x");
    const termCount = Math.ceil(blueprint.products.length * TYPICAL_TEXT_LENGTH.termsPerProduct);
    const categoryNames = Array.from({ length: countCategories(blueprint.categories) }, (_, i) =>
        filler(TYPICAL_TEXT_LENGTH.categoryName, `c${i}`)
    );

    return {
        categories: Object.fromEntries(
            categoryNames.map((name) => [
                name,
                { name, description: filler(TYPICAL_TEXT_LENGTH.categoryDescription, name) },
            ])
        ),
        products: Object.fromEntries(
            blueprint.products.map((p) => [
                p.id,
                {
                    name: filler(TYPICAL_TEXT_LENGTH.productName, p.id),
                    description: filler(TYPICAL_TEXT_LENGTH.productDescription, p.id),
                },
            ])
        ),
        propertyGroups: {
            terms: {
                name: "terms",
                options: Array.from({ length: termCount }, (_, i) =>
                    filler(TYPICAL_TEXT_LENGTH.term, `t${i}`)
                ),
            },
        },
        reviews: base.reviews,
        cms: base.cms,
        fixtures: base.fixtures,
    };
}

/**
 * Forecast the cost of translating the catalog into each locale.
 */
export function estimateTranslationCost(
    source: TranslationSource,
    locales: string[],
    selection: ModelSelection
): TranslationCostEstimate {
    const { calls, payloadTokens } = translationWorkload(source);
    const inputTokens = calls * TRANSLATION_TOKENS.callOverhead + payloadTokens;
    const outputTokens = Math.ceil(payloadTokens * TRANSLATION_TOKENS.outputFactor);
    const price = lookupTextPrice(selection);
    const usd = price ? priceTokens(price, inputTokens, outputTokens) : null;

    const perLocale: LocaleTranslationCost[] = locales.map((locale) => ({
        locale,
        calls,
        inputTokens,
        outputTokens,
        usd,
    }));

    return {
        selection,
        locales: perLocale,
        inputTokens: inputTokens * locales.length,
        outputTokens: outputTokens * locales.length,
        usd: usd === null ? null : usd * locales.length,
    };
}

/**
 * Render a translation forecast as CLI output lines.
 */
export function formatTranslationEstimate(estimate: TranslationCostEstimate): string[] {
    if (estimate.locales.length === 0) return [];
    const tokens = (i: number, o: number) => `~${formatTokens(i + o)} tokens`;
    return [
        `=== Translation forecast (${estimate.selection.textProvider} / ${estimate.selection.textModel}) ===`,
        ...estimate.locales.map(
            (l) =>
                `  ${l.locale.padEnd(8)} ${String(l.calls).padStart(4)} calls  ${tokens(l.inputTokens, l.outputTokens).padEnd(16)} ${formatUsd(l.usd)}`
        ),
        `  Total${" ".repeat(18)}${tokens(estimate.inputTokens, estimate.outputTokens).padEnd(16)} ${formatUsd(estimate.usd)}`,
    ];
}

// =============================================================================
// Text
// =============================================================================

/** One text step of the hydration: the scopes it runs in and how many calls it makes */
interface TextStep {
    scopes: HydrationScope[];
    build: (input: CostEstimateInput) => TextCostItem | null;
}

const TEXT_STEPS: TextStep[] = [
    { scopes: ["full", "categories"], build: (input) => categoryItem(input.blueprint.categories) },
    {
        scopes: ["full"],
        build: (input) =>
            input.hasInspirationColors ? null : fixedItem("Brand colors", 1, TOKENS.brandColors),
    },
    { scopes: ["full"], build: (input) => productItem(input.blueprint.products) },
    { scopes: ["properties"], build: (input) => propertyBatchItem(input.blueprint.products) },
    {
        scopes: ["full", "properties"],
        build: (input) => propertyOptionsItem(input.blueprint.products.length),
    },
    { scopes: ["full", "cms"], build: (input) => cmsItem(input.cms) },
    { scopes: ["full", "prices"], build: (input) => priceItem(input.blueprint.products.length) },
    { scopes: ["names"], build: (input) => nameItem(input.blueprint.products) },
    {
        scopes: ["full", "manufacturers"],
        build: (input) => manufacturerItem(input.blueprint.categories.length),
    },
    {
        scopes: ["variants"],
        build: (input) =>
            input.variants ? variantColorItem(input.blueprint.products, input.variants) : null,
    },
];

function buildTextItems(input: CostEstimateInput): TextCostItem[] {
    return TEXT_STEPS.filter((step) => step.scopes.includes(input.scope))
        .map((step) => step.build(input))
        .filter((item): item is TextCostItem => item !== null && item.calls > 0);
}

function priceItem(productCount: number): TextCostItem {
    return {
        label: "Prices",
        calls: Math.ceil(productCount / PRICE_BATCH_SIZE),
        inputTokens: TOKENS.prices.input + productCount * TOKENS.prices.inputPerProduct,
        outputTokens: productCount * TOKENS.prices.outputPerProduct,
    };
}

/** Duplicates in the blueprint; a full run's duplicates are unknown before it, so none */
function nameItem(products: BlueprintProduct[]): TextCostItem {
    const duplicates = findDuplicateNameProducts(products).length;
    const calls = Math.ceil(duplicates / NAME_BATCH_SIZE);
    return {
        label: "Product names",
        calls,
        inputTokens: calls * TOKENS.names.input + duplicates * TOKENS.names.inputPerProduct,
        outputTokens: duplicates * TOKENS.names.outputPerProduct,
    };
}

/** One call for the whole store; each top-level category is one branch */
function manufacturerItem(branches: number): TextCostItem {
    return {
        label: "Manufacturers",
        calls: branches > 0 ? 1 : 0,
        inputTokens: TOKENS.manufacturers.input + branches * TOKENS.manufacturers.inputPerBranch,
        outputTokens: branches * TOKENS.manufacturers.outputPerBranch,
    };
}

function categoryItem(categories: BlueprintCategory[]): TextCostItem {
    const count = countCategories(categories);
    return {
        label: "Categories",
        calls: count > 0 ? 1 : 0,
        inputTokens: TOKENS.category.input + count * TOKENS.category.inputPerCategory,
        outputTokens: count * TOKENS.category.outputPerCategory,
    };
}

function productItem(products: BlueprintProduct[]): TextCostItem {
    const batches = countBranchBatches(products);
    return {
        label: "Products",
        calls: batches,
        inputTokens: batches * TOKENS.productBatch.input,
        outputTokens: products.length * TOKENS.productBatch.outputPerProduct,
    };
}

function propertyBatchItem(products: BlueprintProduct[]): TextCostItem {
    const batches = countBranchBatches(products);
    return {
        label: "Product properties",
        calls: batches,
        inputTokens: batches * TOKENS.propertyBatch.input,
        outputTokens: products.length * TOKENS.propertyBatch.outputPerProduct,
    };
}

function propertyOptionsItem(productCount: number): TextCostItem {
    const calls = Math.ceil(productCount * PROPERTY_CALLS_PER_PRODUCT);
    return fixedItem("Property options", calls, TOKENS.propertyOptions);
}

function cmsItem(cms: { pages: number; slots: number }): TextCostItem {
    return {
        label: "CMS pages",
        calls: cms.pages,
        inputTokens: cms.pages * TOKENS.cmsPage.input + cms.slots * TOKENS.cmsPage.inputPerSlot,
        outputTokens: cms.slots * TOKENS.cmsPage.outputPerSlot,
    };
}

/** Extra colours for variant products that have fewer than the new colour count */
function variantColorItem(products: BlueprintProduct[], settings: VariantSettings): TextCostItem {
    const count = productsMissingColors(products, settings).length;
    const calls = Math.ceil(count / VARIANT_COLOR_BATCH_SIZE);
    return {
        label: "Variant colours",
        calls,
        inputTokens:
            calls * TOKENS.variantColors.input + count * TOKENS.variantColors.inputPerProduct,
        outputTokens: count * TOKENS.variantColors.outputPerProduct,
    };
}

function fixedItem(
    label: string,
    calls: number,
    tokens: { input: number; output: number }
): TextCostItem {
    return {
        label,
        calls,
        inputTokens: calls * tokens.input,
        outputTokens: calls * tokens.output,
    };
}

/** Products are hydrated per top-level branch in batches of PRODUCT_BATCH_SIZE */
function countBranchBatches(products: BlueprintProduct[]): number {
    const perBranch = products.reduce((acc, p) => {
        acc.set(p.primaryCategoryId, (acc.get(p.primaryCategoryId) ?? 0) + 1);
        return acc;
    }, new Map<string, number>());

    return sum([...perBranch.values()].map((n) => Math.ceil(n / PRODUCT_BATCH_SIZE)));
}

// =============================================================================
// Images
// =============================================================================

function buildImageItems(input: CostEstimateInput): ImageCostItem[] {
    if (input.selection.imageProvider === "none") return [];

    const { pendingImages, scope } = input;
    const includeCms = scope === "full" || scope === "cms";
    const includeCatalog = scope === "full";
    const includeVariantColors = scope === "full" || scope === "variant-images";

    return [
        { label: "CMS images", count: includeCms ? pendingImages.cms : 0 },
        { label: "Product images", count: includeCatalog ? pendingImages.product : 0 },
        { label: "Category banners", count: includeCatalog ? pendingImages.category : 0 },
        { label: "Theme media", count: includeCatalog ? pendingImages.theme : 0 },
        {
            label: "Variant colour images",
            count: includeVariantColors ? pendingImages.variantColor : 0,
            edit: true,
        },
    ];
}

/** Generated images at the unit price, edited ones at the edit price. Null when unknown */
function priceImageItems(
    items: ImageCostItem[],
    unitUsd: number | null,
    editUnitUsd: number | null
): number | null {
    const generated = sum(items.filter((i) => !i.edit).map((i) => i.count));
    const edited = sum(items.filter((i) => i.edit).map((i) => i.count));
    const generatedUsd = generated === 0 ? 0 : unitUsd;
    const editedUsd = edited === 0 ? 0 : editUnitUsd;
    if (generatedUsd === null || editedUsd === null) return null;
    return generatedUsd * generated + editedUsd * edited;
}

// =============================================================================
// Pricing
// =============================================================================

function lookupTextPrice(selection: ModelSelection): TextModelPrice | null {
    if (selection.textProvider !== "openai") return null;
    return OPENAI_TEXT_PRICES[stripSnapshotDate(selection.textModel)] ?? null;
}

function hasEditPrice(selection: ModelSelection): boolean {
    return Boolean(OPENAI_IMAGE_PRICES[stripSnapshotDate(selection.imageModel ?? "")]?.edit);
}

/** Price per image; "edit" adds the input image (falls back to the generate price) */
function lookupImageUnitPrice(
    selection: ModelSelection,
    kind: "generate" | "edit" = "generate"
): number | null {
    if (selection.imageProvider === "none") return 0;
    if (selection.imageProvider === "pollinations") return selection.imageFreeTier ? 0 : null;
    return lookupOpenAiImagePrice(selection, kind);
}

function lookupOpenAiImagePrice(
    selection: ModelSelection,
    kind: "generate" | "edit"
): number | null {
    const price = OPENAI_IMAGE_PRICES[stripSnapshotDate(selection.imageModel ?? "")];
    if (!price) return null;
    const table = kind === "edit" ? (price.edit ?? price) : price;
    return table[forecastImageQuality(selection.imageQuality)];
}

/** Quality tier to price, low by default. "auto" (or anything else) lets OpenAI pick: forecast as medium */
function forecastImageQuality(quality = "low"): "low" | "medium" | "high" {
    if (quality === "low" || quality === "medium" || quality === "high") return quality;
    return "medium";
}

function priceTokens(price: TextModelPrice, inputTokens: number, outputTokens: number): number {
    return (
        (inputTokens / 1_000_000) * price.inputPerMillion +
        (outputTokens / 1_000_000) * price.outputPerMillion
    );
}

/** "gpt-4.1-2025-04-14" -> "gpt-4.1" so dated snapshots share the base price */
function stripSnapshotDate(model: string): string {
    return model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

// =============================================================================
// Notes & formatting
// =============================================================================

/** A forecast note and when it applies */
interface CostNote {
    applies: (input: CostEstimateInput) => boolean;
    text: (input: CostEstimateInput) => string;
}

const PROVIDER_AND_SCOPE_NOTES: CostNote[] = [
    {
        applies: ({ selection }) => selection.textProvider === "pollinations",
        text: () => "Pollinations text is billed in pollen; check enter.pollinations.ai.",
    },
    {
        applies: ({ selection }) =>
            selection.textProvider === "openai" && !lookupTextPrice(selection),
        text: ({ selection }) => `No price data for text model "${selection.textModel}".`,
    },
    {
        applies: ({ selection }) =>
            selection.imageProvider === "pollinations" && !selection.imageFreeTier,
        text: () => "Pollinations images with a key are billed in pollen.",
    },
    {
        applies: ({ selection }) =>
            selection.imageProvider === "openai" && lookupImageUnitPrice(selection) === null,
        text: ({ selection }) => `No price data for image model "${selection.imageModel}".`,
    },
    {
        applies: ({ scope, pendingImages }) => scope === "full" && pendingImages.product > 0,
        text: () => "Product and category images are counted in full; renamed products regenerate.",
    },
    {
        applies: ({ scope }) => scope === "full" || scope === "properties",
        text: () => "Property options calls only happen for properties missing from the cache.",
    },
];

function buildNotes(input: CostEstimateInput): string[] {
    return [
        ...PROVIDER_AND_SCOPE_NOTES.filter((note) => note.applies(input)).map((note) =>
            note.text(input)
        ),
        ...variantNotes(input),
        ...variantImageNotes(input),
        `List prices as of ${PRICING_AS_OF}. Actual cost may differ.`,
    ];
}

/** Scopes that create or change variants */
const VARIANT_NOTE_SCOPES = new Set<HydrationScope>([
    "full",
    "properties",
    "variants",
    "variant-images",
]);

function variantNotes(input: CostEstimateInput): string[] {
    const { variants, scope } = input;
    if (!variants || !VARIANT_NOTE_SCOPES.has(scope)) return [];
    const variantProducts =
        scope === "full"
            ? Math.round(input.blueprint.products.length * variants.share)
            : input.blueprint.products.filter((p) => p.metadata.isVariant).length;
    return [`Variants: ${variantProducts} variant products (${formatVariantSettings(variants)}).`];
}

function variantImageNotes(input: CostEstimateInput): string[] {
    const { scope, selection } = input;
    if (scope !== "full" && scope !== "variant-images") return [];
    if (selection.imageProvider === "pollinations") {
        return ["Variant colour images need image editing (OpenAI); skipped with Pollinations."];
    }
    const notes: string[] = [];
    if (scope === "full" && input.pendingImages.variantColor > 0) {
        notes.push(
            "Variant colour images are an upper bound: not every variant product has colours."
        );
    }
    if (input.pendingImages.variantColor > 0 && !hasEditPrice(selection)) {
        notes.push(
            "Variant colour images are priced like new images; edits also pay for the input image."
        );
    }
    return notes;
}

function describeImageSelection(selection: ModelSelection): string {
    if (selection.imageProvider === "none") return "disabled";
    if (selection.imageProvider === "pollinations") {
        const tier = selection.imageFreeTier ? "free tier" : "with key";
        return `pollinations / ${selection.imageModel} (${tier})`;
    }
    return `openai / ${selection.imageModel} (${selection.imageQuality} quality)`;
}

function formatTokens(tokens: number): string {
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
    return String(tokens);
}

function formatUsd(usd: number | null, digits = 2): string {
    if (usd === null) return "unknown (no price data)";
    if (usd > 0 && usd < 0.01 && digits === 2) return "< $0.01";
    return `$${usd.toFixed(digits)}`;
}

function sum(values: number[]): number {
    return values.reduce((acc, v) => acc + v, 0);
}
