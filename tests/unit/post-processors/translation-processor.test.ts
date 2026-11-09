import { describe, expect, test } from "bun:test";

import {
    TranslationProcessor,
    viewFromFileName,
} from "../../../src/post-processors/translation-processor.js";
import { SYSTEM_LANGUAGE_ID } from "../../../src/shopware/languages.js";
import { createTestBlueprint, createTestProduct } from "../../helpers/blueprint-factory.js";
import { createTestContext } from "../../helpers/post-processor-context.js";
import { createTranslationFile } from "../../helpers/translation-factory.js";

const blueprint = createTestBlueprint({
    products: [createTestProduct({ id: "p1", name: "Linen Sofa", description: "A sofa" })],
});

const germanFile = createTranslationFile({
    products: { p1: { name: "Leinensofa", description: "Ein Sofa", sourceHash: "h" } },
});

const SALES_CHANNEL_LANGUAGES = [
    {
        languages: [
            { id: SYSTEM_LANGUAGE_ID, locale: { code: "en-GB" } },
            { id: "lang-de", locale: { code: "de-DE" } },
        ],
    },
];

function createContext(dryRun = false) {
    const result = createTestContext({ blueprint, dryRun });
    result.mockApi.mockSearchResponse("sales-channel", SALES_CHANNEL_LANGUAGES);
    result.mockApi.mockSearchResponse("language", [
        { id: SYSTEM_LANGUAGE_ID, locale: { code: "en-GB" } },
    ]);
    return result;
}

describe("TranslationProcessor", () => {
    test("runs after the processors that create translated entities", () => {
        expect(TranslationProcessor.dependsOn).toEqual([
            "manufacturers",
            "variants",
            "cms-testing",
            "cms-home",
            "cms-footer-pages",
            "images",
            "promotions",
        ]);
    });

    test("skips without cached translations", async () => {
        const { context, mockApi } = createContext();
        const result = await TranslationProcessor.process(context);
        expect(result).toMatchObject({ processed: 0, skipped: 1, errors: [] });
        expect(mockApi.syncEntitiesMock).not.toHaveBeenCalled();
    });

    test("writes product translations for the German language", async () => {
        const { context, mockApi, mockCache } = createContext();
        mockCache.translations.set("de-DE", germanFile);

        const result = await TranslationProcessor.process(context);

        expect(result.errors).toEqual([]);
        expect(result.processed).toBe(1);
        const [sync] = mockApi.getCallsByEndpoint("_action/sync");
        expect(sync?.body).toMatchObject({
            "translate-product-0": {
                entity: "product",
                payload: [{ id: "p1", translations: { "lang-de": { name: "Leinensofa" } } }],
            },
        });
    });

    test("skips when no SalesChannel language matches", async () => {
        const { context, mockApi, mockCache } = createContext();
        mockCache.translations.set("fr-FR", createTranslationFile({ locale: "fr-FR" }));

        const result = await TranslationProcessor.process(context);

        expect(result).toMatchObject({ processed: 0, skipped: 1 });
        expect(mockApi.syncEntitiesMock).not.toHaveBeenCalled();
    });

    test("dry run counts records without writing", async () => {
        const { context, mockApi, mockCache } = createContext(true);
        mockCache.translations.set("de-DE", germanFile);

        const result = await TranslationProcessor.process(context);

        expect(result.processed).toBe(1);
        expect(mockApi.syncEntitiesMock).not.toHaveBeenCalled();
    });

    test("reports a failed sync as an error", async () => {
        const { context, mockApi, mockCache } = createContext();
        mockCache.translations.set("de-DE", germanFile);
        mockApi.mockSyncFailure(new Error("boom"));

        const result = await TranslationProcessor.process(context);

        expect(result.errors).toEqual(["Failed to write translations: boom"]);
    });

    test("translates units, promotions, product images and footer categories", async () => {
        const { context, mockApi, mockCache } = createContext();
        mockCache.translations.set(
            "de-DE",
            createTranslationFile({
                ...germanFile,
                fixtures: {
                    "unit.pc.name": "Stück",
                    "promotion.WELCOME10.name": "Willkommensrabatt",
                    "media.productImage.front": "{name} (Vorderansicht)",
                    "footer.category.Imprint": "Impressum",
                },
            })
        );
        mockApi.mockSearchResponse("sales-channel", [
            { ...SALES_CHANNEL_LANGUAGES[0], footerCategoryId: "footer-root" },
        ]);
        mockApi.mockSearchResponse("unit", [{ id: "unit-pc", shortCode: "pc" }]);
        mockApi.mockSearchResponse("promotion", [{ id: "promo-1", code: "WELCOME10" }]);
        mockApi.mockSearchResponse("product-media", [
            { productId: "p1", mediaId: "media-1", media: { fileName: "linen-sofa-front" } },
            { productId: "p1", mediaId: "media-2", media: { fileName: "unrelated" } },
        ]);
        mockApi.mockSearchResponse("category", [{ id: "cat-imprint", name: "Imprint" }]);

        const result = await TranslationProcessor.process(context);

        expect(result.errors).toEqual([]);
        const [sync] = mockApi.getCallsByEndpoint("_action/sync");
        expect(sync?.body).toMatchObject({
            "translate-unit-0": {
                payload: [{ id: "unit-pc", translations: { "lang-de": { name: "Stück" } } }],
            },
            "translate-promotion-0": {
                payload: [
                    { id: "promo-1", translations: { "lang-de": { name: "Willkommensrabatt" } } },
                ],
            },
            "translate-media-0": {
                payload: [
                    {
                        id: "media-1",
                        translations: { "lang-de": { alt: "Leinensofa (Vorderansicht)" } },
                    },
                ],
            },
            "translate-footer-category-0": {
                payload: [
                    { id: "cat-imprint", translations: { "lang-de": { name: "Impressum" } } },
                ],
            },
        });
    });
});

describe("viewFromFileName", () => {
    test("reads the view from the file name suffix", () => {
        expect(viewFromFileName("oak-desk-front")).toBe("front");
        expect(viewFromFileName("oak-desk-lifestyle")).toBe("lifestyle");
    });

    test("returns null for unknown or missing names", () => {
        expect(viewFromFileName("oak-desk")).toBeNull();
        expect(viewFromFileName(null)).toBeNull();
    });
});
