/**
 * Promotion Fixtures - Pre-defined promotions for testing discount codes
 *
 * These promotions are created by the promotion post-processor
 * and displayed on the homepage so testers can use them immediately.
 */

/** Promotion discount scope */
export type DiscountScope = "cart" | "delivery";

/** Promotion discount type */
export type DiscountType = "percentage" | "absolute";

/** Promotion definition */
export interface PromotionDefinition {
    /** Display name */
    name: string;
    /** Fixed discount code */
    code: string;
    /** Discount type */
    discountType: DiscountType;
    /** Discount value (percentage as whole number, absolute in currency) */
    discountValue: number;
    /** Discount scope */
    scope: DiscountScope;
    /** Maximum discount amount for percentage discounts */
    maxValue?: number;
    /** Whether this promotion grants free shipping */
    freeShipping?: boolean;
}

/** All demo promotions */
export const PROMOTIONS: readonly PromotionDefinition[] = [
    {
        name: "Welcome Discount",
        code: "WELCOME10",
        discountType: "percentage",
        discountValue: 10,
        scope: "cart",
    },
    {
        name: "Summer Sale",
        code: "SUMMER20",
        discountType: "percentage",
        discountValue: 20,
        scope: "cart",
        maxValue: 50,
    },
    {
        name: "Flat $15 Off",
        code: "SAVE15",
        discountType: "absolute",
        discountValue: 15,
        scope: "cart",
    },
    {
        name: "Free Shipping",
        code: "FREESHIP",
        discountType: "percentage",
        discountValue: 100,
        scope: "delivery",
        freeShipping: true,
    },
];
