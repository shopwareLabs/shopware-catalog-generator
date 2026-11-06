/**
 * Shared data for translation upload tests.
 */

import type { LanguageContent } from "../../src/shopware/languages.js";
import type { ShopLanguage, TranslationFile } from "../../src/types/index.js";

import { SYSTEM_LANGUAGE_ID } from "../../src/shopware/languages.js";

export const EN: ShopLanguage = { id: SYSTEM_LANGUAGE_ID, locale: "en-GB", isSystem: true };
export const DE: ShopLanguage = { id: "lang-de", locale: "de-DE", isSystem: false };
export const DE_SYSTEM: ShopLanguage = { id: SYSTEM_LANGUAGE_ID, locale: "de-DE", isSystem: true };
export const EN_EXTRA: ShopLanguage = { id: "lang-en", locale: "en-GB", isSystem: false };

export function createTranslationFile(overrides: Partial<TranslationFile> = {}): TranslationFile {
    return {
        locale: "de-DE",
        sourceLocale: "en-GB",
        translatedAt: "2026-11-06T00:00:00.000Z",
        style: { formality: "informal" },
        glossary: {},
        categories: {},
        products: {},
        propertyGroups: {},
        reviews: {},
        cms: {},
        fixtures: {},
        ...overrides,
    };
}

export function source(language: ShopLanguage): LanguageContent {
    return { language, content: { kind: "source" } };
}

export function translation(language: ShopLanguage, file: TranslationFile): LanguageContent {
    return { language, content: { kind: "translation", file } };
}
