/**
 * Footer Navigation Fixtures - shared footer and footer-service category trees
 *
 * The cms-footer-pages processor creates these categories once and links them to
 * Shopware's default legal CMS pages. The visible names are translated per language
 * (see translatable-texts.ts).
 */

export interface LegalCategoryConfig {
    categoryName: string;
    parent: "customerServices" | "serviceRoot";
    cmsPageNameCandidates: string[];
}

export const FOOTER_NAVIGATION_ROOT = "Footer-Navigation";
export const FOOTER_SERVICE_NAVIGATION_ROOT = "Footer-Service-Navigation";
export const CUSTOMER_SERVICES_CATEGORY = "Customer Services";

export const LEGAL_CATEGORIES: readonly LegalCategoryConfig[] = [
    {
        categoryName: "Right of rescission",
        parent: "customerServices",
        cmsPageNameCandidates: ["Right of rescission", "Right of withdrawal", "Revocation policy"],
    },
    {
        categoryName: "Payment / Shipping",
        parent: "customerServices",
        cmsPageNameCandidates: [
            "Payment / Shipping",
            "Payment and shipping",
            "Shipping and payment",
        ],
    },
    {
        categoryName: "Privacy",
        parent: "customerServices",
        cmsPageNameCandidates: ["Privacy", "Privacy policy", "Data protection"],
    },
    {
        categoryName: "Terms of service",
        parent: "serviceRoot",
        cmsPageNameCandidates: [
            "Terms of service",
            "Terms and conditions",
            "General terms and conditions",
        ],
    },
    {
        categoryName: "Imprint",
        parent: "serviceRoot",
        cmsPageNameCandidates: ["Imprint", "Legal notice"],
    },
];

/** Category names shown in the storefront footer (translated per language) */
export const FOOTER_CATEGORY_NAMES: readonly string[] = [
    CUSTOMER_SERVICES_CATEGORY,
    ...LEGAL_CATEGORIES.map((c) => c.categoryName),
];
