/**
 * Lossy WebP compression for generated images before they are cached.
 *
 * AI image providers return near-lossless images (OpenAI WebP at quality 100, median ~1.2 MB).
 * WebP quality 80 looks the same in the storefront and is about 8% of the size. The native
 * size is kept: Shopware's thumbnails (400, 800, 1920 px) are all downscales of it.
 */

import sharp from "sharp";

/** WebP quality for cached images (one lossy pass, visually identical to the source) */
export const IMAGE_WEBP_QUALITY = 80;

/**
 * Minimum size reduction for the compressed image to be kept. A fresh provider image shrinks
 * by about 90%, an image that is already WebP 80 only by about 10%: the threshold keeps
 * compression to a single lossy pass, so running it twice does not degrade the image.
 */
const MIN_SAVING = 0.25;

/**
 * Re-encode a base64 image as WebP at {@link IMAGE_WEBP_QUALITY}.
 *
 * Returns the input unchanged when the result is not at least {@link MIN_SAVING} smaller
 * (already compressed) or when the data cannot be decoded, so a compression problem never
 * loses a generated image.
 */
export async function compressImage(base64: string): Promise<string> {
    const source = Buffer.from(base64, "base64");
    try {
        const compressed = await sharp(source).webp({ quality: IMAGE_WEBP_QUALITY }).toBuffer();
        if (compressed.length > source.length * (1 - MIN_SAVING)) return base64;
        return compressed.toString("base64");
    } catch {
        return base64;
    }
}
