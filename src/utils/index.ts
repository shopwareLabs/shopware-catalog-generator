// Array utilities
export { cloneDeep } from "./clone.js";
export {
    chunkArray,
    cartesianProduct,
    randomPick,
    randomSample,
    randomSamplePercent,
    weightedRandomPick,
} from "./arrays.js";
// Blueprint validation
export type {
    BlueprintValidationIssue,
    BlueprintValidationOptions,
    BlueprintValidationResult,
} from "./blueprint-validation.js";
export {
    hasValidationIssues,
    isPlaceholder,
    PLACEHOLDER_PATTERNS,
    validateBlueprint,
} from "./blueprint-validation.js";
// Category tree utilities
export type { FlatCategory, FlatCategoryWithPath } from "./category-tree.js";
export {
    buildBlueprintCategoryPathMap,
    buildCategoryPath,
    CATEGORY_PATH_SEPARATOR,
    collectCategoryIdsByPath,
    convertBlueprintCategories,
    countCategories,
    countProducts,
    findCategoryByName,
    findCategoryPathById,
    flattenCategoryTree,
    flattenCategoryTreeWithPath,
    getLeafCategories,
    getLeafCategoriesWithProducts,
    getTreeDepth,
    redistributeProductsToTree,
} from "./category-tree.js";
// Color palette utilities
export type { ColorMatch } from "./color-palette.js";
export {
    buildImagePrompt,
    COLOR_PALETTE,
    findClosestColor,
    getColorHex,
    getContrastTextColor,
    getViewSuffix,
    VIEW_SUFFIXES,
} from "./color-palette.js";
// Concurrency utilities
export { ConcurrencyLimiter } from "./concurrency.js";
// Logger utilities
export type { LogLevel, LogOptions } from "./logger.js";
export { logger } from "./logger.js";
export type { ExistingProperty, ExistingPropertyOption } from "./property-collector.js";
// Property collector (v2)
export { PropertyCollector } from "./property-collector.js";
// Retry utilities
export type { RetryOptions } from "./retry.js";
export {
    DEFAULT_BASE_DELAY_MS,
    DEFAULT_MAX_RETRIES,
    DEFAULT_TIMEOUT_MS,
    executeWithRetry,
    getRetryAfterMs,
    isRateLimitError,
    sleep,
    TimeoutError,
    withTimeout,
} from "./retry.js";
// Shopware request utilities
export type { ShopwareRequestContext } from "./shopware-request.js";
export { apiPatch, apiPost, apiUpload } from "./shopware-request.js";
// String utilities
export {
    capitalizeString,
    createShortHash,
    decodeHtmlEntities,
    generateCategoryPlaceholder,
    generateNumericHash,
    generateProductPlaceholder,
    generatePropertyGroupPlaceholder,
    normalizeDescription,
    normalizeString,
    stripHtml,
    toFixtureUrlSlug,
    toKebabCase,
    toStoreScopedName,
} from "./strings.js";
// UUID utilities
export { generateAccessKey, generateUUID } from "./uuid.js";
export type { SubdomainValidationResult } from "./validation.js";
export { generateSubdomainUrl, isValidSubdomain, validateSubdomainName } from "./validation.js";
