export { applyCategoryHydration, flattenCategories, hydrateCategories } from "./category.js";
export type { CategoryHydrationResult } from "./category.js";
export { COLOR_SHADE_BATCH_SIZE, findUnknownShades, hydrateColorShades } from "./color-shades.js";
export { countCmsTextWork, generateCmsBlueprint, hydrateCmsBlueprint } from "./cms.js";
export {
    buildCmsImageSpecs,
    buildThemeImageSpecs,
    hydrateCmsImages,
    hydrateProductImages,
    hydrateThemeMedia,
} from "./image.js";
export type {
    CmsImageHydrationResult,
    ProductImageHydrationResult,
    ThemeMediaHydrationResult,
} from "./image.js";
export { ProductHydrator } from "./product.js";
export {
    buildRecolorPrompt,
    collectVariantImageTasks,
    countVariantImages,
    hashImage,
    hydrateVariantImages,
    NO_EDIT_SUPPORT_WARNING,
    planVariantImages,
    resolveVariantImageViews,
    shadeSlug,
    VARIANT_IMAGE_VIEWS_ENV,
    variantImageView,
} from "./variant-images.js";
export type {
    VariantImageHydrationResult,
    VariantImagePlan,
    VariantImageTask,
    VariantImageViews,
} from "./variant-images.js";
export type { StoreContext } from "./product.js";
export { hydrateBrandColors } from "./theme.js";
export {
    buildTranslationSource,
    buildTranslationSystemPrompt,
    cmsSlotKey,
    collectCmsTexts,
    describeLocale,
    sourceHashOf,
    TRANSLATION_BATCH_SIZES,
    translateCatalog,
    validateTranslatedItem,
} from "./translation.js";
export type {
    TranslateCatalogInput,
    TranslateCatalogResult,
    TranslationItem,
} from "./translation.js";
