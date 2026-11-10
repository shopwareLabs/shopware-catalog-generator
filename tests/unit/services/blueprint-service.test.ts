import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";

import { DataCache } from "../../../src/cache.js";
import {
    finalizeHydratedBlueprint,
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
