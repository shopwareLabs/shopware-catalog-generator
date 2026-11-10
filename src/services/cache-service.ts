/**
 * Cache service - local cache and trash operations shared by the cache CLI and MCP tools.
 *
 * Every function returns output lines; a line starting with "Error:" marks a failure.
 * Paths come from the DataCache (CACHE_DIR), never from a hard-coded "generated/".
 */

import fs from "node:fs";
import path from "node:path";

import { createCacheFromEnv, type DataCache } from "../cache.js";

const RESTORE_HINT = "To restore: cache_restore (CLI: bun run cache:restore -- <item>)";

/** Cached SalesChannels with description, categories, products and images */
export function listCache(cache: DataCache = createCacheFromEnv()): string[] {
    const salesChannels = cache.listSalesChannels();
    if (salesChannels.length === 0) return ["No cached data found."];

    return [
        "Cached SalesChannels:",
        "",
        ...salesChannels.flatMap((name) => describeSalesChannel(cache, name)),
        `Total: ${salesChannels.length} SalesChannel(s)`,
    ];
}

function describeSalesChannel(cache: DataCache, name: string): string[] {
    const metadata = cache.loadSalesChannelMetadata(name);
    const blueprint = cache.loadHydratedBlueprint(name);
    const categoryCount = blueprint?.categories?.length ?? 0;
    const metadataLines = metadata
        ? [
              `    Description: ${metadata.description || "-"}`,
              `    Created: ${new Date(metadata.createdAt).toLocaleString()}`,
              ...(metadata.shopwareId ? [`    Shopware ID: ${metadata.shopwareId}`] : []),
          ]
        : [];
    return [
        `  ${name}`,
        ...metadataLines,
        `    Categories: ${categoryCount > 0 ? categoryCount : "No"}`,
        `    Products: ${blueprint?.products?.length ?? 0}`,
        `    Images: ${cache.images.getImageCountForSalesChannel(name)}`,
        "",
    ];
}

/** Move one SalesChannel (or the whole cache) to the trash */
export function clearCache(
    options: { salesChannel?: string },
    cache: DataCache = createCacheFromEnv()
): string[] {
    const { salesChannel } = options;
    if (salesChannel) {
        if (!fs.existsSync(cache.getSalesChannelDir(salesChannel))) {
            return [`No cache found for SalesChannel "${salesChannel}".`];
        }
        cache.clearSalesChannel(salesChannel);
        return [
            `Moved cache for "${salesChannel}" to trash (${cache.getTrashDir()}).`,
            RESTORE_HINT,
        ];
    }

    if (!fs.existsSync(cache.getCacheDir())) return ["No cache found."];
    cache.clearAll();
    return [`Moved all cached data to trash (${cache.getTrashDir()}).`, RESTORE_HINT];
}

/** Items in the trash */
export function listTrash(cache: DataCache = createCacheFromEnv()): string[] {
    const items = cache.listTrash();
    if (items.length === 0) return ["Trash is empty."];
    return [
        "Trash contents:",
        "",
        ...items.map((item) => `  ${item}`),
        "",
        `Total: ${items.length} item(s)`,
        `Location: ${cache.getTrashDir()}`,
        "",
        RESTORE_HINT,
    ];
}

/** Where a trash item goes back to (inside CACHE_DIR) */
export function restoreTargetPath(cache: DataCache, item: string): string {
    if (item.startsWith("all-cache-")) return cache.getCacheDir();
    if (item.startsWith("sales-channel-")) {
        // Format: sales-channel-{name}-{ISO timestamp}
        const match = item.match(/^sales-channel-(.+?)-\d{4}-\d{2}-\d{2}T/);
        const name = match?.[1] ?? item.slice("sales-channel-".length).split("-")[0] ?? item;
        return cache.getSalesChannelDir(name);
    }
    return path.join(cache.getCacheDir(), item);
}

/** True when the target is free; an empty leftover directory is removed */
function isRestoreTargetFree(targetPath: string): boolean {
    if (!fs.existsSync(targetPath)) return true;
    try {
        if (fs.statSync(targetPath).isDirectory() && fs.readdirSync(targetPath).length === 0) {
            fs.rmdirSync(targetPath);
            return true;
        }
    } catch {
        // Unreadable target: treat as occupied
    }
    return false;
}

/** Restore one trash item, every item (all) or list the items when neither is given */
export function restoreFromTrash(
    options: { item?: string; all?: boolean },
    cache: DataCache = createCacheFromEnv()
): string[] {
    const items = cache.listTrash();
    if (options.all) return restoreAll(cache, items);
    if (!options.item) {
        if (items.length === 0) return ["Trash is empty."];
        return [
            "Please specify an item to restore:",
            "",
            ...items.map((item) => `  ${item}`),
            "",
            "Restore everything: cache_restore with all (CLI: bun run cache:restore -- --all)",
        ];
    }
    return restoreItem(cache, options.item);
}

function restoreItem(cache: DataCache, item: string): string[] {
    const targetPath = restoreTargetPath(cache, item);
    if (!isRestoreTargetFree(targetPath)) {
        return [`Error: Restore target already exists and is not empty: ${targetPath}`];
    }
    if (!cache.restoreFromTrash(item, targetPath)) {
        return [`Error: Failed to restore "${item}". Check the item name with cache_trash.`];
    }
    return [`Restored "${item}" to ${targetPath}`];
}

function restoreAll(cache: DataCache, items: string[]): string[] {
    if (items.length === 0) return ["Trash is empty."];

    const outcomes = items.map((item) => {
        const targetPath = restoreTargetPath(cache, item);
        if (!isRestoreTargetFree(targetPath)) return "skipped";
        return cache.restoreFromTrash(item, targetPath) ? "restored" : "failed";
    });
    const count = (outcome: string): number => outcomes.filter((o) => o === outcome).length;
    const lines = [
        `Restore-all complete: ${count("restored")} restored, ${count("skipped")} skipped, ${count("failed")} failed`,
    ];
    if (count("skipped") > 0) lines.push("Skipped items had non-empty existing targets.");
    if (count("failed") > 0) lines.push("Error: Some items could not be restored.");
    return lines;
}

/** Permanently delete the trash; needs confirm=true (CLI: --confirm) */
export function emptyTrash(
    options: { confirm: boolean },
    cache: DataCache = createCacheFromEnv()
): string[] {
    if (!options.confirm) {
        return [
            "Error: Emptying the trash cannot be undone. Set confirm=true (CLI: --confirm). " +
                "Review the items with cache_trash first.",
        ];
    }
    const count = cache.listTrash().length;
    if (count === 0) return ["Trash is already empty."];
    cache.emptyTrash();
    return [`Permanently deleted ${count} item(s) from trash.`];
}
