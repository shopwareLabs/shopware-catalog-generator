import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { HydrateDeps } from "../../../src/services/blueprint-service.js";

import { DataCache } from "../../../src/cache.js";
import { imagesEnabled, NoOpImageProvider } from "../../../src/providers/index.js";
import {
    estimateBlueprintCost,
    finalizeHydratedBlueprint,
    hydrateBlueprint,
    resolveCmsStoreDescription,
} from "../../../src/services/blueprint-service.js";
import { createTestBlueprint, createTestProduct } from "../../helpers/blueprint-factory.js";
import { EditingImageProvider } from "../../mocks/image-provider.mock.js";
import { MockTextProvider } from "../../mocks/text-provider.mock.js";

describe("resolveCmsStoreDescription", () => {
    test("returns hydrated description when present", () => {
        expect(resolveCmsStoreDescription("shop", "blueprint desc", "hydrated desc")).toBe(
            "hydrated desc"
        );
    });

    test("falls back to blueprint description when hydrated is absent", () => {
        expect(resolveCmsStoreDescription("shop", "blueprint desc", undefined)).toBe(
            "blueprint desc"
        );
    });

    test("falls back to blueprint description when hydrated is empty string", () => {
        expect(resolveCmsStoreDescription("shop", "blueprint desc", "")).toBe("blueprint desc");
    });

    test("falls back to blueprint description when hydrated is whitespace only", () => {
        expect(resolveCmsStoreDescription("shop", "blueprint desc", "   ")).toBe("blueprint desc");
    });

    test("falls back to salesChannelName webshop when both descriptions absent", () => {
        expect(resolveCmsStoreDescription("my-shop", undefined, undefined)).toBe("my-shop webshop");
    });

    test("falls back to salesChannelName webshop when both descriptions empty", () => {
        expect(resolveCmsStoreDescription("furniture", "", "")).toBe("furniture webshop");
    });

    test("returns hydrated description even when blueprint description exists", () => {
        const result = resolveCmsStoreDescription("shop", "ignored", "winner");
        expect(result).toBe("winner");
    });
});

describe("finalizeHydratedBlueprint", () => {
    const SC = "test-store";
    const cacheDir = `/tmp/test-finalize-hydration-${Date.now()}`;

    afterEach(() => {
        fs.rmSync(cacheDir, { recursive: true, force: true });
    });

    function colourVariantBlueprint(): ReturnType<typeof createTestBlueprint> {
        return createTestBlueprint({
            products: [
                createTestProduct({
                    id: "p1",
                    metadata: {
                        isVariant: true,
                        properties: [],
                        imageDescriptions: [{ view: "front", prompt: "front prompt" }],
                        // Only the variant config: variantColors are set by the colour system
                        variantConfigs: [
                            {
                                group: "Color",
                                selectedOptions: ["Navy", "Burgundy"],
                                priceModifiers: { Navy: 1, Burgundy: 1 },
                            },
                        ],
                    },
                }),
            ],
        });
    }

    function setup(): { cache: DataCache; image: EditingImageProvider } {
        const cache = new DataCache({ cacheDir, enabled: true, useCache: true });
        const parent = Buffer.from("parent-front").toString("base64");
        cache.images.saveImageWithView(SC, "p1", "front", parent, "prompt", "mock");
        return { cache, image: new EditingImageProvider() };
    }

    test("recolours images with the colours the colour system just assigned", async () => {
        const { cache, image } = setup();
        const blueprint = colourVariantBlueprint();

        await finalizeHydratedBlueprint(
            { text: new MockTextProvider(), image },
            cache,
            SC,
            blueprint,
            [],
            { variantImages: true }
        );

        expect(blueprint.products[0]?.metadata.variantColors?.map((c) => c.name)).toEqual([
            "Navy",
            "Burgundy",
        ]);
        // Navy is the default colour (parent images); only Burgundy is recoloured
        expect(image.edits).toHaveLength(1);
        expect(image.edits[0]?.prompt).toContain("Burgundy");
    });

    test("skips the colour images for selective runs", async () => {
        const { cache, image } = setup();

        await finalizeHydratedBlueprint(
            { text: new MockTextProvider(), image },
            cache,
            SC,
            colourVariantBlueprint(),
            [],
            { variantImages: false }
        );

        expect(image.edits).toHaveLength(0);
    });
});

describe("hydrateBlueprint and estimateBlueprintCost", () => {
    let root: string;
    let cache: DataCache;
    let text: MockTextProvider;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "hydrate-service-"));
        cache = new DataCache({ cacheDir: path.join(root, "generated") });
        text = new MockTextProvider();
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const deps = (image = new NoOpImageProvider()): HydrateDeps => ({
        cache,
        providers: { text, image },
        loadExistingProperties: async () => [],
    });

    const saveBlueprints = (withHydrated: boolean): void => {
        const hydrated = createTestBlueprint();
        cache.saveBlueprint("test-store", hydrated);
        if (withHydrated) cache.saveHydratedBlueprint("test-store", hydrated);
    };

    test("imagesEnabled is false only for the disabled image provider", () => {
        expect(imagesEnabled(new NoOpImageProvider())).toBe(false);
        expect(imagesEnabled(new EditingImageProvider())).toBe(true);
    });

    test("refuses to overwrite an existing hydrated blueprint without --only or --rehydrate", async () => {
        saveBlueprints(true);
        const lines = await hydrateBlueprint("test-store", {}, deps());

        expect(lines[0]).toStartWith("Error: Hydrated blueprint already exists");
        expect(text.callCount).toBe(0);
    });

    test("returns the same errors from hydrate and estimate", async () => {
        const noBlueprint = await hydrateBlueprint("test-store", {}, deps());
        expect(noBlueprint[0]).toStartWith('Error: No blueprint found for "test-store"');
        expect(estimateBlueprintCost("test-store", {}, cache)).toEqual(noBlueprint);

        saveBlueprints(false);
        const variants = await hydrateBlueprint("test-store", { only: "variants" }, deps());
        expect(variants[0]).toStartWith("Error: --only=variants needs a hydrated blueprint");
        expect(estimateBlueprintCost("test-store", { only: "variants" }, cache)).toEqual(variants);

        const overrides = { variants: { colors: "6" } };
        const misplaced = await hydrateBlueprint("test-store", overrides, deps());
        expect(misplaced[0]).toStartWith(
            "Error: Variant settings can only change with --only=variants"
        );
        expect(estimateBlueprintCost("test-store", overrides, cache)).toEqual(misplaced);

        expect(text.callCount).toBe(0);
    });

    test("--only=variants rejects a share change", async () => {
        saveBlueprints(true);
        const lines = await hydrateBlueprint(
            "test-store",
            { only: "variants", variants: { share: "0.5" } },
            deps()
        );

        expect(lines[0]).toStartWith("Error: --variant-share can only be set at blueprint create");
    });

    test("--only=prices needs a hydrated blueprint", async () => {
        saveBlueprints(false);
        const lines = await hydrateBlueprint("test-store", { only: "prices" }, deps());

        expect(lines[0]).toStartWith("Error: --only=prices needs a hydrated blueprint");
        expect(text.callCount).toBe(0);
    });

    test("--only=prices re-prices products and keeps names", async () => {
        const blueprint = createTestBlueprint({
            products: [createTestProduct({ name: "Foam Earplugs", price: 243 })],
        });
        cache.saveBlueprint("test-store", blueprint);
        cache.saveHydratedBlueprint("test-store", blueprint);
        const before = cache.loadHydratedBlueprint("test-store");
        text.setResponse("PriceRanges", { prices: [{ index: 1, min: 2, max: 4 }] });

        const lines = await hydrateBlueprint("test-store", { only: "prices" }, deps());

        const after = cache.loadHydratedBlueprint("test-store");
        expect(lines).toContain("  Mode: prices");
        expect(text.getCalls().map((c) => c.schemaName)).toEqual(["PriceRanges"]);
        expect(after?.products[0]?.name).toBe(before?.products[0]?.name);
        expect(after?.products[0]?.price).toBeLessThanOrEqual(3.99);
        expect(cache.loadGenerationLog("test-store")?.steps["hydrate:prices"]).toBeDefined();
    });

    test("--only=names renames duplicates and keeps prices", async () => {
        const blueprint = createTestBlueprint({
            products: [
                createTestProduct({ id: "a", name: "Foam Earplugs", price: 5 }),
                createTestProduct({ id: "b", name: "Foam Earplugs", price: 7 }),
            ],
        });
        cache.saveBlueprint("test-store", blueprint);
        cache.saveHydratedBlueprint("test-store", blueprint);
        text.setResponse("ProductNames", { names: [{ index: 1, name: "Foam Earplugs - Travel" }] });

        const lines = await hydrateBlueprint("test-store", { only: "names" }, deps());

        const after = cache.loadHydratedBlueprint("test-store");
        expect(lines).toContain("  Mode: names");
        expect(text.getCalls().map((c) => c.schemaName)).toEqual(["ProductNames"]);
        expect(after?.products.map((p) => p.name)).toEqual([
            "Foam Earplugs",
            "Foam Earplugs - Travel",
        ]);
        expect(after?.products.map((p) => p.price)).toEqual([5, 7]);
    });

    test("--only=variant-images does nothing when images are disabled", async () => {
        saveBlueprints(true);
        const lines = await hydrateBlueprint("test-store", { only: "variant-images" }, deps());

        expect(lines).toContain("Images are disabled (IMAGE_PROVIDER=none), nothing to do.");
        expect(cache.loadGenerationLog("test-store")).toBeNull();
    });

    test("estimate forecasts a valid run without AI calls", () => {
        saveBlueprints(false);
        const lines = estimateBlueprintCost("test-store", {}, cache);

        expect(lines.some((l) => l.startsWith("Error:"))).toBe(false);
        expect(lines.length).toBeGreaterThan(0);
        expect(text.callCount).toBe(0);
    });
});
