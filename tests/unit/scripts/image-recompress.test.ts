import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { recompressImagesDir } from "../../../scripts/image-recompress.js";
import { hashImage } from "../../../src/blueprint/hydrators/index.js";
import { DataCache } from "../../../src/cache.js";
import { createUncompressedImage } from "../../helpers/image-factory.js";

const SC = "test-store";
const cacheDirs: string[] = [];

function createTestCache(): DataCache {
    const cacheDir = `/tmp/test-image-recompress-${Date.now()}-${cacheDirs.length}`;
    cacheDirs.push(cacheDir);
    return new DataCache({ cacheDir, enabled: true, useCache: true });
}

afterEach(() => {
    for (const dir of cacheDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Cache with an uncompressed parent, a fresh and a stale colour image of it */
async function seedCache(): Promise<{ cache: DataCache; imagesDir: string; parent: string }> {
    const cache = createTestCache();
    const parent = (await createUncompressedImage()).toString("base64");
    const colour = (await createUncompressedImage("webp", 128, 128)).toString("base64");
    cache.images.saveImageWithView(SC, "p1", "front", parent, "prompt", "mock");
    for (const [view, sourceHash] of [
        ["front--navy", hashImage(parent)],
        ["front--olive", "outdated"],
    ]) {
        cache.images.saveVariantColorImage(SC, "p1", view ?? "", colour, {
            prompt: "recolour",
            sourceHash,
        });
    }
    cache.images.saveImageWithView(SC, "c1", "banner", parent, "p", "mock", "category_media");
    cache.images.saveImageForSalesChannel(SC, "hero", "hero", parent, "p", "mock", "cms_media");
    return { cache, imagesDir: cache.images.getSalesChannelImagesDir(SC), parent };
}

function sourceHashOf(cache: DataCache, view: string): string | undefined {
    return cache.images.loadImageMetadataWithView(SC, "p1", view, "product_media")?.sourceHash;
}

describe("recompressImagesDir", () => {
    test("compresses product, category and CMS images in place", async () => {
        const { imagesDir, parent } = await seedCache();
        const themeDir = path.join(imagesDir, "theme_media");
        fs.mkdirSync(themeDir, { recursive: true });
        fs.writeFileSync(path.join(themeDir, "store-logo.webp"), Buffer.from(parent, "base64"));

        const result = await recompressImagesDir(imagesDir);

        expect(result.files).toBe(5);
        expect(result.compressed).toBe(5);
        expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
        const cmsSize = fs.statSync(path.join(imagesDir, "cms_media", "hero.webp")).size;
        expect(cmsSize).toBeLessThan(Buffer.byteLength(parent, "base64"));
        const themeSize = fs.statSync(path.join(themeDir, "store-logo.webp")).size;
        expect(themeSize).toBe(Buffer.byteLength(parent, "base64"));
    });

    test("points fresh colour images at the recompressed parent, keeps stale ones stale", async () => {
        const { cache, imagesDir } = await seedCache();

        const result = await recompressImagesDir(imagesDir);

        const newParent = cache.images.loadImageWithView(SC, "p1", "front", "product_media");
        expect(result.hashesUpdated).toBe(1);
        expect(sourceHashOf(cache, "front--navy")).toBe(hashImage(newParent ?? ""));
        expect(sourceHashOf(cache, "front--olive")).toBe("outdated");
    });

    test("a second run changes nothing", async () => {
        const { imagesDir } = await seedCache();
        await recompressImagesDir(imagesDir);

        const second = await recompressImagesDir(imagesDir);

        expect(second.compressed).toBe(0);
        expect(second.hashesUpdated).toBe(0);
        expect(second.bytesAfter).toBe(second.bytesBefore);
    });

    test("dry run reports the savings without writing", async () => {
        const { cache, imagesDir, parent } = await seedCache();

        const result = await recompressImagesDir(imagesDir, { dryRun: true });

        expect(result.compressed).toBe(5);
        expect(result.hashesUpdated).toBe(0);
        expect(cache.images.loadImageWithView(SC, "p1", "front", "product_media")).toBe(parent);
        expect(sourceHashOf(cache, "front--navy")).toBe(hashImage(parent));
    });

    test("returns empty counts for a folder without images", async () => {
        const result = await recompressImagesDir("/tmp/does-not-exist-image-recompress");

        expect(result).toEqual({
            files: 0,
            compressed: 0,
            bytesBefore: 0,
            bytesAfter: 0,
            hashesUpdated: 0,
        });
    });
});
