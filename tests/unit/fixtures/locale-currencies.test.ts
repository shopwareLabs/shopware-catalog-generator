import { describe, expect, test } from "bun:test";

import { currencyForLocale } from "../../../src/fixtures/locale-currencies.js";

describe("currencyForLocale", () => {
    test("exact locale wins over the language", () => {
        expect(currencyForLocale("de-CH")).toBe("CHF");
        expect(currencyForLocale("en-GB")).toBe("GBP");
    });

    test("falls back to the language", () => {
        expect(currencyForLocale("de-DE")).toBe("EUR");
        expect(currencyForLocale("de-AT")).toBe("EUR");
        expect(currencyForLocale("pl-PL")).toBe("PLN");
    });

    test("returns null for unknown locales", () => {
        expect(currencyForLocale("xx-YY")).toBeNull();
    });
});
