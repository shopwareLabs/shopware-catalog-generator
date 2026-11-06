import { describe, expect, test } from "bun:test";

import { DEFAULT_DOMAIN_LOCALES } from "../../../src/fixtures/index.js";
import {
    normalizeLocale,
    parseLanguageSelection,
    resolveTargetLocales,
    tryParseLanguageSelection,
} from "../../../src/services/translation-service.js";

describe("normalizeLocale", () => {
    test("normalizes casing and whitespace", () => {
        expect(normalizeLocale(" de-de ")).toBe("de-DE");
        expect(normalizeLocale("FR-ch")).toBe("fr-CH");
    });

    test("throws on language-only or malformed codes", () => {
        expect(() => normalizeLocale("de")).toThrow("Invalid locale");
        expect(() => normalizeLocale("de_DE")).toThrow("Invalid locale");
        expect(() => normalizeLocale("german")).toThrow("Invalid locale");
    });
});

describe("parseLanguageSelection", () => {
    test("returns undefined without a value", () => {
        expect(parseLanguageSelection(undefined)).toBeUndefined();
        expect(parseLanguageSelection("  ")).toBeUndefined();
    });

    test("none and en mean English only", () => {
        expect(parseLanguageSelection("none")).toEqual({ mode: "none" });
        expect(parseLanguageSelection("EN")).toEqual({ mode: "none" });
    });

    test("all selects every SalesChannel language", () => {
        expect(parseLanguageSelection("All")).toEqual({ mode: "all" });
    });

    test("parses a list, dedupes and drops English locales", () => {
        expect(parseLanguageSelection("de-DE, fr-fr,de-de,en-GB,en-US")).toEqual({
            mode: "list",
            locales: ["de-DE", "fr-FR"],
        });
    });

    test("throws on an invalid entry", () => {
        expect(() => parseLanguageSelection("de-DE,french")).toThrow("Invalid locale");
    });
});

describe("tryParseLanguageSelection", () => {
    test("returns the selection on success", () => {
        expect(tryParseLanguageSelection("de-DE")).toEqual({
            selection: { mode: "list", locales: ["de-DE"] },
        });
    });

    test("returns an Error line instead of throwing", () => {
        const result = tryParseLanguageSelection("xx");
        expect(result.selection).toBeUndefined();
        expect(result.error).toStartWith("Error: Invalid locale");
    });
});

describe("resolveTargetLocales", () => {
    const failIfCalled = (): Promise<string[] | null> => {
        throw new Error("readExisting must not be called");
    };

    test("none returns no locales", async () => {
        expect(await resolveTargetLocales({ mode: "none" }, "store", failIfCalled)).toEqual([]);
    });

    test("list returns the given non-English locales without reading Shopware", async () => {
        const locales = await resolveTargetLocales(
            { mode: "list", locales: ["nl-NL", "en-GB", "nl-NL"] },
            "store",
            failIfCalled
        );
        expect(locales).toEqual(["nl-NL"]);
    });

    test("all uses the existing SalesChannel languages", async () => {
        const locales = await resolveTargetLocales({ mode: "all" }, "store", async (name) =>
            name === "store" ? ["de-DE", "fr-FR"] : null
        );
        expect(locales).toEqual(["de-DE", "fr-FR"]);
    });

    test("all falls back to the default domain locales for a new SalesChannel", async () => {
        const locales = await resolveTargetLocales({ mode: "all" }, "store", async () => null);
        expect(locales).toEqual([...DEFAULT_DOMAIN_LOCALES]);
    });

    test("all with an existing English-only SalesChannel translates nothing", async () => {
        const locales = await resolveTargetLocales({ mode: "all" }, "store", async () => []);
        expect(locales).toEqual([]);
    });
});
