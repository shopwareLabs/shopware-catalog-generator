/**
 * Cleanup Tools for MCP Server
 *
 * cleanup* tools come from the shared command specs (src/services/commands.ts), so the
 * cleanup CLI behaves the same. list_saleschannels is MCP-only.
 */

import type { FastMCP } from "fastmcp";

import { z } from "zod";

import { createCacheFromEnv } from "../../cache.js";
import {
    CLEANUP,
    CLEANUP_MEDIA,
    CLEANUP_UNUSED_OPTIONS,
    CLEANUP_UNUSED_PROPS,
} from "../../services/commands.js";
import { registerCommandTool } from "./command-tool.js";

export function registerCleanupTools(server: FastMCP): void {
    // list_saleschannels - Show available SalesChannels
    server.addTool({
        name: "list_saleschannels",
        description: "List cached SalesChannels that can be cleaned up or processed.",
        parameters: z.object({}),
        execute: async () => {
            const results: string[] = [];
            const cache = createCacheFromEnv();

            // Show cached SalesChannels
            const cachedChannels = cache.listSalesChannels();
            if (cachedChannels.length > 0) {
                results.push("Available SalesChannels:");
                results.push("");
                for (const sc of cachedChannels) {
                    const blueprint = cache.loadHydratedBlueprint(sc);
                    const metadata = cache.loadSalesChannelMetadata(sc);
                    const productCount = blueprint?.products?.length ?? 0;
                    const categoryCount = blueprint?.categories?.length ?? 0;
                    const imageCount = cache.images.getImageCountForSalesChannel(sc);

                    results.push(`  ${sc}`);
                    if (metadata?.shopwareId) {
                        results.push(`    Shopware ID: ${metadata.shopwareId}`);
                    }
                    results.push(
                        `    Categories: ${categoryCount}, Products: ${productCount}, Images: ${imageCount}`
                    );
                    results.push("");
                }

                results.push("Usage:");
                results.push("  cleanup(salesChannel: 'name')  - Delete products and categories");
                results.push("  cleanup(salesChannel: 'name', full: true)  - Full cleanup");
                results.push("  process(name: 'name', processors: ['images'])  - Run processors");
            } else {
                results.push("No SalesChannels found in cache.");
                results.push("");
                results.push("Generate one with:");
                results.push(
                    "  generate(name: 'store-name', description: 'Your store description')"
                );
            }

            return results.join("\n");
        },
    });

    registerCommandTool(server, CLEANUP);
    registerCommandTool(server, CLEANUP_MEDIA);
    registerCommandTool(server, CLEANUP_UNUSED_PROPS);
    registerCommandTool(server, CLEANUP_UNUSED_OPTIONS);
}
