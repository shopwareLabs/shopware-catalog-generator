/**
 * CMS Page Fixtures - Demo pages for testing CMS block types
 *
 * Each fixture corresponds to a Shopware admin block category:
 * - Text: text, text-hero, text-teaser, text-two-column, html
 * - Images: image, image-gallery, image-slider
 * - Video: youtube-video, vimeo-video
 * - Text & Images: image-text, center-text, image-text-bubble, text-on-image
 * - Commerce: product-box, product-slider, gallery-buybox, category-navigation
 * - Form: form (contact), form (newsletter)
 *
 * Structure:
 * - Testing (testing-placeholder.ts) - Entry point
 *   - CMS (welcome.ts) - Showcase page
 *     - Text, Images, Video, Text & Images, Commerce, Form
 *   - Products - Navigation category with product links
 */

export { COMMERCE_ELEMENTS_PAGE } from "./commerce.js";
export { FORM_ELEMENTS_PAGE } from "./form.js";
export { HOME_LISTING_PAGE } from "./home-listing.js";
export { IMAGES_ELEMENTS_PAGE } from "./images.js";
export { TESTING_PLACEHOLDER_PAGE } from "./testing-placeholder.js";
export { TEXT_ELEMENTS_PAGE } from "./text.js";
export { TEXT_IMAGES_ELEMENTS_PAGE } from "./text-images.js";
export { VIDEO_ELEMENTS_PAGE } from "./video.js";
export { WELCOME_PAGE } from "./welcome.js";
