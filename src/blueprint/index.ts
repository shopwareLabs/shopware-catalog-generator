export { BlueprintGenerator } from "./generator.js";
export { BlueprintHydrator } from "./hydrator.js";
export {
    mergeSynonymPropertyGroups,
    propertyGroupKey,
    singleOptionGroupNames,
} from "./property-synonyms.js";
export type { PropertyGroupMerge } from "./property-synonyms.js";
export {
    applyColorSystem,
    collectShadeNames,
    isFamilyGroupName,
    isShadeGroupName,
    normalizeProductColors,
} from "./color-system.js";
export {
    estimateHydrationCost,
    estimateTranslationCost,
    estimateTranslationSource,
    formatCostEstimate,
    formatTranslationEstimate,
    priceTokenUsage,
} from "./cost-estimator.js";
export type { CostEstimateInput, EstimateBlueprint } from "./cost-estimator.js";
export {
    findPlaceholderCategories,
    findPlaceholderProducts,
    fixPlaceholders,
} from "./fix-placeholders.js";
export {
    buildCmsImageSpecs,
    buildThemeImageSpecs,
    countCmsTextWork,
    flattenCategories,
    generateCmsBlueprint,
    hydrateBrandColors,
    hydrateCmsBlueprint,
    hydrateCmsImages,
    hydrateColorShades,
    hydrateProductImages,
    hydrateThemeMedia,
    hydrateVariantImages,
    countVariantImages,
    NO_EDIT_SUPPORT_WARNING,
    planVariantImages,
    resolveVariantImageViews,
    variantImageView,
    ProductHydrator,
    buildTranslationSource,
    collectCmsTexts,
    translateCatalog,
} from "./hydrators/index.js";
export type { TranslateCatalogInput, TranslateCatalogResult } from "./hydrators/index.js";
export { VariantResolver } from "./variant-resolver.js";
export {
    assignVariantProducts,
    blueprintVariantSettings,
    capVariantConfigs,
    countVariants,
    formatVariantSettings,
    hasVariantOverrides,
    isColorVariantGroup,
    missingColorCount,
    pickOptions,
    pickPreferredOptions,
    productDefaultColor,
    productsMissingColors,
    repickVariantConfigs,
    resolveVariantSettings,
    VARIANT_SETTING_ENV,
    VARIANT_SETTING_FLAGS,
    VariantSettingsError,
} from "./variant-settings.js";
export type { RepickInput, VariantSettingOverrides } from "./variant-settings.js";
