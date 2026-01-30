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
