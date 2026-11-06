/**
 * Fixtures - Reusable data configurations for Shopware entities
 *
 * This module contains static fixture data that can be used to create
 * test content in Shopware. Separating fixtures from code makes them
 * easier to maintain and extend.
 *
 * @example
 * import { VIDEO_ELEMENTS_PAGE, REVIEWER_NAMES } from "./fixtures/index.js";
 */

// CMS Pages (organized by block category)
export {
    COMMERCE_ELEMENTS_PAGE,
    FORM_ELEMENTS_PAGE,
    HOME_LISTING_PAGE,
    IMAGES_ELEMENTS_PAGE,
    TESTING_PLACEHOLDER_PAGE,
    TEXT_ELEMENTS_PAGE,
    TEXT_IMAGES_ELEMENTS_PAGE,
    VIDEO_ELEMENTS_PAGE,
    WELCOME_PAGE,
} from "./cms/index.js";
// Demo Customers
export { B2B_CUSTOMER_GROUP, DEMO_CUSTOMERS, DEMO_PASSWORD } from "./demo-customers.js";
export type { CustomerGroupKey, DemoAddress, DemoCustomer } from "./demo-customers.js";
// Digital Products
export { GIFT_CARD_50 } from "./digital-products.js";
// Shopware feature list (version gating)
export { MIN_SUPPORTED_SHOPWARE_VERSION, SHOPWARE_FEATURES } from "./shopware-features.js";
export type { ShopwareFeature } from "./shopware-features.js";
// Model pricing (hydration cost forecast)
export { OPENAI_IMAGE_PRICES, OPENAI_TEXT_PRICES, PRICING_AS_OF } from "./model-pricing.js";
// Promotions
export { PROMOTIONS } from "./promotions.js";
export type { DiscountScope, DiscountType, PromotionDefinition } from "./promotions.js";
// Property Groups (universal groups for seeding generated/properties/)
export {
    colorHasImage,
    getColorImagePath,
    getUniversalPropertyGroups,
    IMAGE_COLOR_OPTIONS,
    UNIVERSAL_PROPERTY_GROUPS,
} from "./property-groups.js";
// Review Data
export {
    getReviewContent,
    REVIEW_CONTENT_TEMPLATES,
    REVIEW_TEMPLATES,
    REVIEWER_NAMES,
} from "./review-data.js";
// Types
export type {
    CmsBlockConfig,
    CmsConfigValue,
    CmsPageFixture,
    CmsSectionConfig,
    CmsSlotConfig,
    ReviewerNames,
    ReviewTemplates,
} from "./types.js";
