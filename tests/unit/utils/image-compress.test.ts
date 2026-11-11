import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import { compressImage, detectImageFormat } from "../../../src/utils/index.js";
import { createUncompressedImage } from "../../helpers/image-factory.js";

describe("compressImage", () => {
    test("re-encodes a lossless WebP as a smaller lossy WebP with the same size", async () => {
        const source = await createUncompressedImage("webp");

        const result = Buffer.from(await compressImage(source.toString("base64")), "base64");

        expect(result.length).toBeLessThan(source.length);
        expect(detectImageFormat(result).extension).toBe("webp");
        const meta = await sharp(result).metadata();
        expect(meta.width).toBe(256);
        expect(meta.height).toBe(128);
    });

    test("converts other formats (PNG) to WebP", async () => {
        const source = await createUncompressedImage("png");

        const result = Buffer.from(await compressImage(source.toString("base64")), "base64");

        expect(detectImageFormat(result).extension).toBe("webp");
        expect(result.length).toBeLessThan(source.length);
    });

    test("does not re-compress an image that is already compressed", async () => {
        const once = await compressImage(
            (await createUncompressedImage("webp")).toString("base64")
        );

        expect(await compressImage(once)).toBe(once);
    });

    test("returns data that is not an image unchanged", async () => {
        const notAnImage = Buffer.from("not an image").toString("base64");

        expect(await compressImage(notAnImage)).toBe(notAnImage);
    });
});
