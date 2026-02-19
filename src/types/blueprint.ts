/**
 * Blueprint types for v2 data generation pipeline
 *
 * The blueprint system generates a complete structure BEFORE any AI calls,
 * then hydrates it with AI-generated content in a separate phase.
 */

// =============================================================================
// Blueprint Core Types
// =============================================================================

/** Blueprint version for cache compatibility */
export type BlueprintVersion = "1.0";

/** Complete blueprint structure */
export interface Blueprint {
    /** Version for cache compatibility */
    version: BlueprintVersion;

    /** SalesChannel configuration */
    salesChannel: BlueprintSalesChannel;

    /** Hierarchical category tree */
    categories: BlueprintCategory[];

    /** Flat list of products with category references */
    products: BlueprintProduct[];

    /** Timestamp when blueprint was created */
    createdAt: string;
}

/** Hydrated blueprint after AI processing */
export interface HydratedBlueprint extends Blueprint {
    /** Property groups derived from product properties */
    propertyGroups: BlueprintPropertyGroup[];

    /** Timestamp when blueprint was hydrated */
    hydratedAt: string;
}

// =============================================================================
// SalesChannel Types
// =============================================================================

/** SalesChannel configuration in blueprint */
export interface BlueprintSalesChannel {
    /** Name of the sales channel (validated for subdomain compatibility) */
    name: string;

    /** Description/context for AI generation (placeholder before hydration) */
    description: string;

    /** Base URL for the sales channel (auto-generated from name) */
    baseUrl?: string;
}

// =============================================================================
// Category Types
// =============================================================================

/** Category node in blueprint */
export interface BlueprintCategory {
    /** Pre-generated UUID */
    id: string;

    /** Category name (placeholder before hydration, e.g., "Category 1") */
    name: string;

    /** Category description (placeholder before hydration) */
    description: string;

    /** Parent category UUID (undefined for top-level) */
    parentId?: string;

    /** Category level (1 = top-level, 2, 3) */
    level: number;

    /** Whether this category should have an image (~40% of categories) */
    hasImage: boolean;

    /** AI-generated image description for image processor (filled during hydration) */
    imageDescription?: string;

    /** Nested child categories */
    children: BlueprintCategory[];
}

// =============================================================================
// Product Types
// =============================================================================

/** Product in blueprint */
export interface BlueprintProduct {
    /** Pre-generated UUID */
    id: string;

    /** Product name (placeholder before hydration, e.g., "Product 1") */
    name: string;

    /** Product description (HTML, filled during hydration) */
    description: string;

    /** Product price (random range 9.99 - 299.99) */
    price: number;

    /** Stock quantity (random range 0-100) */
    stock: number;

    /** Primary category (top-level branch this product belongs to) */
    primaryCategoryId: string;

    /** All assigned category IDs (supports cross-category assignment) */
    categoryIds: string[];

    /** Metadata for post-processors */
    metadata: ProductMetadata;
}

/** Product metadata for post-processors (stored in cache) */
export interface ProductMetadata {
    // Image generation
    /** Number of images to generate (1-3) */
    imageCount: 1 | 2 | 3;

    /** Base image prompt describing the product (for consistent multi-view images) */
    baseImagePrompt?: string;

    /** Image descriptions with views and prompts (filled during hydration) */
    imageDescriptions: ImageDescription[];

    // Variant generation
    /** Whether this product should have variants */
    isVariant: boolean;

    /** Variant configuration for 1-3 property groups with partial options */
    variantConfigs?: VariantConfig[];

    // Properties (filled by AI based on category context)
    /** Product properties (e.g., [{ group: "Color", value: "Oak" }]) */
    properties: ProductProperty[];

    // Manufacturer
    /** Fictional manufacturer name (filled during hydration) */
    manufacturerName?: string;

    // Reviews
    /** Number of reviews to generate (variable distribution) */
    reviewCount: ReviewCount;

    // Pricing
    /** Whether this product has a sale price */
    hasSalesPrice: boolean;

    /** Sale percentage (e.g., 0.2 = 20% off) */
    salePercentage?: number;
}

/** Variant configuration for a single property group */
export interface VariantConfig {
    /** Property group name (e.g., "Size", "Color", "Material") */
    group: string;

    /** Selected options for this property (40-60% of available options) */
    selectedOptions: string[];

    /** Price modifiers per option (e.g., { "XL": 1.2, "S": 0.9 }) */
    priceModifiers: Record<string, number>;
}

/** Allowed review counts for realistic distribution */
export type ReviewCount = 0 | 1 | 2 | 3 | 5 | 8 | 10;

/** Image description for image processor */
export interface ImageDescription {
    /** View type for the image */
    view: ImageView;

    /** AI-generated prompt for image generation */
    prompt: string;
}

/** Supported image view types */
export type ImageView = "front" | "side" | "detail" | "lifestyle" | "packaging";

/** Product property assignment */
export interface ProductProperty {
    /** Property group name (e.g., "Color", "Material", "Size") */
    group: string;

    /** Property value (e.g., "Oak", "Wood", "Large") */
    value: string;

    /** Shopware property group ID (synced after creation) */
    groupId?: string;

    /** Shopware property option ID (synced after creation) */
    optionId?: string;
}

// =============================================================================
// Property Group Types
// =============================================================================

/** Property group derived from products after hydration */
export interface BlueprintPropertyGroup {
    /** UUID (generated during collection) */
    id: string;

    /** Property group name */
    name: string;

    /** Display type */
    displayType: "text" | "color";

    /** Unique option values collected from products */
    options: BlueprintPropertyOption[];
}

/** Property option in a blueprint property group */
export interface BlueprintPropertyOption {
    /** UUID (generated during collection) */
    id: string;

    /** Option value */
    name: string;

    /** Hex color code for color-type properties */
    colorHexCode?: string;
}

// =============================================================================
// Generation Configuration
// =============================================================================

/** Configuration for blueprint generation */
export interface BlueprintConfig {
    /** Number of top-level categories (default: 3) */
    topLevelCategories: number;

    /** Maximum category depth (default: 3) */
    maxDepth: number;

    /** Subcategories per level 2 category (default: 3-5) */
    subcategoriesPerCategory: { min: number; max: number };

    /** Total products to generate (default: 90) */
    totalProducts: number;

    /** Products per top-level category branch (default: 30) */
    productsPerBranch: number;

    /** Percentage of categories with images (default: 0.4) */
    categoryImagePercentage: number;

    /** Percentage of products that are variants (default: 0.3) */
    variantPercentage: number;

    /** Percentage of products with sale prices (default: 0.2) */
    salePercentage: number;
}

/** Default blueprint configuration */
export const DEFAULT_BLUEPRINT_CONFIG: BlueprintConfig = {
    topLevelCategories: 3,
    maxDepth: 3,
    subcategoriesPerCategory: { min: 3, max: 5 },
    totalProducts: 90,
    productsPerBranch: 30,
    categoryImagePercentage: 0.4,
    variantPercentage: 0.3,
    salePercentage: 0.2,
};

// =============================================================================
// Manufacturer Types (for Shopware integration)
// =============================================================================

// =============================================================================
// CMS Blueprint Types (for AI text hydration)
// =============================================================================

/** Complete CMS blueprint for a SalesChannel */
export interface CmsBlueprint {
    salesChannelName: string;
    pages: CmsBlueprintPage[];
    hydratedAt?: string;
}

/** A single CMS page with its text content */
export interface CmsBlueprintPage {
    /** Page name matching the fixture (e.g., "Text Elements") */
    name: string;
    /** Processor name (e.g., "cms-text") */
    processor: string;
    /** Sections containing blocks and slots */
    sections: CmsBlueprintSection[];
}

export interface CmsBlueprintSection {
    blocks: CmsBlueprintBlock[];
}

export interface CmsBlueprintBlock {
    type: string;
    position: number;
    slots: CmsBlueprintSlot[];
}

export interface CmsBlueprintSlot {
    type: string;
    slot: string;
    /** AI-hydrated HTML text content (only for text-type slots) */
    textContent?: string;
}

/** Manufacturer entity from Shopware */
export interface Manufacturer {
    /** Shopware UUID */
    id: string;

    /** Manufacturer name */
    name: string;

    /** Description */
    description?: string;

    /** Website URL */
    link?: string;

    /** Media ID for logo */
    mediaId?: string;
}
