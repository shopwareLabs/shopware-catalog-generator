import { describe, expect, test } from "bun:test";

import {
    FOOTER_CATEGORY_NAMES,
    footerTextKey,
    localizedFixtureText,
    PACKAGING_UNITS,
    PROMOTIONS,
    productMediaTexts,
    TRANSLATABLE_FIXTURE_TEXTS,
} from "../../../src/fixtures/index.js";

describe("TRANSLATABLE_FIXTURE_TEXTS", () => {
    test("covers promotions, units, footer categories and product image views", () => {
        for (const promo of PROMOTIONS) {
            expect(TRANSLATABLE_FIXTURE_TEXTS[`promotion.${promo.code}.name`]).toBe(promo.name);
        }
        for (const unit of PACKAGING_UNITS) {
            expect(TRANSLATABLE_FIXTURE_TEXTS[`unit.${unit.shortCode}.name`]).toBe(unit.name);
        }
        for (const name of FOOTER_CATEGORY_NAMES) {
            expect(TRANSLATABLE_FIXTURE_TEXTS[footerTextKey(name)]).toBe(name);
        }
        expect(TRANSLATABLE_FIXTURE_TEXTS["media.productImage.front"]).toBe("{name} (front view)");
    });
});

describe("localizedFixtureText", () => {
    test("uses the translated text and fills placeholders", () => {
        const texts = { "manufacturer.description": "{name} ist ein Hersteller." };
        expect(localizedFixtureText("manufacturer.description", texts, { name: "Acme" })).toBe(
            "Acme ist ein Hersteller."
        );
    });

    test("falls back to English, then to the key", () => {
        expect(localizedFixtureText("home.column.code", {})).toBe("Code");
        expect(localizedFixtureText("unknown.key", null)).toBe("unknown.key");
    });
});

describe("productMediaTexts", () => {
    test("builds alt and title from the view template", () => {
        expect(productMediaTexts("Chair", "side")).toEqual({
            alt: "Chair (side view)",
            title: "Chair (side view)",
        });
        expect(
            productMediaTexts("Stuhl", "side", {
                "media.productImage.side": "{name} (Seitenansicht)",
            })
        ).toEqual({ alt: "Stuhl (Seitenansicht)", title: "Stuhl (Seitenansicht)" });
    });

    test("uses the English pattern for views without a template", () => {
        expect(productMediaTexts("Chair", "top").alt).toBe("Chair (top view)");
    });
});
