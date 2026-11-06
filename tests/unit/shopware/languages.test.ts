import { describe, expect, test } from "bun:test";

import {
    getShopLanguages,
    languageOf,
    loadAllTranslations,
    planLanguageContent,
    planReviewLanguages,
    resolveLocaleContent,
    SYSTEM_LANGUAGE_ID,
} from "../../../src/shopware/languages.js";
import {
    createTranslationFile,
    DE,
    DE_SYSTEM,
    EN,
    EN_EXTRA,
} from "../../helpers/translation-factory.js";

const DE_FILE = createTranslationFile({ locale: "de-DE" });
const TRANSLATIONS = new Map([["de-DE", DE_FILE]]);

describe("languageOf", () => {
    test("returns the lower-case language part", () => {
        expect(languageOf("de-DE")).toBe("de");
        expect(languageOf("EN")).toBe("en");
    });
});

describe("resolveLocaleContent", () => {
    test("English locales use the source", () => {
        expect(resolveLocaleContent("en-US", TRANSLATIONS)).toEqual({ kind: "source" });
    });

    test("exact locale match", () => {
        expect(resolveLocaleContent("de-DE", TRANSLATIONS)).toEqual({
            kind: "translation",
            file: DE_FILE,
        });
    });

    test("same language falls back to another region", () => {
        expect(resolveLocaleContent("de-CH", TRANSLATIONS)).toEqual({
            kind: "translation",
            file: DE_FILE,
        });
    });

    test("null when nothing matches", () => {
        expect(resolveLocaleContent("fr-FR", TRANSLATIONS)).toBeNull();
    });
});

describe("planLanguageContent", () => {
    test("English system language is skipped, German gets the translation", () => {
        const plan = planLanguageContent({ system: EN, salesChannel: [EN, DE] }, TRANSLATIONS);
        expect(plan).toEqual([{ language: DE, content: { kind: "translation", file: DE_FILE } }]);
    });

    test("German system language gets the German translation and English gets the source", () => {
        const plan = planLanguageContent(
            { system: DE_SYSTEM, salesChannel: [DE_SYSTEM, EN_EXTRA] },
            TRANSLATIONS
        );
        expect(plan).toEqual([
            { language: DE_SYSTEM, content: { kind: "translation", file: DE_FILE } },
            { language: EN_EXTRA, content: { kind: "source" } },
        ]);
    });

    test("languages without content are left out", () => {
        const fr = { id: "lang-fr", locale: "fr-FR", isSystem: false };
        const plan = planLanguageContent({ system: EN, salesChannel: [EN, fr] }, TRANSLATIONS);
        expect(plan).toEqual([]);
    });
});

describe("planReviewLanguages", () => {
    test("keeps English languages, including the system language", () => {
        const plan = planReviewLanguages({ system: EN, salesChannel: [EN, DE] }, TRANSLATIONS);
        expect(plan.map((l) => l.language.locale)).toEqual(["en-GB", "de-DE"]);
    });

    test("leaves out languages without content", () => {
        const fr = { id: "lang-fr", locale: "fr-FR", isSystem: false };
        const plan = planReviewLanguages({ system: EN, salesChannel: [EN, fr] }, new Map());
        expect(plan.map((l) => l.language.locale)).toEqual(["en-GB"]);
    });
});

describe("loadAllTranslations", () => {
    test("maps every readable locale to its file", () => {
        const cache = {
            listTranslationLocales: () => ["de-DE", "fr-FR"],
            loadTranslations: (_: string, locale: string) => (locale === "de-DE" ? DE_FILE : null),
        };
        expect([...loadAllTranslations(cache, "store").keys()]).toEqual(["de-DE"]);
    });
});

describe("getShopLanguages", () => {
    test("reads SalesChannel languages and the system language", async () => {
        const api = {
            searchEntities: async <T>(): Promise<T[]> => {
                const rows = [
                    {
                        languages: [
                            { id: SYSTEM_LANGUAGE_ID, locale: { code: "en-GB" } },
                            { id: "lang-de", locale: { code: "de-DE" } },
                            { id: "lang-broken", locale: null },
                        ],
                    },
                ];
                return rows as T[];
            },
            getEntity: async <T>(): Promise<T | null> => {
                const row = { id: SYSTEM_LANGUAGE_ID, locale: { code: "en-GB" } };
                return row as T;
            },
        };
        const languages = await getShopLanguages(api, "sc-1");
        expect(languages.system).toEqual(EN);
        expect(languages.salesChannel).toEqual([EN, DE]);
    });
});
