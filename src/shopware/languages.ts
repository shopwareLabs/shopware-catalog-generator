/**
 * SalesChannel languages and which content each language gets.
 *
 * Shopware writes root fields into the system default language, which is not always
 * English. The upload code therefore resolves every language to either the English
 * source, a translation file, or nothing (Shopware falls back to the system language).
 */

import type { ShopLanguage, ShopLanguages, TranslationFile } from "../types/index.js";
import type { ShopwareApi } from "./api-helpers.js";

/** `Defaults::LANGUAGE_SYSTEM` - the same ID in every Shopware installation */
export const SYSTEM_LANGUAGE_ID = "2fbb5fe2e29a4d70aa5854ce7ce3e20b";

interface LanguageRow {
    id: string;
    locale?: { code?: string } | null;
}

interface SalesChannelLanguagesRow {
    languages?: LanguageRow[] | null;
}

function toShopLanguage(row: LanguageRow): ShopLanguage {
    return {
        id: row.id,
        locale: row.locale?.code ?? "",
        isSystem: row.id === SYSTEM_LANGUAGE_ID,
    };
}

/**
 * Read the system language and the languages assigned to a SalesChannel.
 */
export async function getShopLanguages(
    api: Pick<ShopwareApi, "searchEntities" | "getEntity">,
    salesChannelId: string
): Promise<ShopLanguages> {
    const [channels, system] = await Promise.all([
        api.searchEntities<SalesChannelLanguagesRow>("sales-channel", [], {
            ids: [salesChannelId],
            limit: 1,
            associations: { languages: { associations: { locale: {} } } },
        }),
        api.getEntity<LanguageRow>("language", SYSTEM_LANGUAGE_ID, { locale: {} }),
    ]);

    const rows = channels[0]?.languages ?? [];
    return {
        system: toShopLanguage(system ?? { id: SYSTEM_LANGUAGE_ID }),
        salesChannel: rows.map(toShopLanguage).filter((l) => l.locale),
    };
}

/** Content for one language: the English source or a translation file */
export type LocaleContent = { kind: "source" } | { kind: "translation"; file: TranslationFile };

/** Language part of a locale code ("de-DE" -> "de") */
export function languageOf(locale: string): string {
    return locale.split("-")[0]?.toLowerCase() ?? "";
}

/**
 * Pick the content for a shop locale.
 *
 * - English locales get the English source
 * - Otherwise the translation for the exact locale, then one with the same language
 *   ("de-CH" uses "de-DE" when there is no "de-CH" file)
 * - null when nothing matches (Shopware falls back to the system language)
 */
export function resolveLocaleContent(
    locale: string,
    translations: ReadonlyMap<string, TranslationFile>
): LocaleContent | null {
    if (languageOf(locale) === "en") return { kind: "source" };

    const exact = translations.get(locale);
    if (exact) return { kind: "translation", file: exact };

    const sameLanguage = [...translations.values()].find(
        (file) => languageOf(file.locale) === languageOf(locale)
    );
    return sameLanguage ? { kind: "translation", file: sameLanguage } : null;
}

/** A language together with the content it should show */
export interface LanguageContent {
    language: ShopLanguage;
    content: LocaleContent;
}

/**
 * Languages that need translations written, with their content.
 *
 * The system language is included when its content differs from what was uploaded
 * (a German system language gets the German translation). It is skipped when it would
 * just get the English source again, because the root fields already hold English.
 */
export function planLanguageContent(
    languages: ShopLanguages,
    translations: ReadonlyMap<string, TranslationFile>
): LanguageContent[] {
    const all = [languages.system, ...languages.salesChannel.filter((l) => !l.isSystem)];

    return all.flatMap((language) => {
        const content = resolveLocaleContent(language.locale, translations);
        if (!content) return [];
        if (language.isSystem && content.kind === "source") return [];
        return [{ language, content }];
    });
}

/**
 * SalesChannel languages that can show reviews, with their content.
 *
 * `product_review` has a single `languageId` and no translations, so every review is
 * written in exactly one language. Unlike `planLanguageContent`, English languages
 * (including an English system language) are kept here.
 */
export function planReviewLanguages(
    languages: ShopLanguages,
    translations: ReadonlyMap<string, TranslationFile>
): LanguageContent[] {
    return languages.salesChannel.flatMap((language) => {
        const content = resolveLocaleContent(language.locale, translations);
        return content ? [{ language, content }] : [];
    });
}

interface TranslationStore {
    listTranslationLocales(salesChannel: string): string[];
    loadTranslations(salesChannel: string, locale: string): TranslationFile | null;
}

/** All translation files of a SalesChannel, keyed by locale */
export function loadAllTranslations(
    cache: TranslationStore,
    salesChannelName: string
): Map<string, TranslationFile> {
    return new Map(
        cache
            .listTranslationLocales(salesChannelName)
            .flatMap((locale): Array<[string, TranslationFile]> => {
                const file = cache.loadTranslations(salesChannelName, locale);
                return file ? [[locale, file]] : [];
            })
    );
}
