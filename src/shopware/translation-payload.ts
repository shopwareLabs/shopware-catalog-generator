/**
 * Translation payloads - turn translation files into Shopware sync operations.
 *
 * Pure functions (no API calls), so they can be unit-tested. Every entity is written as
 * `{ id, translations: { <languageId>: fields } }`. Keying by language ID instead of root
 * fields means the system language is handled like any other: a German system language
 * simply gets the German texts.
 */

import type { HydratedBlueprint, Manufacturer, TranslationSource } from "../types/index.js";
import type { SyncOperation } from "./api-types.js";
import type { LanguageContent } from "./languages.js";

import { fillFixtureText } from "../fixtures/index.js";
import { buildBlueprintCategoryPathMap, chunkArray } from "../utils/index.js";

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

/** Product texts for one language */
function productFields(
    productId: string,
    { content }: LanguageContent,
    source: TranslationSource,
    openGraph: boolean
): Fields | null {
    const english = source.products[productId];
    const texts = content.kind === "source" ? english : content.file.products[productId];
    if (!texts) return null;

    const metaTitle = texts.metaTitle;
    const metaDescription = texts.metaDescription;
    return {
        name: texts.name,
        description: texts.description,
        ...(metaTitle && { metaTitle }),
        ...(metaDescription && { metaDescription }),
        ...(openGraph && {
            ogTitle: metaTitle ?? texts.name,
            ...(metaDescription && { ogDescription: metaDescription }),
        }),
    };
}

export function buildProductTranslations(input: TranslationPayloadInput): Fields[] {
    return compact(
        input.blueprint.products.map((p) =>
            withTranslations(
                p.id,
                input.languages.map((lc) => [
                    lc.language.id,
                    productFields(p.id, lc, input.source, input.openGraph),
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

    const groups = input.blueprint.propertyGroups.map((group) =>
        withTranslations(
            group.id,
            input.languages.map(({ language, content }) => {
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

export function buildCmsSlotTranslations(input: TranslationPayloadInput): Fields[] {
    return compact(
        input.cmsPages.flatMap((page) =>
            page.sections.flatMap((section) =>
                section.blocks.flatMap((block) =>
                    block.slots.map((slot) => {
                        const key = `${section.position}.${block.position}.${slot.slot}`;
                        return withTranslations(
                            slot.id,
                            input.languages.map(({ language, content }) => {
                                const html = cmsSlotTexts(page.pageName, content, input.source)?.[
                                    key
                                ];
                                if (!html) return [language.id, null];
                                const config = {
                                    ...(slot.config ?? {}),
                                    content: { source: "static", value: html },
                                };
                                return [language.id, { config }];
                            })
                        );
                    })
                )
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
    };
}
