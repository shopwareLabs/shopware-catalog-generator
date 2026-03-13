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
    ProductMetadata,
    ProductProperty,
    ReviewCount,
    VariantConfig,
} from "./blueprint.js";
export { DEFAULT_BLUEPRINT_CONFIG } from "./blueprint.js";

// Cache types
export type {
    CacheOptions,
    CategoryTreeCache,
    ImageCacheMetadata,
    ProductCacheMetadata,
    SalesChannelCacheMetadata,
} from "./cache.js";
export { DEFAULT_CACHE_OPTIONS } from "./cache.js";

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
export { PROVIDER_DEFAULTS } from "./providers.js";

// Shopware entity types and Zod schemas
export type {
    CategoryNode,
    CategorySyncPayload,
    CustomerAddressPayload,
    CustomerSyncPayload,
    ProductImage,
    ProductInput,
    ProductReview,
    MediaEntityPayload,
    PricePayload,
    ProductSyncPayload,
    ProductVisibilityPayload,
    PromotionDiscountPayload,
    PropertyGroup,
    PropertyOption,
    SalesChannel,
    SalesChannelFull,
    SalesChannelInput,
    SalesChannelUpdatePayload,
    TieredPricePayload,
} from "./shopware.js";

// Zod schemas for AI response validation
export {
    ProductDefinition,
    ProductReviewDefinition,
    PropertyGroupDefinition,
    PropertyOptionDefinition,
} from "./shopware.js";
