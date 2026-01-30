/**
 * Fixture Types - Type definitions for reusable fixtures
 */

// =============================================================================
// CMS Page Types
// =============================================================================

/** Static config value wrapper */
export interface CmsConfigValue<T> {
    source: "static";
    value: T;
}

/** CMS slot configuration */
export interface CmsSlotConfig {
    type: string;
    slot: string;
    config: Record<string, CmsConfigValue<unknown>>;
}

/** CMS block configuration */
export interface CmsBlockConfig {
    type: string;
    position: number;
    sectionPosition: "main" | "sidebar";
    marginTop?: string;
    marginBottom?: string;
    marginLeft?: string;
    marginRight?: string;
    slots: CmsSlotConfig[];
}

/** CMS section configuration */
export interface CmsSectionConfig {
    type: "default" | "sidebar";
    sizingMode: "boxed" | "full_width";
    mobileBehavior: "wrap" | "stack";
    blocks: CmsBlockConfig[];
}

/** CMS page fixture configuration */
export interface CmsPageFixture {
    name: string;
    type: "landingpage" | "product_list" | "product_detail" | "page";
    sections: CmsSectionConfig[];
}

// =============================================================================
// Review Types
// =============================================================================

/** Review templates organized by sentiment */
export interface ReviewTemplates {
    positiveTitles: readonly string[];
    neutralTitles: readonly string[];
    negativeTitles: readonly string[];
}

/** Name lists for review generation */
export interface ReviewerNames {
    firstNames: readonly string[];
    lastNames: readonly string[];
}
