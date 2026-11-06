import { describe, expect, test } from "bun:test";

import type { CmsPageStructure, TranslationPayloadInput } from "../../../src/shopware/index.js";

import { buildTranslationSource } from "../../../src/blueprint/hydrators/translation.js";
import {
    buildCategoryTranslations,
    buildCmsSlotTranslations,
    buildManufacturerTranslations,
    buildProductTranslations,
    buildPropertyGroupTranslations,
    buildTranslationOperations,
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
                        metaTitle: "Leinensofa | Store",
                        metaDescription: "Kauf das Leinensofa",
                    },
                },
            },
        ]);
    });

    test("adds Open Graph fields when supported", () => {
        const [p1] = buildProductTranslations(createInput({ openGraph: true }));
        expect(p1?.translations).toMatchObject({
            "lang-de": { ogTitle: "Leinensofa | Store", ogDescription: "Kauf das Leinensofa" },
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
