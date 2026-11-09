/**
 * Translation types - per-locale catalog content produced by the translate pass.
 *
 * English (the hydrated blueprint) is the source of truth. Each additional locale is
 * stored in `translations/{locale}.json`. Entries are keyed by values that survive the
 * Shopware ID remapping done during sync:
 * - categories: English category path ("Parent > Child")
 * - products: product ID (never remapped)
 * - property groups/options: English group and option names
 * - reviews: product ID (one entry per review index)
 * - cms: fixture page name, then "<sectionIndex>.<blockPosition>.<slot>"
 */

import { z } from "zod";

/** Locale of the source content (hydrated blueprint, CMS blueprint, fixtures) */
export const SOURCE_LOCALE = "en-GB";

export const FormalitySchema = z.enum(["formal", "informal"]);
export type Formality = z.infer<typeof FormalitySchema>;

const SourceHashed = { sourceHash: z.string() };

export const CategoryTranslationSchema = z.object({
    name: z.string(),
    description: z.string(),
    ...SourceHashed,
});
export type CategoryTranslation = z.infer<typeof CategoryTranslationSchema>;

export const ProductTranslationSchema = z.object({
    name: z.string(),
    description: z.string(),
    metaTitle: z.string().optional(),
    metaDescription: z.string().optional(),
    ...SourceHashed,
});
export type ProductTranslation = z.infer<typeof ProductTranslationSchema>;

export const PropertyGroupTranslationSchema = z.object({
    name: z.string(),
    /** English option name -> translated option name */
    options: z.record(z.string(), z.string()),
});
export type PropertyGroupTranslation = z.infer<typeof PropertyGroupTranslationSchema>;

export const ReviewTranslationSchema = z.object({
    title: z.string(),
    content: z.string(),
});
export type ReviewTranslation = z.infer<typeof ReviewTranslationSchema>;

export const ProductReviewsTranslationSchema = z.object({
    reviews: z.array(ReviewTranslationSchema),
    ...SourceHashed,
});
export type ProductReviewsTranslation = z.infer<typeof ProductReviewsTranslationSchema>;

export const CmsPageTranslationSchema = z.object({
    /** Slot key "<sectionIndex>.<blockPosition>.<slot>" -> translated HTML */
    slots: z.record(z.string(), z.string()),
    ...SourceHashed,
});
export type CmsPageTranslation = z.infer<typeof CmsPageTranslationSchema>;

export const TranslationFileSchema = z.object({
    locale: z.string(),
    sourceLocale: z.string(),
    translatedAt: z.string(),
    style: z.object({ formality: FormalitySchema }),
    /** Shared terms (category, property group and option names): English -> translated */
    glossary: z.record(z.string(), z.string()),
    categories: z.record(z.string(), CategoryTranslationSchema),
    products: z.record(z.string(), ProductTranslationSchema),
    /** Keyed by English group name */
    propertyGroups: z.record(z.string(), PropertyGroupTranslationSchema),
    reviews: z.record(z.string(), ProductReviewsTranslationSchema),
    cms: z.record(z.string(), CmsPageTranslationSchema),
    /** Fixture texts (e.g. "manufacturer.description"), English key -> translated text */
    fixtures: z.record(z.string(), z.string()),
});
export type TranslationFile = z.infer<typeof TranslationFileSchema>;

/** Source content handed to the translator (English) */
export interface TranslationSource {
    categories: Record<string, { name: string; description: string }>;
    products: Record<
        string,
        { name: string; description: string; metaTitle?: string; metaDescription?: string }
    >;
    propertyGroups: Record<string, { name: string; options: string[] }>;
    reviews: Record<string, ReviewTranslation[]>;
    cms: Record<string, Record<string, string>>;
    fixtures: Record<string, string>;
}

/**
 * Which languages to translate into.
 * - none: English only
 * - all: every language of the SalesChannel (or the default list for a new one)
 * - list: explicit locale codes
 */
export type LanguageSelection =
    | { mode: "none" }
    | { mode: "all" }
    | { mode: "list"; locales: string[] };

/** A Shopware language as seen by the upload code */
export interface ShopLanguage {
    id: string;
    /** Locale code, e.g. "de-DE" */
    locale: string;
    /** True for Shopware's system default language (root fields are stored in it) */
    isSystem: boolean;
}

/** Languages relevant for uploading translations to one SalesChannel */
export interface ShopLanguages {
    /** Shopware's system default language */
    system: ShopLanguage;
    /** Languages assigned to the SalesChannel (may or may not include the system language) */
    salesChannel: ShopLanguage[];
}
