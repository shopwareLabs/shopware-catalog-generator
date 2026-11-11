import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";

import type { BlueprintProduct, VariantColor } from "../../../../src/types/index.js";

import {
    buildRecolorPrompt,
    collectVariantImageTasks,
    countVariantImages,
    hashImage,
    hydrateVariantImages,
    planVariantImages,
    resolveVariantImageViews,
    shadeSlug,
    variantImageView,
} from "../../../../src/blueprint/hydrators/variant-images.js";
import { DataCache } from "../../../../src/cache.js";
import { DEFAULT_VARIANT_SETTINGS } from "../../../../src/types/index.js";
import { createTestBlueprint, createTestProduct } from "../../../helpers/blueprint-factory.js";
import { createUncompressedImage } from "../../../helpers/image-factory.js";
import { EditingImageProvider, MockImageProvider } from "../../../mocks/image-provider.mock.js";

const SC = "test-store";
const NAVY: VariantColor = { name: "Navy", hex: "#1f2a44", family: "blue" };
const BURGUNDY: VariantColor = { name: "Burgundy", hex: "#722f37", family: "red" };
const OLIVE: VariantColor = { name: "Olive", family: "green" };
const SOURCE = Buffer.from("parent-front").toString("base64");

const cacheDirs: string[] = [];

function createTestCache(): DataCache {
    const cacheDir = `/tmp/test-variant-images-${Date.now()}-${cacheDirs.length}`;
    cacheDirs.push(cacheDir);
    return new DataCache({ cacheDir, enabled: true, useCache: true });
}

afterEach(() => {
    for (const dir of cacheDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function colourProduct(
    id: string,
    colors: VariantColor[] = [NAVY, BURGUNDY, OLIVE],
    views: Array<"front" | "lifestyle"> = ["front", "lifestyle"]
): BlueprintProduct {
    return createTestProduct({
        id,
        name: `Product ${id}`,
        metadata: {
            isVariant: true,
            properties: [],
            imageDescriptions: views.map((view) => ({ view, prompt: `${view} prompt` })),
            variantColors: colors,
        },
    });
}

function saveParent(cache: DataCache, productId: string, view: string, base64 = SOURCE): void {
    cache.images.saveImageWithView(SC, productId, view, base64, "prompt", "mock");
}

describe("helpers", () => {
    test("resolveVariantImageViews only accepts cover", () => {
        expect(resolveVariantImageViews({})).toBe("all");
        expect(resolveVariantImageViews({ VARIANT_IMAGE_VIEWS: " Cover " })).toBe("cover");
        expect(resolveVariantImageViews({ VARIANT_IMAGE_VIEWS: "front" })).toBe("all");
    });

    test("shadeSlug is file-safe and falls back to a hash", () => {
        expect(shadeSlug("Dusty Rose")).toBe("dusty-rose");
        expect(shadeSlug("深蓝")).toMatch(/^shade-[a-z0-9]{6}$/);
        expect(shadeSlug("深蓝")).toBe(shadeSlug("深蓝"));
    });

    test("variantImageView joins view and shade", () => {
        expect(variantImageView("front", "Burgundy")).toBe("front--burgundy");
    });

    test("buildRecolorPrompt names the shade and hex when known", () => {
        expect(buildRecolorPrompt(BURGUNDY)).toContain(
            "Recolour the product to Burgundy (#722f37)."
        );
        expect(buildRecolorPrompt(OLIVE)).toContain("Recolour the product to Olive.");
    });

    test("hashImage is stable and short", () => {
        expect(hashImage(SOURCE)).toBe(hashImage(SOURCE));
        expect(hashImage(SOURCE)).toHaveLength(16);
        expect(hashImage(SOURCE)).not.toBe(hashImage("other"));
    });
});

describe("collectVariantImageTasks", () => {
    test("skips the default colour and covers every view", () => {
        const tasks = collectVariantImageTasks({ products: [colourProduct("p1")] }, "all");

        expect(tasks.map((t) => t.view)).toEqual([
            "front--burgundy",
            "front--olive",
            "lifestyle--burgundy",
            "lifestyle--olive",
        ]);
        expect(tasks[0]?.sourceView).toBe("front");
    });

    test("cover limits the tasks to the first view", () => {
        const tasks = collectVariantImageTasks({ products: [colourProduct("p1")] }, "cover");

        expect(tasks.map((t) => t.view)).toEqual(["front--burgundy", "front--olive"]);
    });

    test("ignores products without colours", () => {
        expect(collectVariantImageTasks({ products: [createTestProduct()] }, "all")).toEqual([]);
    });
});

describe("countVariantImages", () => {
    test("counts known colours and estimates products that have none yet", () => {
        const pending = createTestProduct({
            id: "pending",
            metadata: {
                isVariant: true,
                properties: [],
                imageDescriptions: [{ view: "front", prompt: "p" }],
            },
        });
        const plain = createTestProduct({ id: "plain", metadata: { isVariant: false } });
        const blueprint = { products: [colourProduct("p1"), pending, plain] };

        // p1: 2 colours x 2 views, pending: (4 - 1) colours x 1 view
        expect(countVariantImages(blueprint, DEFAULT_VARIANT_SETTINGS, "all")).toBe(4 + 3);
        expect(countVariantImages(blueprint, DEFAULT_VARIANT_SETTINGS, "cover")).toBe(2 + 3);
    });
});

describe("planVariantImages", () => {
    test("splits tasks into pending, fresh, stale and missing source", () => {
        const cache = createTestCache();
        const blueprint = createTestBlueprint({ products: [colourProduct("p1")] });
        saveParent(cache, "p1", "front");
        cache.images.saveVariantColorImage(SC, "p1", "front--burgundy", SOURCE, {
            prompt: "x",
            sourceHash: hashImage(SOURCE),
            shade: "Burgundy",
        });
        cache.images.saveVariantColorImage(SC, "p1", "front--olive", SOURCE, {
            prompt: "x",
            sourceHash: "outdated",
            shade: "Olive",
        });

        const plan = planVariantImages(cache, SC, blueprint, "all");

        expect(plan.fresh).toBe(1);
        expect(plan.stale.map((t) => t.view)).toEqual(["front--olive"]);
        expect(plan.pending.map((t) => t.view)).toEqual(["front--olive"]);
        expect(plan.missingSource).toBe(2);
    });
});

describe("hydrateVariantImages", () => {
    test("skips providers without image editing", async () => {
        const cache = createTestCache();
        const provider = new MockImageProvider();
        const blueprint = createTestBlueprint({ products: [colourProduct("p1")] });
        saveParent(cache, "p1", "front");

        const result = await hydrateVariantImages(provider, cache, SC, blueprint, "all");

        expect(result.supported).toBe(false);
        expect(result.generated).toBe(0);
        expect(result.total).toBe(4);
        expect(provider.callCount).toBe(0);
    });

    test("recolours each parent view and stores shade, hex and source hash", async () => {
        const cache = createTestCache();
        const provider = new EditingImageProvider();
        const blueprint = createTestBlueprint({ products: [colourProduct("p1")] });
        saveParent(cache, "p1", "front");
        saveParent(cache, "p1", "lifestyle");

        const result = await hydrateVariantImages(provider, cache, SC, blueprint, "all");

        expect(result).toMatchObject({ generated: 4, failed: 0, skipped: 0, supported: true });
        expect(provider.edits.every((e) => e.sourceBase64 === SOURCE)).toBe(true);
        const metadata = cache.images.loadImageMetadataWithView(
            SC,
            "p1",
            "front--burgundy",
            "product_media"
        );
        expect(metadata).toMatchObject({
            shade: "Burgundy",
            hex: "#722f37",
            sourceHash: hashImage(SOURCE),
            imageModel: "mock",
        });
    });

    test("caches colour images as compressed WebP", async () => {
        const edited = await createUncompressedImage();
        const cache = createTestCache();
        const provider = new EditingImageProvider();
        provider.setEditResult(edited.toString("base64"));
        const blueprint = createTestBlueprint({
            products: [colourProduct("p1", [NAVY, BURGUNDY], ["front"])],
        });
        saveParent(cache, "p1", "front");

        await hydrateVariantImages(provider, cache, SC, blueprint, "all");

        const cached = cache.images.loadImageWithView(SC, "p1", "front--burgundy", "product_media");
        expect(cached).not.toBeNull();
        expect(Buffer.from(cached ?? "", "base64").length).toBeLessThan(edited.length);
    });

    test("is idempotent and regenerates only stale images after the parent changed", async () => {
        const cache = createTestCache();
        const provider = new EditingImageProvider();
        const blueprint = createTestBlueprint({ products: [colourProduct("p1")] });
        saveParent(cache, "p1", "front");
        saveParent(cache, "p1", "lifestyle");
        await hydrateVariantImages(provider, cache, SC, blueprint, "all");

        const again = await hydrateVariantImages(provider, cache, SC, blueprint, "all");
        expect(again).toMatchObject({ generated: 0, skipped: 4 });

        saveParent(cache, "p1", "front", Buffer.from("new-front").toString("base64"));
        const afterChange = await hydrateVariantImages(provider, cache, SC, blueprint, "all");
        expect(afterChange).toMatchObject({ generated: 2, skipped: 2, stale: 2 });
        expect(provider.edits).toHaveLength(6);
    });

    test("counts views without a cached parent image as missing", async () => {
        const cache = createTestCache();
        const provider = new EditingImageProvider();
        const blueprint = createTestBlueprint({ products: [colourProduct("p1")] });
        saveParent(cache, "p1", "front");

        const result = await hydrateVariantImages(provider, cache, SC, blueprint, "all");

        expect(result).toMatchObject({ generated: 2, missingSource: 2 });
    });

    test("does nothing for blueprints without colour variants", async () => {
        const provider = new EditingImageProvider();
        const result = await hydrateVariantImages(
            provider,
            createTestCache(),
            SC,
            createTestBlueprint({ products: [createTestProduct()] }),
            "all"
        );

        expect(result.total).toBe(0);
        expect(provider.edits).toHaveLength(0);
    });
});
