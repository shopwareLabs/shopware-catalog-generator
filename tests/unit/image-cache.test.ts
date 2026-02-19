import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ImageCache } from "../../src/image-cache.js";

const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("ImageCache", () => {
    let tempDir: string;
    let cache: ImageCache;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-cache-test-"));
        cache = new ImageCache({
            enabled: true,
            useCache: true,
            saveToCache: true,
            cacheDir: tempDir,
        });
    });

    afterEach(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true });
        }
    });

    test("builds media-type directories and local paths", () => {
        expect(cache.getProductImagesDir("My Store")).toContain("product_media");
        expect(cache.getCategoryImagesDir("My Store")).toContain("category_media");
        expect(cache.getCmsImagesDir("My Store")).toContain("cms_media");
        expect(cache.getPropertyImagesDir("My Store")).toContain("property_images");
        expect(cache.getLocalImagePath("My Store", "p-1", "front")).toContain("p-1-front.webp");
    });

    test("save/load/has/delete image with view works", () => {
        cache.saveImageWithView("music", "p1", "front", PNG_BASE64, "prompt", "test-model");

        expect(cache.hasImageWithView("music", "p1", "front")).toBe(true);
        const loaded = cache.loadImageWithView("music", "p1", "front");
        expect(loaded).toBe(PNG_BASE64);

        const metadata = cache.loadImageMetadataWithView("music", "p1", "front");
        expect(metadata?.productId).toBe("p1");
        expect(metadata?.prompt).toBe("prompt");

        cache.deleteImageWithView("music", "p1", "front");
        expect(cache.hasImageWithView("music", "p1", "front")).toBe(false);
        expect(cache.loadImageWithView("music", "p1", "front")).toBeNull();
    });

    test("legacy single-image format works and is counted", () => {
        cache.saveImageForSalesChannel("music", "legacy-1", "Legacy Product", PNG_BASE64, "legacy prompt");

        expect(cache.hasImageForSalesChannel("music", "legacy-1")).toBe(true);
        expect(cache.loadImageForSalesChannel("music", "legacy-1")).toBe(PNG_BASE64);
        expect(cache.getImageCountForSalesChannel("music")).toBe(1);
    });

    test("isImageStale compares normalized base prompt", () => {
        cache.saveImageWithView("music", "p2", "front", PNG_BASE64, "Oak table, bright studio", "model");
        expect(cache.isImageStale("music", "p2", "front", "oak table, warm lighting")).toBe(false);
        expect(cache.isImageStale("music", "p2", "front", "Walnut table, bright studio")).toBe(true);
    });

    test("returns null on malformed metadata/image read failures", () => {
        cache.saveImageWithView("music", "broken", "front", PNG_BASE64, "prompt", "model");
        const mediaDir = cache.getProductImagesDir("music");
        fs.writeFileSync(path.join(mediaDir, "broken-front.json"), "{invalid json");
        expect(cache.loadImageMetadataWithView("music", "broken", "front")).toBeNull();

        fs.writeFileSync(path.join(mediaDir, "bad-front.webp"), "not-base64-binary");
        // read still works as base64 from bytes, so ensure no throw and non-null
        expect(cache.loadImageWithView("music", "bad", "front")).not.toBeNull();
    });

    test("respects disabled cache flags", () => {
        const disabled = new ImageCache({
            enabled: false,
            useCache: false,
            saveToCache: false,
            cacheDir: tempDir,
        });

        disabled.saveImageWithView("music", "x", "front", PNG_BASE64, "prompt");
        expect(disabled.hasImageWithView("music", "x", "front")).toBe(false);
        expect(disabled.loadImageWithView("music", "x", "front")).toBeNull();
        expect(disabled.loadImageForSalesChannel("music", "x")).toBeNull();
    });
});

