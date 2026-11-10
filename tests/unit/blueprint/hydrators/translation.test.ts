import { describe, expect, test } from "bun:test";

import type { ChatMessage, TranslationSource } from "../../../../src/types/index.js";

import {
    buildTranslationSource,
    buildTranslationSystemPrompt,
    cmsSlotKey,
    collectTerms,
    isStaleFixture,
    sourceHashOf,
    translateCatalog,
    validateTranslatedItem,
} from "../../../../src/blueprint/hydrators/translation.js";
import {
    createTestBlueprint,
    createTestCategory,
    createTestProduct,
} from "../../../helpers/blueprint-factory.js";
import { MockTextProvider } from "../../../mocks/text-provider.mock.js";

const LONG_DESCRIPTION = "A comfortable sofa made from soft linen, built to last for many years.";

const SOURCE: TranslationSource = {
    categories: {
        Living: { name: "Living", description: "Everything for the living room" },
        "Living > Sofas": { name: "Sofas", description: "Comfortable sofas" },
    },
    products: {
        p1: { name: "Linen Sofa", description: `<p>${LONG_DESCRIPTION}</p>` },
        p2: { name: "Oak Table", description: "A sturdy table" },
    },
    propertyGroups: { Color: { name: "Color", options: ["Red", "Blue"] } },
    reviews: { p1: [{ title: "Great", content: "Love this sofa" }] },
    cms: { "Text Elements": { "0.0.content": "<h2>Welcome</h2><p>Hello</p>" } },
    fixtures: { "manufacturer.description": "{name} makes products." },
};

/** Items JSON sent in the user prompt (last line) */
function requestedItems(
    messages: ChatMessage[]
): Array<{ key: string; fields: Record<string, string> }> {
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    return JSON.parse(user.split("\n").at(-1) ?? "[]");
}

/** Provider that "translates" by prefixing every field with "DE " */
function createTranslatingProvider(skipKeys: string[] = []): MockTextProvider {
    const provider = new MockTextProvider();
    provider.setResponse("FormalityDecision", { formality: "informal", reason: "casual brand" });
    provider.setDynamicResponse("TranslatedItems", (messages) => ({
        items: requestedItems(messages)
            .filter((item) => !skipKeys.includes(item.key))
            .map((item) => ({
                key: item.key,
                fields: Object.entries(item.fields).map(([name, value]) => ({
                    name,
                    value: value.startsWith("<")
                        ? value.replace(/>([^<])/g, ">DE $1")
                        : `DE ${value}`,
                })),
            })),
    }));
    return provider;
}

function translate(
    provider: MockTextProvider,
    extra: Partial<Parameters<typeof translateCatalog>[0]> = {}
) {
    return translateCatalog({
        textProvider: provider,
        locale: "de-DE",
        storeName: "test-store",
        storeDescription: "A test store",
        source: SOURCE,
        ...extra,
    });
}

describe("buildTranslationSource", () => {
    test("keys categories by path, products by ID, reviews only for products with reviews", () => {
        const blueprint = createTestBlueprint({
            categories: [
                createTestCategory({
                    name: "Living",
                    children: [createTestCategory({ id: "cat-2", name: "Sofas", level: 2 })],
                }),
            ],
            products: [
                createTestProduct({ id: "p1", metadata: { reviewCount: 2 } }),
                createTestProduct({ id: "p2", metadata: { reviewCount: 0 } }),
            ],
        });
        const source = buildTranslationSource(blueprint, null);

        expect(Object.keys(source.categories)).toEqual(["Living", "Living > Sofas"]);
        expect(Object.keys(source.products)).toEqual(["p1", "p2"]);
        expect(Object.keys(source.reviews)).toEqual(["p1"]);
        expect(source.reviews.p1).toHaveLength(2);
        expect(source.cms).toEqual({});
        expect(source.fixtures["manufacturer.description"]).toBeDefined();
    });
});

describe("helpers", () => {
    test("cmsSlotKey", () => {
        expect(cmsSlotKey(1, 2, "content")).toBe("1.2.content");
    });

    test("collectTerms de-duplicates category, group and option names", () => {
        expect(collectTerms(SOURCE)).toEqual(["Living", "Sofas", "Color", "Red", "Blue"]);
    });

    test("sourceHashOf is stable and changes with the content", () => {
        expect(sourceHashOf({ a: 1 })).toBe(sourceHashOf({ a: 1 }));
        expect(sourceHashOf({ a: 1 })).not.toBe(sourceHashOf({ a: 2 }));
    });

    test("system prompt asks for native copy and the chosen formality, without store types", () => {
        const prompt = buildTranslationSystemPrompt("de-DE", "informal", "copy");
        expect(prompt).toContain("native German");
        expect(prompt).toContain("informally");
        expect(prompt).toContain("Do not translate word for word");
    });
});

describe("validateTranslatedItem", () => {
    const item = { key: "p1", fields: { description: `<p>${LONG_DESCRIPTION}</p>`, name: "Sofa" } };

    test("accepts a proper translation", () => {
        expect(
            validateTranslatedItem(item, {
                description: "<p>Ein bequemes Sofa aus weichem Leinen, gebaut für viele Jahre.</p>",
                name: "Sofa",
            })
        ).toEqual([]);
    });

    test("rejects missing items, empty fields and changed HTML", () => {
        expect(validateTranslatedItem(item, undefined)).toEqual(["missing"]);
        expect(validateTranslatedItem(item, { description: " ", name: "Sofa" })).toEqual([
            "description: empty",
        ]);
        expect(
            validateTranslatedItem(item, {
                description: "Ein bequemes Sofa aus Leinen ohne Tags hier.",
                name: "Sofa",
            })
        ).toEqual(["description: HTML tags differ"]);
    });

    test("rejects long texts left in English and suspicious lengths", () => {
        expect(
            validateTranslatedItem(item, {
                description: `<p>${LONG_DESCRIPTION}</p>`,
                name: "Sofa",
            })
        ).toEqual(["description: identical to English"]);
        expect(
            validateTranslatedItem(item, { description: "<p>Sofa</p>", name: "Sofa" })[0]
        ).toContain("length ratio");
    });

    test("rejects lost placeholders", () => {
        const fixture = { key: "f", fields: { text: "{name} makes products." } };
        expect(validateTranslatedItem(fixture, { text: "Stellt Produkte her." })).toEqual([
            "text: placeholders differ",
        ]);
    });
});

describe("translateCatalog", () => {
    test("translates every section and builds the property groups from the glossary", async () => {
        const result = await translate(createTranslatingProvider());
        const { file } = result;

        expect(result.failed).toEqual([]);
        expect(file.locale).toBe("de-DE");
        expect(file.style.formality).toBe("informal");
        expect(file.glossary).toEqual({
            Living: "DE Living",
            Sofas: "DE Sofas",
            Color: "DE Color",
            Red: "DE Red",
            Blue: "DE Blue",
        });
        expect(file.categories["Living > Sofas"]).toMatchObject({
            name: "DE Sofas",
            description: "DE Comfortable sofas",
        });
        expect(file.products.p1?.name).toBe("DE Linen Sofa");
        expect(file.propertyGroups.Color).toEqual({
            name: "DE Color",
            options: { Red: "DE Red", Blue: "DE Blue" },
        });
        expect(file.reviews.p1?.reviews).toEqual([
            { title: "DE Great", content: "DE Love this sofa" },
        ]);
        expect(file.cms["Text Elements"]?.slots["0.0.content"]).toBe(
            "<h2>DE Welcome</h2><p>DE Hello</p>"
        );
        expect(file.fixtures["manufacturer.description"]).toBe("DE {name} makes products.");
    });

    test("does not send product meta texts to the AI (upload derives them)", async () => {
        const provider = createTranslatingProvider();
        const p1 = { name: "Linen Sofa", description: "A sofa", metaDescription: "Cut off..." };
        const { file } = await translate(provider, {
            source: { ...SOURCE, products: { ...SOURCE.products, p1 } },
        });

        const productItem = provider
            .getCalls()
            .filter((call) => call.schemaName === "TranslatedItems")
            .flatMap((call) => requestedItems(call.messages))
            .find((item) => item.key === "p1");
        expect(Object.keys(productItem?.fields ?? {})).toEqual(["name", "description"]);
        expect(file.products.p1).not.toHaveProperty("metaDescription");
    });

    test("reuses unchanged entries from the previous file without AI calls", async () => {
        const first = await translate(createTranslatingProvider());
        const provider = createTranslatingProvider();

        const second = await translate(provider, { previous: first.file });

        expect(second.translated).toBe(0);
        expect(provider.callCount).toBe(0);
        expect(second.file.products).toEqual(first.file.products);
    });

    test("counts reused entries in the same units as translated ones", async () => {
        const first = await translate(createTranslatingProvider());

        const second = await translate(createTranslatingProvider(), { previous: first.file });

        expect(first.translated).toBeGreaterThan(0);
        expect(second.reused).toBe(first.translated);
    });

    test("re-translates entries whose English source changed", async () => {
        const first = await translate(createTranslatingProvider());
        const changed: TranslationSource = {
            ...SOURCE,
            products: {
                ...SOURCE.products,
                p2: { name: "Walnut Table", description: "A sturdy table" },
            },
        };
        const provider = createTranslatingProvider();

        const second = await translate(provider, { source: changed, previous: first.file });

        expect(second.translated).toBe(1);
        expect(second.file.products.p2?.name).toBe("DE Walnut Table");
    });

    test("force translates everything again", async () => {
        const first = await translate(createTranslatingProvider());
        const provider = createTranslatingProvider();

        await translate(provider, { previous: first.file, force: true });

        expect(provider.getCalls().some((c) => c.schemaName === "FormalityDecision")).toBe(true);
        expect(
            provider.getCalls().filter((c) => c.schemaName === "TranslatedItems").length
        ).toBeGreaterThan(0);
    });

    test("formality override skips the formality call", async () => {
        const provider = createTranslatingProvider();
        const { file } = await translate(provider, { formality: "formal" });

        expect(file.style.formality).toBe("formal");
        expect(provider.getCalls().some((c) => c.schemaName === "FormalityDecision")).toBe(false);
    });

    test("items missing twice are reported and left out", async () => {
        const result = await translate(createTranslatingProvider(["p2"]));

        expect(result.failed).toEqual(["products:p2"]);
        expect(result.file.products.p2).toBeUndefined();
        expect(result.file.products.p1).toBeDefined();
    });
});

describe("fixture texts", () => {
    const changedFixture = (text: string): TranslationSource => ({
        ...SOURCE,
        fixtures: { "manufacturer.description": text },
    });

    test("isStaleFixture decides by hash, missing text and force", () => {
        const previous = {
            fixtures: { a: "DE a" },
            fixtureHashes: { a: "hash-a" },
        };
        expect(isStaleFixture("a", "hash-a", previous, false)).toBe(false);
        expect(isStaleFixture("a", "hash-b", previous, false)).toBe(true);
        expect(isStaleFixture("b", "hash-b", previous, false)).toBe(true);
        expect(isStaleFixture("a", "hash-a", previous, true)).toBe(true);
        expect(isStaleFixture("a", "hash-a", null, false)).toBe(true);
        // Files from before fixture hashes existed keep their texts
        expect(isStaleFixture("a", "other", { fixtures: { a: "DE a" } }, false)).toBe(false);
    });

    test("stores a source hash for every translated fixture text", async () => {
        const { file } = await translate(createTranslatingProvider());
        expect(file.fixtureHashes?.["manufacturer.description"]).toBe(
            sourceHashOf("{name} makes products.")
        );
    });

    test("re-translates a fixture text whose English source changed", async () => {
        const first = await translate(createTranslatingProvider());

        const second = await translate(createTranslatingProvider(), {
            source: changedFixture("{name} builds things."),
            previous: first.file,
        });

        expect(second.translated).toBe(1);
        expect(second.file.fixtures["manufacturer.description"]).toBe("DE {name} builds things.");
    });

    test("a failed fixture keeps its old text without a hash, so the next run retries", async () => {
        const first = await translate(createTranslatingProvider());

        const second = await translate(createTranslatingProvider(["manufacturer.description"]), {
            source: changedFixture("{name} builds things."),
            previous: first.file,
        });

        expect(second.failed).toEqual(["fixtures:manufacturer.description"]);
        expect(second.file.fixtures["manufacturer.description"]).toBe("DE {name} makes products.");
        expect(second.file.fixtureHashes?.["manufacturer.description"]).toBeUndefined();
    });
});
