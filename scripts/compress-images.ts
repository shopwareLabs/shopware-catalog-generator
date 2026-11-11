/**
 * Recompress the cached images of every SalesChannel in a cache directory.
 *
 * Usage:
 *   bun run images:compress [cacheDir] [--dry-run]
 *
 * cacheDir defaults to CACHE_DIR or ./generated (the folder that contains sales-channels/).
 * Run it once on caches and templates created before images were compressed on save.
 * It is safe to run again: images that are already compressed are left unchanged.
 */

import fs from "node:fs";
import path from "node:path";

import type { RecompressResult } from "./image-recompress.js";

import { recompressImagesDir } from "./image-recompress.js";

function formatMb(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatResult(name: string, result: RecompressResult): string {
    const share = result.bytesBefore ? (result.bytesAfter / result.bytesBefore) * 100 : 100;
    return [
        `${name}: ${result.compressed}/${result.files} compressed,`,
        `${formatMb(result.bytesBefore)} → ${formatMb(result.bytesAfter)} (${share.toFixed(1)}%),`,
        `${result.hashesUpdated} colour image hashes updated`,
    ].join(" ");
}

interface Args {
    cacheDir: string;
    dryRun: boolean;
}

function parseArgs(args: string[]): Args {
    const positional = args.find((arg) => !arg.startsWith("--"));
    return {
        cacheDir: positional ?? process.env.CACHE_DIR ?? "./generated",
        dryRun: args.includes("--dry-run"),
    };
}

/** SalesChannel image folders in a cache directory (exits when there is none) */
function salesChannelImageDirs(cacheDir: string): Array<{ name: string; dir: string }> {
    const salesChannelsDir = path.join(cacheDir, "sales-channels");
    if (!fs.existsSync(salesChannelsDir)) {
        console.error(`No sales-channels folder in ${cacheDir}`);
        process.exit(1);
    }
    return fs
        .readdirSync(salesChannelsDir)
        .sort()
        .map((name) => ({ name, dir: path.join(salesChannelsDir, name, "images") }))
        .filter(({ dir }) => fs.existsSync(dir));
}

async function main(): Promise<void> {
    const { cacheDir, dryRun } = parseArgs(process.argv.slice(2));
    const channels = salesChannelImageDirs(cacheDir);
    const prefix = dryRun ? "[DRY RUN] " : "";
    console.log(`${prefix}Recompressing images of ${channels.length} SalesChannels`);

    let before = 0;
    let after = 0;
    for (const { name, dir } of channels) {
        const result = await recompressImagesDir(dir, { dryRun });
        before += result.bytesBefore;
        after += result.bytesAfter;
        console.log(`  ${formatResult(name, result)}`);
    }
    console.log(`Total: ${formatMb(before)} → ${formatMb(after)}`);
}

await main();
