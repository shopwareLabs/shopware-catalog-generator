/**
 * Unit tests for ProductHydrator.hydrateProducts (branch hydration + applying the AI response)
 */

import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import type { VariantProductContext } from "../../../../src/blueprint/variant-resolver.js";
import type {
    BlueprintCategory,
    BlueprintProduct,
    ChatMessage,
    TextProvider,
    VariantConfig,
} from "../../../../src/types/index.js";

import { ProductHydrator } from "../../../../src/blueprint/hydrators/product.js";
import { VariantResolver } from "../../../../src/blueprint/variant-resolver.js";
import { PropertyCache } from "../../../../src/property-cache.js";
import { createTestCategory, createTestProduct } from "../../../helpers/blueprint-factory.js";

interface AiProduct {
    id: string;
    name: string;
    description: string;
    properties: Array<{ group: string; value: string }>;
    manufacturerName: string;
    imageDescriptions: Array<{ view: "front"; prompt: string }>;
    suggestedVariantGroups: string[] | null;
    variantColors: string[] | null;
    assignedCategories: string[] | null;
}

function aiProduct(id: string, overrides: Partial<AiProduct> = {}): AiProduct {
    return {
        id,
        name: `AI ${id}`,
        description: `<p>Description of ${id}</p>`,
        properties: [{ group: "Color", value: "Navy" }],
        manufacturerName: "Maker",
        imageDescriptions: [{ view: "front", prompt: `Photo of ${id}` }],
        suggestedVariantGroups: null,
        variantColors: null,
        assignedCategories: null,
        ...overrides,
    };
}

/** Answers with the AI products whose IDs appear in the prompt; throws for "Broken" branches */
class BranchTextProvider implements TextProvider {
    readonly name = "mock";
    readonly isSequential = false;
    readonly maxConcurrency = 1;
    readonly tokenLimit = 128000;

    constructor(
        private readonly answers: AiProduct[],
        private readonly failure = "AI is down"
    ) {}

    async generateCompletion(messages: ChatMessage[]): Promise<string> {
        const prompt = messages.find((m) => m.role === "user")?.content ?? "";
        if (prompt.includes("Broken")) throw new Error(this.failure);
        return JSON.stringify({
            products: this.answers.filter((p) => prompt.includes(`"${p.id}"`)),
        });
    }
}

class RecordingVariantResolver extends VariantResolver {
    readonly calls: Array<{ groups: string[] | undefined; context: VariantProductContext }> = [];

    constructor(private readonly configs: VariantConfig[]) {
        super(new BranchTextProvider([]), new PropertyCache(tmpCacheDir()));
    }

    override async resolveVariantConfigs(
        groups: string[] | undefined,
        context: VariantProductContext
    ): Promise<VariantConfig[]> {
        this.calls.push({ groups, context });
        return this.configs;
    }
}

function tmpCacheDir(): string {
    return path.join(os.tmpdir(), "catalog-generator-product-hydrator-test");
}

const SIZE_CONFIG: VariantConfig = {
    group: "Size",
    selectedOptions: ["S", "M"],
    priceModifiers: { S: 1, M: 1 },
};

interface Setup {
    answers: AiProduct[];
    products: BlueprintProduct[];
    tree?: BlueprintCategory[];
    names?: Array<{ id: string; name: string }>;
    configs?: VariantConfig[];
}

const DEFAULT_TREE = [
    createTestCategory({ id: "b1", children: [createTestCategory({ id: "b1-sub" })] }),
    createTestCategory({ id: "b2" }),
];

const DEFAULT_NAMES = [
    { id: "b1", name: "Lamps" },
    { id: "b1-sub", name: "Desk Lamps" },
    { id: "b2", name: "Rugs" },
];

async function run(setup: Setup): Promise<{
    result: BlueprintProduct[];
    resolver: RecordingVariantResolver;
}> {
    const resolver = new RecordingVariantResolver(setup.configs ?? []);
    const hydrator = new ProductHydrator(
        new BranchTextProvider(setup.answers),
        new PropertyCache(tmpCacheDir()),
        resolver,
        (name, properties) => `image of ${name} (${properties.map((p) => p.value).join(", ")})`
    );
    const result = await hydrator.hydrateProducts(
        setup.products,
        setup.names ?? DEFAULT_NAMES,
        setup.tree ?? DEFAULT_TREE,
        [],
        { name: "Test Store", description: "A test store" }
    );
    return { result, resolver };
}

function product(
    id: string,
    branch: string,
    overrides: Parameters<typeof createTestProduct>[0] = {}
): BlueprintProduct {
    return createTestProduct({
        id,
        primaryCategoryId: branch,
        categoryIds: [branch],
        ...overrides,
    });
}

describe("ProductHydrator.hydrateProducts", () => {
    test("applies the AI content of every branch", async () => {
        const { result } = await run({
            answers: [aiProduct("p1"), aiProduct("p2"), aiProduct("p3")],
            products: [product("p1", "b1"), product("p2", "b2"), product("p3", "b1")],
        });

        expect(result.map((p) => p.id)).toEqual(["p1", "p3", "p2"]);
        const p1 = result[0];
        expect(p1?.name).toBe("AI p1");
        expect(p1?.description).toBe("<p>Description of p1</p>");
        expect(p1?.metaTitle).toBe("AI p1");
        expect(p1?.metaDescription).toBe("Description of p1");
        expect(p1?.metadata.manufacturerName).toBe("Maker");
        expect(p1?.metadata.properties).toEqual([{ group: "Color", value: "Navy" }]);
        expect(p1?.metadata.imageDescriptions).toEqual([{ view: "front", prompt: "Photo of p1" }]);
        expect(p1?.metadata.baseImagePrompt).toBe("image of AI p1 (Navy)");
        expect(p1?.metadata.variantConfigs).toBeUndefined();
    });

    test("keeps a product unchanged when the AI left it out", async () => {
        const original = product("p2", "b1", { name: "Placeholder" });
        const { result } = await run({
            answers: [aiProduct("p1")],
            products: [product("p1", "b1"), original],
        });

        expect(result[1]).toEqual(original);
    });

    test("assigns the branch plus the named subcategories, without duplicates", async () => {
        const { result } = await run({
            answers: [
                aiProduct("p1", {
                    assignedCategories: ["desk lamps", "Unknown", "Desk Lamps", "Lamps"],
                }),
            ],
            products: [product("p1", "b1", { categoryIds: ["old"] })],
        });

        expect(result[0]?.categoryIds).toEqual(["b1", "b1-sub"]);
        expect(result[0]?.primaryCategoryId).toBe("b1");
    });

    test("keeps the categories when the AI assigns none", async () => {
        const { result } = await run({
            answers: [aiProduct("p1", { assignedCategories: [] })],
            products: [product("p1", "b1", { categoryIds: ["b1", "x"] })],
        });

        expect(result[0]?.categoryIds).toEqual(["b1", "x"]);
    });

    test("keeps the categories when no assigned name is known and the branch has no name", async () => {
        const { result } = await run({
            answers: [aiProduct("p1", { assignedCategories: ["Nope"] })],
            products: [product("p1", "b3", { categoryIds: ["b3"] })],
            tree: [createTestCategory({ id: "b3" })],
            names: [],
        });

        expect(result[0]?.categoryIds).toEqual(["b3"]);
        expect(result[0]?.primaryCategoryId).toBe("b3");
    });

    test("uses known subcategories even when the branch name is unknown", async () => {
        const { result } = await run({
            answers: [aiProduct("p1", { assignedCategories: ["Desk Lamps"] })],
            products: [product("p1", "b3", { categoryIds: ["b3"] })],
            tree: [createTestCategory({ id: "b3" })],
            names: [{ id: "b1-sub", name: "Desk Lamps" }],
        });

        expect(result[0]?.categoryIds).toEqual(["b1-sub"]);
        expect(result[0]?.primaryCategoryId).toBe("b3");
    });

    test("resolves variant configs for variant products with suggested groups", async () => {
        const { result, resolver } = await run({
            answers: [
                aiProduct("p1", { suggestedVariantGroups: ["Size"], variantColors: ["Teal"] }),
            ],
            products: [product("p1", "b1", { metadata: { isVariant: true } })],
            configs: [SIZE_CONFIG],
        });

        expect(resolver.calls).toEqual([
            {
                groups: ["Size"],
                context: {
                    name: "AI p1",
                    category: "Lamps",
                    productId: "p1",
                    colors: ["Navy", "Teal"],
                },
            },
        ]);
        expect(result[0]?.metadata.variantConfigs).toEqual([SIZE_CONFIG]);
    });

    test("uses Unknown as category name when the primary category has no name", async () => {
        const { resolver } = await run({
            answers: [aiProduct("p1", { suggestedVariantGroups: ["Size"] })],
            products: [product("p1", "b3", { metadata: { isVariant: true } })],
            tree: [createTestCategory({ id: "b3" })],
            names: [],
        });

        expect(resolver.calls[0]?.context.category).toBe("Unknown");
    });

    test("leaves variant configs empty when the resolver finds none", async () => {
        const { result } = await run({
            answers: [aiProduct("p1", { suggestedVariantGroups: ["Size"] })],
            products: [product("p1", "b1", { metadata: { isVariant: true } })],
            configs: [],
        });

        expect(result[0]?.metadata.variantConfigs).toBeUndefined();
    });

    test("does not resolve variants for simple products or without suggested groups", async () => {
        const { resolver } = await run({
            answers: [
                aiProduct("p1", { suggestedVariantGroups: ["Size"] }),
                aiProduct("p2", { suggestedVariantGroups: [] }),
            ],
            products: [product("p1", "b1"), product("p2", "b1", { metadata: { isVariant: true } })],
            configs: [SIZE_CONFIG],
        });

        expect(resolver.calls).toEqual([]);
    });

    test("returns the products of the other branches when one branch fails", async () => {
        const { result } = await run({
            answers: [aiProduct("p1"), aiProduct("p2")],
            products: [product("p1", "b1"), product("p2", "b2")],
            names: [
                { id: "b1", name: "Lamps" },
                { id: "b2", name: "Broken Rugs" },
            ],
        });

        expect(result.map((p) => p.id)).toEqual(["p1"]);
    });

    test("throws with the first reason when every branch fails", async () => {
        const promise = run({
            answers: [aiProduct("p1")],
            products: [product("p1", "b1"), product("p2", "b2")],
            names: [
                { id: "b1", name: "Broken Lamps" },
                { id: "b2", name: "Broken Rugs" },
            ],
        });

        await expect(promise).rejects.toThrow(
            "All 2 hydration branches failed — no products were generated. Reason: AI is down"
        );
    });
});
