/**
 * Central types export - import all types from here
 */

// Blueprint types (v2)
export type {
    Blueprint,
    BlueprintCategory,
    BlueprintConfig,
    BlueprintProduct,
    BlueprintPropertyGroup,
    BlueprintPropertyOption,
    BlueprintSalesChannel,
    BlueprintVersion,
    BrandColors,
    CmsBlueprint,
    CmsBlueprintBlock,
    CmsBlueprintPage,
    CmsBlueprintSection,
    CmsBlueprintSlot,
    HydratedBlueprint,
    ImageDescription,
    ImageView,
    Manufacturer,
    ProductCustomFieldValues,
    ProductMetadata,
    ProductPackaging,
    ProductProperty,
    ProductType,
    ReviewCount,
    VariantConfig,
} from "./blueprint.js";
export { DEFAULT_BLUEPRINT_CONFIG } from "./blueprint.js";

// Colour types
export type { ColorFamily, ColorShade, LearnedColorShades } from "./color.js";
export {
    COLOR_FAMILY_KEYS,
    ColorFamilySchema,
    ColorShadeSchema,
    LearnedColorShadesSchema,
} from "./color.js";

// Cache types
export type {
    CacheOptions,
    CategoryTreeCache,
    ImageCacheMetadata,
    ProductCacheMetadata,
    SalesChannelCacheMetadata,
} from "./cache.js";
export { DEFAULT_CACHE_OPTIONS } from "./cache.js";

// Cost estimate types
export type {
    CostEstimate,
    HydrationScope,
    ImageCostItem,
    ImageModelPrice,
    LocaleTranslationCost,
    ModelSelection,
    PendingImageCounts,
    TextCostItem,
    TextModelPrice,
    TokenUsage,
    TranslationCostEstimate,
} from "./cost-estimate.js";

// Export types
export type { ExportResult, ExportValidation } from "./export.js";
export { createEmptyValidation, getValidationWarnings } from "./export.js";
// Property cache types
export type { CachedPropertyGroup, PropertyCacheIndex } from "./property-cache.js";
// AI Provider types
export type {
    AIProviderType,
    ChatMessage,
    ImageGenerationOptions,
    ImageProvider,
    ImageProviderType,
    ProviderConfig,
    TextProvider,
} from "./providers.js";
export {
    AI_PROVIDER_TYPES,
    DEFAULT_POLLINATIONS_IMAGE_MODEL,
    PROVIDER_DEFAULTS,
} from "./providers.js";

// Shopware version detection types
export type { ShopwareFeatureRequirement, ShopwareVersion } from "./shopware-version.js";

// Shopware entity types and Zod schemas
export type {
    CategoryNode,
    CategorySyncPayload,
    CustomerAddressPayload,
    CustomerSyncPayload,
    DomainMeasurementUnits,
    ProductImage,
    ProductInput,
    ProductReview,
    MediaEntityPayload,
    PricePayload,
    ProductSyncPayload,
    ProductVisibilityPayload,
    PromotionDiscountPayload,
    PropertyGroup,
    ProductSyncResult,
    PropertyOption,
    SalesChannel,
    SalesChannelFull,
    SalesChannelInput,
    SalesChannelUpdatePayload,
    TieredPricePayload,
} from "./shopware.js";

// Zod schemas for AI response validation
export {
    IMPERIAL_MEASUREMENT_UNITS,
    ProductDefinition,
    ProductReviewDefinition,
    PropertyGroupDefinition,
    PropertyOptionDefinition,
} from "./shopware.js";

// Translation types (multi-language catalogs)
export type {
    CategoryTranslation,
    CmsPageTranslation,
    Formality,
    LanguageSelection,
    ProductReviewsTranslation,
    ProductTranslation,
    PropertyGroupTranslation,
    ReviewTranslation,
    ShopLanguage,
    ShopLanguages,
    TranslationFile,
    TranslationSource,
} from "./translation.js";
export { FormalitySchema, SOURCE_LOCALE, TranslationFileSchema } from "./translation.js";

// Template metadata (generation.json, template.json)
export type {
    GenerationLog,
    GenerationStep,
    GeneratorInfo,
    LaneResult,
    ModelInfo,
    TemplateInfo,
} from "./template.js";
export {
    GenerationLogSchema,
    TEMPLATE_INFO_SCHEMA_VERSION,
    TemplateInfoSchema,
} from "./template.js";
