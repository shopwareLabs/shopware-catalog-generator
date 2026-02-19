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
// Digital Products
export { GIFT_CARD_50 } from "./digital-products.js";
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
