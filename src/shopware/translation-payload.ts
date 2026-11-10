/**
 * Translation payloads - turn translation files into Shopware sync operations.
 *
 * Pure functions (no API calls), so they can be unit-tested. Every entity is written as
 * `{ id, translations: { <languageId>: fields } }`. Keying by language ID instead of root
 * fields means the system language is handled like any other: a German system language
 * simply gets the German texts.
 */

import type {
    BlueprintProduct,
    BlueprintPropertyGroup,
    ColorFamily,
    HydratedBlueprint,
    Manufacturer,
    TranslationSource,
} from "../types/index.js";
import type { SyncOperation } from "./api-types.js";
import type { LanguageContent } from "./languages.js";

import {
    COLOR_FAMILY_GROUP_NAME,
    colorFamilyTranslation,
    fillFixtureText,
    footerTextKey,
    localizedFixtureText,
    packagingTextKey,
    productMediaTexts,
} from "../fixtures/index.js";
import { buildBlueprintCategoryPathMap, chunkArray, deriveProductSeoMeta } from "../utils/index.js";

type Fields = Record<string, unknown>;
type TranslationsByLanguage = Record<string, Fields>;

/** CMS page as read from Shopware (sections > blocks > slots) */
export interface CmsPageStructure {
    /** Fixture page name (without the store suffix) */
    pageName: string;
    sections: Array<{
        position: number;
        blocks: Array<{
            position: number;
            slots: Array<{ id: string; slot: string; config?: Record<string, unknown> | null }>;
        }>;
    }>;
}

export interface TranslationPayloadInput {
    blueprint: HydratedBlueprint;
    /** English source (same structure the translator used) */
    source: TranslationSource;
    languages: LanguageContent[];
    manufacturers: Manufacturer[];
    cmsPages: CmsPageStructure[];
    /** Shop supports product.ogTitle / ogDescription */
    openGraph: boolean;
    /** Units created by the generator, matched by their English short code */
    units?: Array<{ id: string; shortCode: string }>;
    /** Demo promotions, matched by code */
    promotions?: Array<{ id: string; code: string }>;
    /** Product images with the view they show (front, side, ...) */
    productMedia?: Array<{ mediaId: string; productId: string; view: string }>;
    /** Category banner images */
    categoryMedia?: Array<{ mediaId: string; categoryId: string }>;
    /** Homepage CMS page and its slot HTML per language (built from fixture texts) */
    home?: {
        page: CmsPageStructure;
        slotTexts: (texts: FixtureTexts) => Record<string, string>;
    };
    /** Footer categories, matched by their English name */
    footerCategories?: Array<{ id: string; name: string }>;
}

/** Fixture texts of one language, null for the English source */
export type FixtureTexts = Readonly<Record<string, string>> | null;

function fixtureTextsOf({ content }: LanguageContent): FixtureTexts {
    return content.kind === "source" ? null : content.file.fixtures;
}

/**
 * Languages other than the system language.
 *
 * Entities the generator finds again by name or short code (units, footer categories)
 * must keep their English root values, which live in the system language.
 */
function nonSystemLanguages(languages: LanguageContent[]): LanguageContent[] {
    return languages.filter(({ language }) => !language.isSystem);
}

/** Translated product name, English when there is no translation */
function productNameIn(
    productId: string,
    { content }: LanguageContent,
    source: TranslationSource
): string | undefined {
    const english = source.products[productId]?.name;
    if (content.kind === "source") return english;
    return content.file.products[productId]?.name ?? english;
}

function withTranslations(id: string, perLanguage: Array<[string, Fields | null]>): Fields | null {
    const translations: TranslationsByLanguage = Object.fromEntries(
        perLanguage.filter((entry): entry is [string, Fields] => entry[1] !== null)
    );
    return Object.keys(translations).length > 0 ? { id, translations } : null;
}

function compact(payload: Array<Fields | null>): Fields[] {
    return payload.filter((p): p is Fields => p !== null);
}

/** Packaging labels ("Pack" / "Packs") of a product in one language */
function packagingFields(product: BlueprintProduct, texts: FixtureTexts): Fields {
    const packaging = product.metadata.packaging;
    if (!packaging) return {};
    // Labels that are not fixture texts (older blueprints) stay as they are
    const label = (value: string): string => {
        const key = packagingTextKey(value);
        const text = localizedFixtureText(key, texts);
        return text === key ? value : text;
    };
    return {
        packUnit: label(packaging.packUnit),
        packUnitPlural: label(packaging.packUnitPlural),
    };
}

/** Product texts for one language */
function productFields(
    product: BlueprintProduct,
    languageContent: LanguageContent,
    source: TranslationSource,
    openGraph: boolean
): Fields | null {
    const { content } = languageContent;
    const english = source.products[product.id];
    const texts = content.kind === "source" ? english : content.file.products[product.id];
    if (!texts) return null;

    // Translations derive their meta texts like English does. Translation files from older
    // runs contain AI-translated meta descriptions that can exceed Shopware's 255 characters.
    const { metaTitle, metaDescription } =
        content.kind === "source" ? texts : deriveProductSeoMeta(texts.name, texts.description);
    return {
        name: texts.name,
        description: texts.description,
        ...(metaTitle && { metaTitle }),
        ...(metaDescription && { metaDescription }),
        ...(openGraph && {
            ogTitle: metaTitle ?? texts.name,
            ...(metaDescription && { ogDescription: metaDescription }),
        }),
        ...packagingFields(product, fixtureTextsOf(languageContent)),
    };
}

export function buildProductTranslations(input: TranslationPayloadInput): Fields[] {
    return compact(
        input.blueprint.products.map((p) =>
            withTranslations(
                p.id,
                input.languages.map((lc) => [
                    lc.language.id,
                    productFields(p, lc, input.source, input.openGraph),
                ])
            )
        )
    );
}

export function buildCategoryTranslations(input: TranslationPayloadInput): Fields[] {
    const pathToId = buildBlueprintCategoryPathMap(input.blueprint.categories);

    return compact(
        [...pathToId].map(([path, id]) =>
            withTranslations(
                id,
                input.languages.map(({ language, content }) => {
                    const texts =
                        content.kind === "source"
                            ? input.source.categories[path]
                            : content.file.categories[path];
                    return [
                        language.id,
                        texts ? { name: texts.name, description: texts.description } : null,
                    ];
                })
            )
        )
    );
}

export function buildPropertyGroupTranslations(input: TranslationPayloadInput): {
    groups: Fields[];
    options: Fields[];
} {
    const groupTranslation = (groupName: string, content: LanguageContent["content"]) =>
        content.kind === "source"
            ? { name: groupName, options: null }
            : content.file.propertyGroups[groupName];

    // The colour family group and its options have fixed translations (no AI needed)
    const fixedFamilyName = (
        group: BlueprintPropertyGroup,
        locale: string,
        content: LanguageContent["content"],
        family?: ColorFamily
    ): string | undefined =>
        content.kind !== "source" && group.name === COLOR_FAMILY_GROUP_NAME
            ? colorFamilyTranslation(locale, family)
            : undefined;

    const groups = input.blueprint.propertyGroups.map((group) =>
        withTranslations(
            group.id,
            input.languages.map(({ language, content }) => {
                const fixed = fixedFamilyName(group, language.locale, content);
                if (fixed) return [language.id, { name: fixed }];
                const translated = groupTranslation(group.name, content);
                return [language.id, translated ? { name: translated.name } : null];
            })
        )
    );

    const options = input.blueprint.propertyGroups.flatMap((group) =>
        group.options.map((option) =>
            withTranslations(
                option.id,
                input.languages.map(({ language, content }) => {
                    const fixed = option.family
                        ? fixedFamilyName(group, language.locale, content, option.family)
                        : undefined;
                    if (fixed) return [language.id, { name: fixed }];
                    const translated = groupTranslation(group.name, content);
                    if (!translated) return [language.id, null];
                    const name = translated.options?.[option.name] ?? option.name;
                    return [language.id, { name }];
                })
            )
        )
    );

    return { groups: compact(groups), options: compact(options) };
}

export function buildManufacturerTranslations(input: TranslationPayloadInput): Fields[] {
    const englishTemplate = input.source.fixtures["manufacturer.description"];
    if (!englishTemplate) return [];

    return compact(
        input.manufacturers.map((m) =>
            withTranslations(
                m.id,
                input.languages.map(({ language, content }) => {
                    const template =
                        content.kind === "source"
                            ? englishTemplate
                            : content.file.fixtures["manufacturer.description"];
                    return [
                        language.id,
                        template
                            ? { description: fillFixtureText(template, { name: m.name }) }
                            : null,
                    ];
                })
            )
        )
    );
}

/** Translated slot HTML for one language, keyed by "<section>.<block>.<slot>" */
function cmsSlotTexts(
    pageName: string,
    content: LanguageContent["content"],
    source: TranslationSource
): Record<string, string> | null {
    if (content.kind === "source") return source.cms[pageName] ?? null;
    return content.file.cms[pageName]?.slots ?? null;
}

/** Slot translations of one page; `textsFor` returns the slot HTML of a language */
function pageSlotTranslations(
    page: CmsPageStructure,
    languages: LanguageContent[],
    textsFor: (languageContent: LanguageContent) => Record<string, string> | null
): Array<Fields | null> {
    const perLanguage = languages.map((lc): [string, Record<string, string> | null] => [
        lc.language.id,
        textsFor(lc),
    ]);
    return page.sections.flatMap((section) =>
        section.blocks.flatMap((block) =>
            block.slots.map((slot) => {
                const key = `${section.position}.${block.position}.${slot.slot}`;
                return withTranslations(
                    slot.id,
                    perLanguage.map(([languageId, texts]) => {
                        const html = texts?.[key];
                        if (!html) return [languageId, null];
                        const config = {
                            ...(slot.config ?? {}),
                            content: { source: "static", value: html },
                        };
                        return [languageId, { config }];
                    })
                );
            })
        )
    );
}

export function buildCmsSlotTranslations(input: TranslationPayloadInput): Fields[] {
    const pages = input.cmsPages.flatMap((page) =>
        pageSlotTranslations(page, input.languages, ({ content }) =>
            cmsSlotTexts(page.pageName, content, input.source)
        )
    );
    const home = input.home;
    const homeSlots = home
        ? pageSlotTranslations(home.page, input.languages, (lc) =>
              home.slotTexts(fixtureTextsOf(lc))
          )
        : [];
    return compact([...pages, ...homeSlots]);
}

/** Unit name and short code; never the system language (units are found by short code) */
export function buildUnitTranslations(input: TranslationPayloadInput): Fields[] {
    const languages = nonSystemLanguages(input.languages);
    return compact(
        (input.units ?? []).map((unit) =>
            withTranslations(
                unit.id,
                languages.map((lc) => {
                    const texts = fixtureTextsOf(lc);
                    return [
                        lc.language.id,
                        {
                            name: localizedFixtureText(`unit.${unit.shortCode}.name`, texts),
                            shortCode: localizedFixtureText(
                                `unit.${unit.shortCode}.shortCode`,
                                texts
                            ),
                        },
                    ];
                })
            )
        )
    );
}

/** Promotion names (promotions are found by code, so the system language is fine) */
export function buildPromotionTranslations(input: TranslationPayloadInput): Fields[] {
    return compact(
        (input.promotions ?? []).map((promotion) =>
            withTranslations(
                promotion.id,
                input.languages.map((lc) => [
                    lc.language.id,
                    {
                        name: localizedFixtureText(
                            `promotion.${promotion.code}.name`,
                            fixtureTextsOf(lc)
                        ),
                    },
                ])
            )
        )
    );
}

/** Alt text and title of product and category images */
export function buildMediaTranslations(input: TranslationPayloadInput): Fields[] {
    const products = (input.productMedia ?? []).map((media) =>
        withTranslations(
            media.mediaId,
            input.languages.map((lc) => {
                const name = productNameIn(media.productId, lc, input.source);
                if (!name) return [lc.language.id, null];
                return [lc.language.id, productMediaTexts(name, media.view, fixtureTextsOf(lc))];
            })
        )
    );

    const idToPath = new Map(
        [...buildBlueprintCategoryPathMap(input.blueprint.categories)].map(([path, id]) => [
            id,
            path,
        ])
    );
    const categories = (input.categoryMedia ?? []).map((media) => {
        const path = idToPath.get(media.categoryId);
        if (!path) return null;
        return withTranslations(
            media.mediaId,
            input.languages.map(({ language, content }) => {
                const texts =
                    content.kind === "source"
                        ? input.source.categories[path]
                        : content.file.categories[path];
                if (!texts) return [language.id, null];
                return [language.id, { alt: texts.name, title: texts.name }];
            })
        );
    });

    return compact([...products, ...categories]);
}

/** Footer category names; never the system language (they are found by name) */
export function buildFooterCategoryTranslations(input: TranslationPayloadInput): Fields[] {
    const languages = nonSystemLanguages(input.languages);
    return compact(
        (input.footerCategories ?? []).map((category) =>
            withTranslations(
                category.id,
                languages.map((lc) => [
                    lc.language.id,
                    {
                        name: localizedFixtureText(
                            footerTextKey(category.name),
                            fixtureTextsOf(lc)
                        ),
                    },
                ])
            )
        )
    );
}

/** Max records per sync operation */
const SYNC_CHUNK_SIZE = 100;

function chunkedOperations(
    prefix: string,
    entity: string,
    payload: Fields[]
): Record<string, SyncOperation> {
    if (payload.length === 0) return {};
    return Object.fromEntries(
        chunkArray(payload, SYNC_CHUNK_SIZE).map((chunk, i) => [
            `${prefix}-${i}`,
            { entity, action: "upsert", payload: chunk },
        ])
    );
}

/**
 * Build all translation sync operations for one SalesChannel.
 */
export function buildTranslationOperations(
    input: TranslationPayloadInput
): Record<string, SyncOperation> {
    if (input.languages.length === 0) return {};

    const { groups, options } = buildPropertyGroupTranslations(input);
    return {
        ...chunkedOperations("translate-product", "product", buildProductTranslations(input)),
        ...chunkedOperations("translate-category", "category", buildCategoryTranslations(input)),
        ...chunkedOperations("translate-property-group", "property_group", groups),
        ...chunkedOperations("translate-property-option", "property_group_option", options),
        ...chunkedOperations(
            "translate-manufacturer",
            "product_manufacturer",
            buildManufacturerTranslations(input)
        ),
        ...chunkedOperations("translate-cms-slot", "cms_slot", buildCmsSlotTranslations(input)),
        ...chunkedOperations("translate-unit", "unit", buildUnitTranslations(input)),
        ...chunkedOperations("translate-promotion", "promotion", buildPromotionTranslations(input)),
        ...chunkedOperations("translate-media", "media", buildMediaTranslations(input)),
        ...chunkedOperations(
            "translate-footer-category",
            "category",
            buildFooterCategoryTranslations(input)
        ),
    };
}
