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

// CMS Pages
export { VIDEO_ELEMENTS_PAGE } from "./cms-pages.js";
// Property Groups (universal groups for seeding generated/properties/)
export {
    getUniversalPropertyGroups,
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
