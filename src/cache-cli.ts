#!/usr/bin/env node
/**
 * Cache management CLI for the data generator
 *
 * Usage:
 *   bun run cache:list                       - List all cached SalesChannels
 *   bun run cache:clear                      - Clear all cache (moves to trash)
 *   bun run cache:clear -- furniture         - Clear specific SalesChannel (moves to trash)
 *   bun run cache:trash                      - List trash contents
 *   bun run cache:restore -- <item>          - Restore item from trash
 *   bun run cache:empty-trash                - Permanently delete trash
 */

import fs from "node:fs";

import { createCacheFromEnv } from "./cache.js";

const cache = createCacheFromEnv();

function printUsage(): void {
    console.log(`
Cache Management CLI - Manages local cached files

This command manages local cached data (products, images, categories) stored
in the generated/ folder. It does NOT affect your Shopware instance.

To also clean Shopware data, use: bun run cleanup -- --salesChannel=<name>

Usage:
  bun run cache:list                       List all cached SalesChannels with stats
  bun run cache:clear                      Move all cached data to trash
  bun run cache:clear -- [salesChannel]    Move specific SalesChannel cache to trash
  bun run cache:trash                      List trash contents (recoverable data)
  bun run cache:restore -- <item>          Restore specific item from trash
  bun run cache:restore -- --all           Restore all items from trash
  bun run cache:empty-trash                Permanently delete all trash (IRREVERSIBLE)

Examples:
  bun run cache:list
  bun run cache:clear
  bun run cache:clear -- furniture
  bun run cache:trash
  bun run cache:restore -- sales-channel-furniture-2024-01-28T12-00-00
  bun run cache:restore -- --all
  bun run cache:empty-trash

Note: Clearing moves data to .trash/ folder. Restore before emptying trash.
`);
}

function listCache(): void {
    const salesChannels = cache.listSalesChannels();

    if (salesChannels.length === 0) {
        console.log("No cached data found.");
        return;
    }

    console.log("\nCached SalesChannels:\n");

    for (const sc of salesChannels) {
        const metadata = cache.loadSalesChannelMetadata(sc);
        const blueprint = cache.loadHydratedBlueprint(sc);
        const hasCategories = blueprint && blueprint.categories && blueprint.categories.length > 0;
        const categoryCount = blueprint?.categories?.length ?? 0;
        const productCount = blueprint?.products?.length ?? 0;
        const imageCount = cache.images.getImageCountForSalesChannel(sc);

        console.log(`  ${sc}`);
        if (metadata) {
            console.log(`    Description: ${metadata.description || "-"}`);
            console.log(`    Created: ${new Date(metadata.createdAt).toLocaleString()}`);
            if (metadata.shopwareId) {
                console.log(`    Shopware ID: ${metadata.shopwareId}`);
            }
        }
        console.log(`    Categories: ${hasCategories ? categoryCount : "No"}`);
        console.log(`    Products: ${productCount}`);
        console.log(`    Images: ${imageCount}`);
        console.log("");
    }

    console.log(`Total: ${salesChannels.length} SalesChannel(s)\n`);
}

function clearCache(salesChannel?: string): void {
    if (salesChannel) {
        cache.clearSalesChannel(salesChannel);
    } else {
        cache.clearAll();
    }
}

function listTrash(): void {
    const trashItems = cache.listTrash();

    if (trashItems.length === 0) {
        console.log("\nTrash is empty.\n");
        return;
    }

    console.log("\nTrash contents:\n");
    for (const item of trashItems) {
        console.log(`  ${item}`);
    }
    console.log(`\nTotal: ${trashItems.length} item(s)`);
    console.log(`Location: ${cache.getTrashDir()}`);
    console.log("\nTo restore: bun run cache:restore -- <item-name>");
    console.log("To delete permanently: bun run cache:empty-trash\n");
}

function restoreFromTrash(itemName?: string): void {
    if (!itemName) {
        const trashItems = cache.listTrash();
        if (trashItems.length === 0) {
            console.log("\nTrash is empty.\n");
            return;
        }

        console.log("\nPlease specify an item to restore:\n");
        for (const item of trashItems) {
            console.log(`  ${item}`);
        }
        console.log("\nUsage:");
        console.log("  bun run cache:restore -- <item>");
        console.log("  bun run cache:restore -- --all\n");
        return;
    }

    if (itemName === "--all") {
        restoreAllFromTrash();
        return;
    }

    const targetPath = getRestoreTargetPath(itemName);
    const targetState = prepareRestoreTarget(targetPath);
    if (targetState === "exists-nonempty") {
        console.error(`Restore target already exists and is not empty: ${targetPath}`);
        console.log(
            "Use a specific restore item, clear the target first, or use --all for bulk restore."
        );
        process.exit(1);
    }

    const success = cache.restoreFromTrash(itemName, targetPath);
    if (success) {
        console.log("Restore complete!");
    } else {
        process.exit(1);
    }
}

function restoreAllFromTrash(): void {
    const trashItems = cache.listTrash();
    if (trashItems.length === 0) {
        console.log("\nTrash is empty.\n");
        return;
    }

    let restored = 0;
    let failed = 0;
    let skipped = 0;

    for (const item of trashItems) {
        const targetPath = getRestoreTargetPath(item);
        const targetState = prepareRestoreTarget(targetPath);
        if (targetState === "exists-nonempty") {
            skipped++;
            continue;
        }

        const success = cache.restoreFromTrash(item, targetPath);
        if (success) {
            restored++;
        } else {
            failed++;
        }
    }

    console.log(
        `\nRestore-all complete: ${restored} restored, ${skipped} skipped, ${failed} failed`
    );
    if (skipped > 0) {
        console.log("Skipped items had non-empty existing targets.");
    }
    if (failed > 0) {
        console.log("Some items could not be restored due to internal restore errors.");
    }
}

type TargetPrepareState = "ok" | "exists-nonempty";

function prepareRestoreTarget(targetPath: string): TargetPrepareState {
    if (!fs.existsSync(targetPath)) {
        return "ok";
    }

    try {
        const stats = fs.statSync(targetPath);
        if (stats.isDirectory()) {
            const entries = fs.readdirSync(targetPath);
            if (entries.length === 0) {
                fs.rmdirSync(targetPath);
                return "ok";
            }
        }
    } catch {
        // Treat errors conservatively as non-empty/unsafe to overwrite.
    }

    return "exists-nonempty";
}

function getRestoreTargetPath(itemName: string): string {
    if (itemName.startsWith("sales-channel-")) {
        // Format: sales-channel-{name}-{timestamp}
        const match = itemName.match(/^sales-channel-(.+?)-\d{4}-\d{2}-\d{2}T/);
        const scName = match ? match[1] : itemName.replace("sales-channel-", "").split("-")[0];
        return `generated/sales-channels/${scName}`;
    }

    if (itemName.startsWith("all-cache-")) {
        return "generated";
    }

    return `generated/${itemName}`;
}

function emptyTrash(): void {
    console.log("\n⚠️  WARNING: This will PERMANENTLY delete all trash. This cannot be undone!");
    console.log("Press Ctrl+C to cancel, or wait 3 seconds to continue...\n");

    // Give user time to cancel
    setTimeout(() => {
        cache.emptyTrash();
    }, 3000);
}

// Parse command
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
    case "list":
        listCache();
        break;

    case "clear":
        clearCache(args[1]);
        break;

    case "trash":
        listTrash();
        break;

    case "restore":
        restoreFromTrash(args[1]);
        break;

    case "empty-trash":
        emptyTrash();
        break;

    case "--help":
    case "-h":
    case undefined:
        printUsage();
        break;

    default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
}
