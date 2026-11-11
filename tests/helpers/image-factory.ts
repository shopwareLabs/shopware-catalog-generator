import sharp from "sharp";

/**
 * Pseudo-random noise image, encoded losslessly. Like a provider image it is large, and
 * lossy WebP makes it much smaller (compressImage keeps the result).
 */
export async function createUncompressedImage(
    format: "png" | "webp" = "webp",
    width = 256,
    height = 128
): Promise<Buffer> {
    const pixels = Buffer.alloc(width * height * 3);
    let seed = 42;
    for (let i = 0; i < pixels.length; i++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        pixels[i] = seed >>> 24;
    }
    const image = sharp(pixels, { raw: { width, height, channels: 3 } });
    return format === "png" ? image.png().toBuffer() : image.webp({ lossless: true }).toBuffer();
}
