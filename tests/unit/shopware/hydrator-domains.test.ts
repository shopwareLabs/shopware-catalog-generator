import { describe, expect, test } from "bun:test";

import { domainLocales, domainUrlSuffix } from "../../../src/shopware/hydrator.js";

describe("domainLocales", () => {
    test("defaults to German", () => {
        expect(domainLocales()).toEqual(["de-DE"]);
    });

    test("adds requested locales without duplicates and drops English", () => {
        expect(domainLocales(["fr-FR", "de-DE", "en-US"])).toEqual(["de-DE", "fr-FR"]);
    });
});

describe("domainUrlSuffix", () => {
    test("uses the language when it is unique", () => {
        expect(domainUrlSuffix("de-DE", ["de-DE", "fr-FR"])).toBe("de");
        expect(domainUrlSuffix("fr-FR", ["de-DE", "fr-FR"])).toBe("fr");
    });

    test("first locale of a language keeps the short suffix, later ones get the full locale", () => {
        expect(domainUrlSuffix("de-DE", ["de-DE", "de-CH"])).toBe("de");
        expect(domainUrlSuffix("de-CH", ["de-DE", "de-CH"])).toBe("de-ch");
    });
});
