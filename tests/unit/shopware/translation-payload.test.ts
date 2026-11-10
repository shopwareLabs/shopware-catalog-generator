import { describe, expect, test } from "bun:test";

import type { CmsPageStructure, TranslationPayloadInput } from "../../../src/shopware/index.js";
import type { BlueprintPropertyGroup } from "../../../src/types/index.js";

import { buildTranslationSource } from "../../../src/blueprint/hydrators/translation.js";
import { COLOR_FAMILY_GROUP_ID, COLOR_FAMILY_GROUP_NAME } from "../../../src/fixtures/index.js";
import {
    buildCategoryTranslations,
    buildCmsSlotTranslations,
    buildFooterCategoryTranslations,
    buildManufacturerTranslations,
    buildMediaTranslations,
    buildProductTranslations,
    buildPromotionTranslations,
    buildPropertyGroupTranslations,
    buildTranslationOperations,
    buildUnitTranslations,
} from "../../../src/shopware/translation-payload.js";
import {
    createTestBlueprint,
    createTestCategory,
    createTestProduct,
} from "../../helpers/blueprint-factory.js";
import {
    createTranslationFile,
    DE,
    DE_SYSTEM,
    EN,
    EN_EXTRA,
    source,
    translation,
} from "../../helpers/translation-factory.js";

const BLUEPRINT = createTestBlueprint({
    categories: [
        createTestCategory({
            id: "cat-living",
            name: "Living",
            description: "Living rooms",
            children: [
                createTestCategory({
                    id: "cat-sofas",
                    name: "Sofas",
                    description: "Comfy sofas",
                    level: 2,
                }),
            ],
        }),
    ],
    products: [
        createTestProduct({
            id: "p1",
            name: "Linen Sofa",
            description: "A sofa",
            metaTitle: "Linen Sofa | Store",
            metaDescription: "Buy the linen sofa",
        }),
        createTestProduct({ id: "p2", name: "Oak Table", description: "A table" }),
    ],
    propertyGroups: [
        {
            id: "grp-color",
            name: "Color",
            displayType: "color",
            options: [
                { id: "opt-red", name: "Red" },
                { id: "opt-blue", name: "Blue" },
            ],
        },
    ],
});

const DE_FILE = createTranslationFile({
    categories: {
        Living: { name: "Wohnen", description: "Wohnzimmer", sourceHash: "h" },
        "Living > Sofas": { name: "Sofas", description: "Bequeme Sofas", sourceHash: "h" },
    },
    products: {
        p1: {
            name: "Leinensofa",
            description: "Ein Sofa",
            metaTitle: "Leinensofa | Store",
            metaDescription: "Kauf das Leinensofa",
            sourceHash: "h",
        },
    },
    propertyGroups: { Color: { name: "Farbe", options: { Red: "Rot" } } },
    cms: { "Text Elements": { slots: { "0.0.content": "<p>Hallo</p>" }, sourceHash: "h" } },
    fixtures: { "manufacturer.description": "{name} ist ein Hersteller." },
});

function createInput(overrides: Partial<TranslationPayloadInput> = {}): TranslationPayloadInput {
    const base = buildTranslationSource(BLUEPRINT, null);
    return {
        blueprint: BLUEPRINT,
        source: {
            ...base,
            cms: { "Text Elements": { "0.0.content": "<p>Hello</p>" } },
            fixtures: { "manufacturer.description": "{name} is a manufacturer." },
        },
        languages: [translation(DE, DE_FILE)],
        manufacturers: [{ id: "man-1", name: "Acme" }],
        cmsPages: [],
        openGraph: false,
        ...overrides,
    };
}

describe("buildProductTranslations", () => {
    test("writes translated texts per language ID, skips products without translation", () => {
        expect(buildProductTranslations(createInput())).toEqual([
            {
                id: "p1",
                translations: {
                    "lang-de": {
                        name: "Leinensofa",
                        description: "Ein Sofa",
                        metaTitle: "Leinensofa",
                        metaDescription: "Ein Sofa",
                    },
                },
            },
        ]);
    });

    test("adds Open Graph fields when supported", () => {
        const [p1] = buildProductTranslations(createInput({ openGraph: true }));
        expect(p1?.translations).toMatchObject({
            "lang-de": { ogTitle: "Leinensofa", ogDescription: "Ein Sofa" },
        });
    });

    test("derives meta texts from the translation, ignores stored meta texts of older files", () => {
        const longDescription = `<p>${"Ein sehr langer Satz über das Sofa. ".repeat(20)}</p>`;
        const file = createTranslationFile({
            products: {
                p1: {
                    name: "Leinensofa",
                    description: longDescription,
                    metaDescription: "x".repeat(463),
                    sourceHash: "h",
                },
            },
        });
        const [p1] = buildProductTranslations(
            createInput({ languages: [translation(DE, file)], openGraph: true })
        );
        const metaDescription = `${"Ein sehr langer Satz über das Sofa. ".repeat(5).slice(0, 157)}...`;

        expect(metaDescription).toHaveLength(160);
        expect(p1?.translations).toMatchObject({
            "lang-de": { metaDescription, ogDescription: metaDescription },
        });
    });

    test("keeps the English meta texts of the source language", () => {
        const [p1] = buildProductTranslations(createInput({ languages: [source(EN)] }));
        expect(p1?.translations).toMatchObject({
            [EN.id]: {
                metaTitle: "Linen Sofa | Store",
                metaDescription: "Buy the linen sofa",
            },
        });
    });

    test("German system language gets German, an extra English language gets English", () => {
        const payload = buildProductTranslations(
            createInput({ languages: [translation(DE_SYSTEM, DE_FILE), source(EN_EXTRA)] })
        );
        expect(payload[0]?.translations).toMatchObject({
            [DE_SYSTEM.id]: { name: "Leinensofa" },
            "lang-en": { name: "Linen Sofa" },
        });
        // p2 has no German translation but still gets English for the extra English language
        expect(payload[1]).toEqual({
            id: "p2",
            translations: { "lang-en": { name: "Oak Table", description: "A table" } },
        });
    });
});

describe("buildCategoryTranslations", () => {
    test("matches categories by path", () => {
        expect(buildCategoryTranslations(createInput())).toEqual([
            {
                id: "cat-living",
                translations: { "lang-de": { name: "Wohnen", description: "Wohnzimmer" } },
            },
            {
                id: "cat-sofas",
                translations: { "lang-de": { name: "Sofas", description: "Bequeme Sofas" } },
            },
        ]);
    });
});

describe("buildPropertyGroupTranslations", () => {
    test("translates the group and known options, keeps unknown options English", () => {
        const { groups, options } = buildPropertyGroupTranslations(createInput());
        expect(groups).toEqual([
            { id: "grp-color", translations: { "lang-de": { name: "Farbe" } } },
        ]);
        expect(options).toEqual([
            { id: "opt-red", translations: { "lang-de": { name: "Rot" } } },
            { id: "opt-blue", translations: { "lang-de": { name: "Blue" } } },
        ]);
    });

    test("uses fixed translations for the colour family group, AI text for other languages", () => {
        const familyGroup: BlueprintPropertyGroup = {
            id: COLOR_FAMILY_GROUP_ID,
            name: COLOR_FAMILY_GROUP_NAME,
            displayType: "color",
            filterable: true,
            options: [
                { id: "fam-white", name: "White", family: "white" },
                { id: "fam-red", name: "Red", family: "red" },
            ],
        };
        const blueprint = createTestBlueprint({ propertyGroups: [familyGroup] });
        const japanese = { id: "lang-ja", locale: "ja-JP", isSystem: false };
        const aiFile = createTranslationFile({
            locale: "ja-JP",
            propertyGroups: {
                [COLOR_FAMILY_GROUP_NAME]: { name: "カラー系統", options: { White: "白" } },
            },
        });

        const { groups, options } = buildPropertyGroupTranslations(
            createInput({
                blueprint,
                languages: [
                    translation(DE, createTranslationFile()),
                    translation(japanese, aiFile),
                ],
            })
        );

        expect(groups).toEqual([
            {
                id: COLOR_FAMILY_GROUP_ID,
                translations: {
                    "lang-de": { name: "Farbfamilie" },
                    "lang-ja": { name: "カラー系統" },
                },
            },
        ]);
        expect(options).toEqual([
            {
                id: "fam-white",
                translations: { "lang-de": { name: "Weiß" }, "lang-ja": { name: "白" } },
            },
            {
                id: "fam-red",
                translations: { "lang-de": { name: "Rot" }, "lang-ja": { name: "Red" } },
            },
        ]);
    });
});

describe("buildManufacturerTranslations", () => {
    test("fills the translated fixture template with the manufacturer name", () => {
        expect(buildManufacturerTranslations(createInput())).toEqual([
            {
                id: "man-1",
                translations: { "lang-de": { description: "Acme ist ein Hersteller." } },
            },
        ]);
    });

    test("empty without an English template", () => {
        const input = createInput();
        expect(
            buildManufacturerTranslations({ ...input, source: { ...input.source, fixtures: {} } })
        ).toEqual([]);
    });
});

describe("buildCmsSlotTranslations", () => {
    const page: CmsPageStructure = {
        pageName: "Text Elements",
        sections: [
            {
                position: 0,
                blocks: [
                    {
                        position: 0,
                        slots: [
                            {
                                id: "slot-1",
                                slot: "content",
                                config: { verticalAlign: { source: "static", value: null } },
                            },
                            { id: "slot-2", slot: "image" },
                        ],
                    },
                ],
            },
        ],
    };

    test("writes the translated HTML into the slot config, keeping other config keys", () => {
        expect(buildCmsSlotTranslations(createInput({ cmsPages: [page] }))).toEqual([
            {
                id: "slot-1",
                translations: {
                    "lang-de": {
                        config: {
                            verticalAlign: { source: "static", value: null },
                            content: { source: "static", value: "<p>Hallo</p>" },
                        },
                    },
                },
            },
        ]);
    });
});

describe("buildTranslationOperations", () => {
    test("no operations without languages", () => {
        expect(buildTranslationOperations(createInput({ languages: [] }))).toEqual({});
    });

    test("one upsert per entity type, chunked", () => {
        const operations = buildTranslationOperations(createInput());
        expect(Object.keys(operations).sort()).toEqual([
            "translate-category-0",
            "translate-manufacturer-0",
            "translate-product-0",
            "translate-property-group-0",
            "translate-property-option-0",
        ]);
        expect(operations["translate-product-0"]).toMatchObject({
            entity: "product",
            action: "upsert",
        });
        expect(operations["translate-property-option-0"]?.entity).toBe("property_group_option");
    });
});

describe("packaging labels", () => {
    const packed = createTestBlueprint({
        products: [
            createTestProduct({
                id: "p1",
                name: "Linen Sofa",
                metadata: {
                    packaging: {
                        unitShortCode: "pc",
                        unitName: "Piece",
                        purchaseUnit: 2,
                        referenceUnit: 1,
                        packUnit: "Pair",
                        packUnitPlural: "Pairs",
                    },
                },
            }),
        ],
    });
    const file = createTranslationFile({
        products: { p1: { name: "Leinensofa", description: "Ein Sofa", sourceHash: "h" } },
        fixtures: { "packaging.Pair": "Paar", "packaging.Pairs": "Paare" },
    });

    test("writes translated packUnit and packUnitPlural", () => {
        const [product] = buildProductTranslations(
            createInput({
                blueprint: packed,
                source: buildTranslationSource(packed, null),
                languages: [translation(DE, file)],
            })
        );
        expect(product?.translations).toMatchObject({
            "lang-de": { packUnit: "Paar", packUnitPlural: "Paare" },
        });
    });

    test("falls back to English labels without a translation", () => {
        const [product] = buildProductTranslations(
            createInput({
                blueprint: packed,
                source: buildTranslationSource(packed, null),
                languages: [translation(DE, { ...file, fixtures: {} })],
            })
        );
        expect(product?.translations).toMatchObject({
            "lang-de": { packUnit: "Pair", packUnitPlural: "Pairs" },
        });
    });
});

describe("buildUnitTranslations", () => {
    const fixtures = { "unit.pc.name": "Stück", "unit.pc.shortCode": "Stk." };

    test("translates name and short code for non-system languages", () => {
        const input = createInput({
            units: [{ id: "unit-pc", shortCode: "pc" }],
            languages: [translation(DE, createTranslationFile({ fixtures }))],
        });
        expect(buildUnitTranslations(input)).toEqual([
            { id: "unit-pc", translations: { "lang-de": { name: "Stück", shortCode: "Stk." } } },
        ]);
    });

    test("never writes the system language, units are found by short code", () => {
        const input = createInput({
            units: [{ id: "unit-pc", shortCode: "pc" }],
            languages: [translation(DE_SYSTEM, createTranslationFile({ fixtures }))],
        });
        expect(buildUnitTranslations(input)).toEqual([]);
    });
});

describe("buildPromotionTranslations", () => {
    test("translates promotion names, also in the system language", () => {
        const input = createInput({
            promotions: [{ id: "promo-1", code: "WELCOME10" }],
            languages: [
                translation(
                    DE_SYSTEM,
                    createTranslationFile({
                        fixtures: { "promotion.WELCOME10.name": "Willkommensrabatt" },
                    })
                ),
            ],
        });
        expect(buildPromotionTranslations(input)).toEqual([
            {
                id: "promo-1",
                translations: { [DE_SYSTEM.id]: { name: "Willkommensrabatt" } },
            },
        ]);
    });
});

describe("buildMediaTranslations", () => {
    test("product image alt text uses the translated name and view template", () => {
        const file = createTranslationFile({
            ...DE_FILE,
            fixtures: { "media.productImage.front": "{name} (Vorderansicht)" },
        });
        const input = createInput({
            productMedia: [{ mediaId: "media-1", productId: "p1", view: "front" }],
            languages: [translation(DE, file), source(EN_EXTRA)],
        });
        expect(buildMediaTranslations(input)).toEqual([
            {
                id: "media-1",
                translations: {
                    "lang-de": {
                        alt: "Leinensofa (Vorderansicht)",
                        title: "Leinensofa (Vorderansicht)",
                    },
                    "lang-en": { alt: "Linen Sofa (front view)", title: "Linen Sofa (front view)" },
                },
            },
        ]);
    });

    test("category banner alt text is the translated category name", () => {
        const input = createInput({
            categoryMedia: [
                { mediaId: "media-cat", categoryId: "cat-sofas" },
                { mediaId: "media-unknown", categoryId: "cat-missing" },
            ],
        });
        expect(buildMediaTranslations(input)).toEqual([
            {
                id: "media-cat",
                translations: { "lang-de": { alt: "Sofas", title: "Sofas" } },
            },
        ]);
    });
});

describe("buildFooterCategoryTranslations", () => {
    const fixtures = { "footer.category.Imprint": "Impressum" };

    test("translates footer category names for non-system languages", () => {
        const input = createInput({
            footerCategories: [{ id: "cat-imprint", name: "Imprint" }],
            languages: [
                translation(DE, createTranslationFile({ fixtures })),
                translation(DE_SYSTEM, createTranslationFile({ fixtures })),
            ],
        });
        expect(buildFooterCategoryTranslations(input)).toEqual([
            { id: "cat-imprint", translations: { "lang-de": { name: "Impressum" } } },
        ]);
    });
});

describe("homepage slots", () => {
    const home: CmsPageStructure = {
        pageName: "Home Listing",
        sections: [
            {
                position: 0,
                blocks: [{ position: 0, slots: [{ id: "slot-hero", slot: "right" }] }],
            },
        ],
    };

    test("rebuilds the slot HTML from the fixture texts of each language", () => {
        const input = createInput({
            home: {
                page: home,
                slotTexts: (texts) => ({
                    "0.0.right": `<p>${texts?.["home.welcome"] ?? "EN"}</p>`,
                }),
            },
            languages: [
                translation(DE, createTranslationFile({ fixtures: { "home.welcome": "Hallo" } })),
                source(EN_EXTRA),
            ],
        });
        expect(buildCmsSlotTranslations(input)).toEqual([
            {
                id: "slot-hero",
                translations: {
                    "lang-de": { config: { content: { source: "static", value: "<p>Hallo</p>" } } },
                    "lang-en": { config: { content: { source: "static", value: "<p>EN</p>" } } },
                },
            },
        ]);
    });
});

describe("buildTranslationOperations with fixture entities", () => {
    test("adds unit, promotion, media and footer category operations", () => {
        const operations = buildTranslationOperations(
            createInput({
                units: [{ id: "unit-pc", shortCode: "pc" }],
                promotions: [{ id: "promo-1", code: "WELCOME10" }],
                productMedia: [{ mediaId: "media-1", productId: "p1", view: "side" }],
                footerCategories: [{ id: "cat-imprint", name: "Imprint" }],
            })
        );
        expect(operations["translate-unit-0"]?.entity).toBe("unit");
        expect(operations["translate-promotion-0"]?.entity).toBe("promotion");
        expect(operations["translate-media-0"]?.entity).toBe("media");
        expect(operations["translate-footer-category-0"]?.entity).toBe("category");
    });

    test("an English system language alone writes nothing", () => {
        expect(buildTranslationOperations(createInput({ languages: [] }))).toEqual({});
        expect(EN.isSystem).toBe(true);
    });
});
