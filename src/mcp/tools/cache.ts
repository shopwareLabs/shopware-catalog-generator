/**
 * Cache Tools for MCP Server
 *
 * Exposes cache management commands: list, clear, trash, restore.
 */

import type { FastMCP } from "fastmcp";

import { z } from "zod";

import { createCacheFromEnv } from "../../cache.js";

export function registerCacheTools(server: FastMCP): void {
    // cache_list - List all cached SalesChannels
    server.addTool({
        name: "cache_list",
        description:
            "List all cached SalesChannels with their metadata, category tree status, and image counts.",
        parameters: z.object({}),
        execute: async () => {
            const cache = createCacheFromEnv();
            const salesChannels = cache.listSalesChannels();

            if (salesChannels.length === 0) {
                return "No cached data found.";
            }

            const results: string[] = [];
            results.push(`Cached SalesChannels:`);
            results.push(``);

            for (const sc of salesChannels) {
                const metadata = cache.loadSalesChannelMetadata(sc);
                const blueprint = cache.loadHydratedBlueprint(sc);
                const hasCategories =
                    blueprint && blueprint.categories && blueprint.categories.length > 0;
                const categoryCount = blueprint?.categories?.length ?? 0;
                const productCount = blueprint?.products?.length ?? 0;
                const imageCount = cache.images.getImageCountForSalesChannel(sc);

                results.push(`  ${sc}`);
                if (metadata) {
                    results.push(`    Description: ${metadata.description || "-"}`);
                    results.push(`    Created: ${new Date(metadata.createdAt).toLocaleString()}`);
                    if (metadata.shopwareId) {
                        results.push(`    Shopware ID: ${metadata.shopwareId}`);
                    }
                }
                results.push(`    Categories: ${hasCategories ? categoryCount : "No"}`);
                results.push(`    Products: ${productCount}`);
                results.push(`    Images: ${imageCount}`);
                results.push(``);
            }

            results.push(`Total: ${salesChannels.length} SalesChannel(s)`);

            return results.join("\n");
        },
    });

    // cache_clear - Clear cache (move to trash)
    server.addTool({
        name: "cache_clear",
        description:
            "Move cached data to trash. Can clear all cache or a specific SalesChannel. Data can be restored with cache_restore.",
        parameters: z.object({
            salesChannel: z
                .string()
                .optional()
                .describe("Specific SalesChannel to clear. If omitted, clears all cache."),
        }),
        execute: async (args) => {
            const cache = createCacheFromEnv();

            if (args.salesChannel) {
                cache.clearSalesChannel(args.salesChannel);
                return `Moved cache for "${args.salesChannel}" to trash.

To restore: cache_restore(item: "sales-channel-${args.salesChannel}-...")
To list trash: cache_trash()`;
            } else {
                cache.clearAll();
                return `Moved all cached data to trash.

To restore: cache_restore(item: "...")
To list trash: cache_trash()`;
            }
        },
    });

    // cache_trash - List trash contents
    server.addTool({
        name: "cache_trash",
        description:
            "List contents of the trash folder. Items can be restored or permanently deleted.",
        parameters: z.object({}),
        execute: async () => {
            const cache = createCacheFromEnv();
            const trashItems = cache.listTrash();

            if (trashItems.length === 0) {
                return "Trash is empty.";
            }

            const results: string[] = [];
            results.push(`Trash contents:`);
            results.push(``);
            for (const item of trashItems) {
                results.push(`  ${item}`);
            }
            results.push(``);
            results.push(`Total: ${trashItems.length} item(s)`);
            results.push(`Location: ${cache.getTrashDir()}`);
            results.push(``);
            results.push(`To restore: cache_restore(item: "<item-name>")`);

            return results.join("\n");
        },
    });

    // cache_restore - Restore from trash
    server.addTool({
        name: "cache_restore",
        description: "Restore a specific item from trash back to the cache.",
        parameters: z.object({
            item: z.string().describe("Item name to restore (from cache_trash output)"),
        }),
        execute: async (args) => {
            const cache = createCacheFromEnv();

            // Determine target path based on item name
            let targetPath: string;
            if (args.item.startsWith("sales-channel-")) {
                // Extract sales channel name from trash item name
                // Format: sales-channel-{name}-{timestamp}
                const match = args.item.match(/^sales-channel-(.+?)-\d{4}-\d{2}-\d{2}T/);
                const scName = match
                    ? match[1]
                    : args.item.replace("sales-channel-", "").split("-")[0];
                targetPath = `generated/sales-channels/${scName}`;
            } else if (args.item.startsWith("all-cache-")) {
                targetPath = "generated";
            } else {
                targetPath = `generated/${args.item}`;
            }

            const success = cache.restoreFromTrash(args.item, targetPath);
            if (success) {
                return `Restored "${args.item}" to ${targetPath}`;
            } else {
                return `Error: Failed to restore "${args.item}". Check if it exists in trash with cache_trash().`;
            }
        },
    });

    // cache_empty_trash - Permanently delete trash
    server.addTool({
        name: "cache_empty_trash",
        description:
            "PERMANENTLY delete all items in trash. This cannot be undone! Use cache_trash() first to review contents.",
        parameters: z.object({
            confirm: z.boolean().describe("Must be true to confirm permanent deletion"),
        }),
        execute: async (args) => {
            if (!args.confirm) {
                return `Error: You must set confirm=true to permanently delete trash.

This action CANNOT be undone. Use cache_trash() first to review what will be deleted.`;
            }

            const cache = createCacheFromEnv();
            const trashItems = cache.listTrash();

            if (trashItems.length === 0) {
                return "Trash is already empty.";
            }

            cache.emptyTrash();

            return `Permanently deleted ${trashItems.length} item(s) from trash.`;
        },
    });
}
