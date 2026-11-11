/**
 * Recompress the cached images of a SalesChannel in place (pure parts of compress-images.ts).
 *
 * Every image goes through compressImage, the same step new images take before they are
 * cached. Colour images store a hash of their parent image (sourceHash): when a parent is
 * recompressed, the hash of each colour image that was fresh is updated to the new parent,
 * so the colour images are not regenerated. Colour images that were already stale stay stale.
 */

import fs from "node:fs";
import path from "node:path";

import { hashImage, SHADE_VIEW_SEPARATOR } from "../src/blueprint/hydrators/index.js";
import { compressImage, ConcurrencyLimiter } from "../src/utils/index.js";

/** Media folders with generated images (theme media are encoded by trimAndResize already) */
export const RECOMPRESS_MEDIA_DIRS = ["product_media", "category_media", "cms_media"];

const CONCURRENCY = 8;

export interface RecompressResult {
    files: number;
    compressed: number;
    bytesBefore: number;
    bytesAfter: number;
    hashesUpdated: number;
}

export interface RecompressOptions {
    dryRun?: boolean;
}

interface FileResult {
    file: string;
    before: number;
    after: number;
}

/** Recompress all images of one SalesChannel images folder (…/{salesChannel}/images) */
export async function recompressImagesDir(
    imagesDir: string,
    options: RecompressOptions = {}
): Promise<RecompressResult> {
    const files = RECOMPRESS_MEDIA_DIRS.flatMap((dir) => listWebpFiles(path.join(imagesDir, dir)));
    const parentHashes = hashFiles(files.filter(isParentImage));

    const limiter = new ConcurrencyLimiter(CONCURRENCY);
    const results = await limiter.all(files.map((file) => () => recompressFile(file, options)));

    const hashesUpdated = options.dryRun
        ? 0
        : updateColourImageHashes(path.join(imagesDir, "product_media"), parentHashes);

    return {
        files: files.length,
        compressed: results.filter((r) => r.after < r.before).length,
        bytesBefore: sum(results.map((r) => r.before)),
        bytesAfter: sum(results.map((r) => r.after)),
        hashesUpdated,
    };
}

function listWebpFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".webp"))
        .sort()
        .map((name) => path.join(dir, name));
}

/** Parent product images are the source of colour images; colour images contain "--" */
function isParentImage(file: string): boolean {
    return path.basename(path.dirname(file)) === "product_media" && !isColourImage(file);
}

function isColourImage(file: string): boolean {
    return path.basename(file).includes(SHADE_VIEW_SEPARATOR);
}

function readBase64(file: string): string {
    return fs.readFileSync(file).toString("base64");
}

function hashFiles(files: string[]): Map<string, string> {
    return new Map(files.map((file) => [file, hashImage(readBase64(file))]));
}

async function recompressFile(file: string, options: RecompressOptions): Promise<FileResult> {
    const source = readBase64(file);
    const compressed = await compressImage(source);
    const before = Buffer.byteLength(source, "base64");
    const after = Buffer.byteLength(compressed, "base64");
    if (compressed !== source && !options.dryRun) {
        fs.writeFileSync(file, Buffer.from(compressed, "base64"));
    }
    return { file, before, after };
}

/**
 * Point colour images at their recompressed parent. Only colour images whose hash matched
 * the parent before recompression are updated. Returns the number of updated metadata files.
 */
function updateColourImageHashes(productDir: string, oldParentHashes: Map<string, string>): number {
    const colourImages = listWebpFiles(productDir).filter(isColourImage);
    return colourImages.filter((file) => updateColourImageHash(file, oldParentHashes)).length;
}

function updateColourImageHash(file: string, oldParentHashes: Map<string, string>): boolean {
    const parent = parentImageOf(file);
    const oldHash = oldParentHashes.get(parent);
    const metadataFile = file.replace(/\.webp$/, ".json");
    if (!oldHash || !fs.existsSync(metadataFile)) return false;

    const metadata: { sourceHash?: string } = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    const newHash = hashImage(readBase64(parent));
    if (metadata.sourceHash !== oldHash || newHash === oldHash) return false;

    fs.writeFileSync(metadataFile, JSON.stringify({ ...metadata, sourceHash: newHash }, null, 2));
    return true;
}

/** "{id}-front--burgundy.webp" → "{id}-front.webp" */
function parentImageOf(colourImage: string): string {
    const name = path.basename(colourImage);
    const parentName = `${name.slice(0, name.indexOf(SHADE_VIEW_SEPARATOR))}.webp`;
    return path.join(path.dirname(colourImage), parentName);
}

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0);
}
