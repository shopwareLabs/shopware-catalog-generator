/**
 * Shopware API entity types and Zod schemas for validation
 */

import { z } from "zod";

// =============================================================================
// Zod Schemas (for AI response validation)
// =============================================================================

/**
 * Product definition schema for AI-generated products
 */
export const ProductDefinition = z.object({
    name: z.string(),
    description: z.string(),
    price: z.number(),
    stock: z.number(),
});

/**
 * Property option schema
 */
export const PropertyOptionDefinition = z.object({
    name: z.string(),
    colorHexCode: z.string().optional(),
});

/**
 * Property group schema for AI-generated property groups
 */
export const PropertyGroupDefinition = z.object({
    name: z.string(),
    description: z.string(),
    displayType: z.enum(["text", "color"]),
    options: z.array(PropertyOptionDefinition),
});

/**
 * Product review schema for AI-generated reviews
 */
export const ProductReviewDefinition = z.object({
    externalUser: z.string(),
    externalEmail: z.string(),
    title: z.string(),
    content: z.string(),
    points: z.number().int(),
    status: z.boolean(),
});

// =============================================================================
// TypeScript Interfaces (for app-wide type safety)
// =============================================================================

/** Sales channel entity (basic) */
export interface SalesChannel {
    id: string;
    navigationCategoryId: string;
    currencyId?: string;
}

/** Full SalesChannel with all cloneable properties */
export interface SalesChannelFull extends SalesChannel {
    name: string;
    typeId: string;
    languageId: string;
    paymentMethodId: string;
    shippingMethodId: string;
    countryId: string;
    customerGroupId: string;
    accessKey?: string; // Optional - not returned when fetching existing SalesChannels
    snippetSetId?: string;
}

/** SalesChannel generation input */
export interface SalesChannelInput {
    /** Name of the sales channel (validated for subdomain compatibility) */
    name: string;
    /** Description/context for AI generation */
    description: string;
    /** Base URL for the sales channel (e.g., "http://furniture.localhost:8000") */
    baseUrl?: string;
}

/** Product image data */
export interface ProductImage {
    name: string;
    type?: string;
    data: string;
}

/** Property option entity - extends Zod-inferred type with optional fields */
export interface PropertyOption extends z.infer<typeof PropertyOptionDefinition> {
    id?: string;
    [key: string]: unknown;
}

/** Product review entity - extends Zod-inferred type with optional fields */
export interface ProductReview extends z.infer<typeof ProductReviewDefinition> {
    salesChannelId?: string;
    [key: string]: unknown;
}

/** Property group entity - extends Zod-inferred type with optional fields */
export interface PropertyGroup {
    id?: string;
    name: string;
    description: string;
    displayType: string; // More permissive than schema (allows "image" from Shopware)
    options: PropertyOption[];
}

/** Product input for creating products - extends Zod-inferred type */
export interface ProductInput extends z.infer<typeof ProductDefinition> {
    id?: string;
    productReviews?: ProductReview[];
    options?: PropertyOption[];
    image?: ProductImage;
}

// =============================================================================
// Shopware Sync Payload Types
// =============================================================================

/** Price entry in a Shopware product sync payload */
export interface PricePayload {
    currencyId: string;
    gross: number;
    net: number;
    linked: boolean;
    listPrice?: {
        currencyId: string;
        gross: number;
        net: number;
        linked: boolean;
    };
}

/** Product visibility in a sync payload */
export interface ProductVisibilityPayload {
    id?: string;
    productId: string;
    salesChannelId: string;
    visibility: number;
}

/** Tiered price entry for quantity-based pricing */
export interface TieredPricePayload {
    ruleId: string;
    quantityStart: number;
    quantityEnd?: number;
    price: PricePayload[];
}

/** Product sync payload for Shopware _action/sync */
export interface ProductSyncPayload {
    id: string;
    productNumber: string;
    name: string;
    description: string;
    stock: number;
    taxId: string;
    price: PricePayload[];
    visibilities?: ProductVisibilityPayload[];
    categories?: Array<{ id: string }>;
    markAsTopseller?: boolean;
    shippingFree?: boolean;
    weight?: number;
    width?: number;
    height?: number;
    length?: number;
    ean?: string;
    manufacturerNumber?: string;
    releaseDate?: string;
    deliveryTimeId?: string;
    minPurchase?: number;
    purchaseSteps?: number;
    maxPurchase?: number;
    metaTitle?: string;
    metaDescription?: string;
    properties?: Array<{ id: string }>;
    prices?: TieredPricePayload[];
    /** Allows additional Shopware-specific fields without casting */
    [key: string]: unknown;
}

/** Media entity sync payload (for creating media records) */
export interface MediaEntityPayload {
    id: string;
    private: boolean;
    mediaFolderId?: string;
    [key: string]: unknown;
}

/** Address nested inside a CustomerSyncPayload */
export interface CustomerAddressPayload {
    id: string;
    customerId: string;
    salutationId: string;
    firstName: string;
    lastName: string;
    street: string;
    zipcode: string;
    city: string;
    countryId: string;
    [key: string]: unknown;
}

/** Customer sync payload for Shopware _action/sync */
export interface CustomerSyncPayload {
    id: string;
    customerNumber: string;
    salesChannelId: string;
    groupId: string;
    defaultPaymentMethodId: string;
    languageId: string;
    email: string;
    firstName: string;
    lastName: string;
    salutationId: string;
    password: string;
    defaultBillingAddressId: string;
    defaultShippingAddressId: string;
    addresses: CustomerAddressPayload[];
    [key: string]: unknown;
}

/** Category sync payload for Shopware _action/sync (page, link, folder types) */
export interface CategorySyncPayload {
    id: string;
    parentId: string;
    name: string;
    active: boolean;
    type: "page" | "link" | "folder";
    visible?: boolean;
    displayNestedProducts?: boolean;
    cmsPageId?: string;
    afterCategoryId?: string;
    linkType?: "landing_page" | "external";
    internalLink?: string;
    externalLink?: string;
    linkNewTab?: boolean;
    [key: string]: unknown;
}

/** Partial SalesChannel update payload (e.g. footer/service category assignment) */
export interface SalesChannelUpdatePayload {
    id: string;
    footerCategoryId?: string | null;
    serviceCategoryId?: string | null;
    [key: string]: unknown;
}

/** Promotion discount payload for Shopware _action/sync */
export interface PromotionDiscountPayload {
    id: string;
    scope: string;
    type: string;
    value: number;
    considerAdvancedRules: boolean;
    maxValue?: number;
    [key: string]: unknown;
}

/** Category tree node for generation */
export interface CategoryNode {
    /** UUID assigned after creation in Shopware */
    id?: string;
    /** Category name */
    name: string;
    /** AI-generated description */
    description: string;
    /** Child categories */
    children: CategoryNode[];
    /** Number of products to assign to this category (AI-determined weight) */
    productCount: number;
    /** Whether this category should have an image */
    hasImage: boolean;
    /** Image data (populated after generation) */
    image?: ProductImage;
}
