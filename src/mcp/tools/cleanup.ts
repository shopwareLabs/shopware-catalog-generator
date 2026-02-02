/**
 * Cleanup Tools for MCP Server
 *
 * Exposes Shopware cleanup commands for removing generated data.
 */

import type { FastMCP } from "fastmcp";

import { z } from "zod";

import { DataCache } from "../../cache.js";
import { cleanupProcessors, registry } from "../../post-processors/index.js";
import { createApiHelpers, createShopwareAdminClient, DataHydrator } from "../../shopware/index.js";

export function registerCleanupTools(server: FastMCP): void {
    const processorNames = registry.getNames();

    // list_saleschannels - Show available SalesChannels
    server.addTool({
        name: "list_saleschannels",
        description: "List cached SalesChannels that can be cleaned up or processed.",
        parameters: z.object({}),
        execute: async () => {
            const results: string[] = [];
            const cache = new DataCache();

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
                    const imageCount = cache.getImageCountForSalesChannel(sc);

                    results.push(`  ${sc}`);
                    if (metadata?.shopwareId) {
                        results.push(`    Shopware ID: ${metadata.shopwareId}`);
                    }
                    results.push(`    Categories: ${categoryCount}, Products: ${productCount}, Images: ${imageCount}`);
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
                results.push("  generate(name: 'store-name', description: 'Your store description')");
            }

            return results.join("\n");
        },
    });

    // cleanup - Delete SalesChannel data from Shopware
    server.addTool({
        name: "cleanup",
        description:
            `Delete products, categories, and optionally the SalesChannel from Shopware. Available processors: ${processorNames.join(", ")}. Does NOT delete local cache.`,
        parameters: z.object({
            salesChannel: z.string().describe("SalesChannel name to clean up"),
            deleteSalesChannel: z
                .boolean()
                .default(false)
                .describe("Also delete the SalesChannel itself"),
            deleteProps: z
                .boolean()
                .default(false)
                .describe("Also delete property groups (use with caution)"),
            processors: z
                .array(z.enum(processorNames as [string, ...string[]]))
                .optional()
                .describe("Cleanup specific processor entities. If omitted with full=true, runs all."),
            full: z
                .boolean()
                .default(false)
                .describe("Full cleanup: all processors + core data + SalesChannel"),
            dryRun: z
                .boolean()
                .default(false)
                .describe("Preview what would be deleted without making changes"),
        }),
        execute: async (args) => {
            const swEnvUrl = process.env.SW_ENV_URL;
            if (!swEnvUrl) {
                return `Error: SW_ENV_URL is required in environment`;
            }

            const hydrator = new DataHydrator();
            try {
                await hydrator.authenticateWithClientCredentials(
                    swEnvUrl,
                    process.env.SW_CLIENT_ID,
                    process.env.SW_CLIENT_SECRET
                );
            } catch (error) {
                return `Error: Failed to authenticate with Shopware: ${error}`;
            }

            const results: string[] = [];
            results.push(`=== Shopware Cleanup ===`);
            results.push(`Environment: ${swEnvUrl}`);
            results.push(`SalesChannel: ${args.salesChannel}`);

            // Handle processor cleanup
            if ((args.processors && args.processors.length > 0) || args.full) {
                const processorList = args.full
                    ? registry.getNames()
                    : args.processors ?? [];

                results.push(`Processors: ${processorList.join(", ")}`);
                if (args.dryRun) {
                    results.push(`Mode: Dry run (no changes)`);
                }
                results.push(``);

                // Get SalesChannel ID
                const cache = new DataCache();
                const metadata = cache.loadSalesChannelMetadata(args.salesChannel);
                let salesChannelId = metadata?.shopwareId;

                if (!salesChannelId) {
                    const scFromShopware = await hydrator.getStandardSalesChannel(args.salesChannel);
                    if (!scFromShopware) {
                        return `Error: SalesChannel "${args.salesChannel}" not found in Shopware or cache.`;
                    }
                    salesChannelId = scFromShopware.id;
                }

                // Blueprint is optional for processor cleanup
                const blueprint = cache.loadHydratedBlueprint(args.salesChannel) ?? {
                    version: "1.0",
                    salesChannel: { name: args.salesChannel, description: "" },
                    categories: [],
                    products: [],
                    propertyGroups: [],
                    createdAt: new Date().toISOString(),
                    hydratedAt: new Date().toISOString(),
                };

                // Create API helpers
                const adminClient = createShopwareAdminClient({
                    baseURL: swEnvUrl,
                    clientId: process.env.SW_CLIENT_ID,
                    clientSecret: process.env.SW_CLIENT_SECRET,
                });
                const apiHelpers = createApiHelpers(
                    adminClient,
                    swEnvUrl,
                    () => hydrator.getAccessToken()
                );

                const context = {
                    salesChannelId,
                    salesChannelName: args.salesChannel,
                    blueprint,
                    cache,
                    shopwareUrl: swEnvUrl,
                    getAccessToken: async () => hydrator.getAccessToken(),
                    api: apiHelpers,
                    options: {
                        batchSize: 5,
                        dryRun: args.dryRun,
                    },
                };

                const processorResults = await cleanupProcessors(context, processorList);

                let totalDeleted = 0;
                let totalErrors = 0;
                for (const result of processorResults) {
                    results.push(`${result.name}: ${result.deleted} deleted, ${result.errors.length} errors`);
                    totalDeleted += result.deleted;
                    totalErrors += result.errors.length;
                }
                results.push(``);
                results.push(`Processor cleanup: ${totalDeleted} deleted, ${totalErrors} errors`);
            }

            // Handle core cleanup (if not just processors or if --full)
            if (!args.processors || args.full) {
                if (args.dryRun) {
                    results.push(``);
                    results.push(`[DRY RUN] Would delete:`);
                    results.push(`  - Products in SalesChannel`);
                    results.push(`  - Categories in SalesChannel`);
                    if (args.deleteProps) {
                        results.push(`  - Property groups`);
                    }
                    if (args.deleteSalesChannel || args.full) {
                        results.push(`  - SalesChannel itself`);
                    }
                } else {
                    const result = await hydrator.cleanupSalesChannel(args.salesChannel, {
                        deletePropertyGroups: args.deleteProps,
                        deleteSalesChannel: args.deleteSalesChannel || args.full,
                        deleteManufacturers: false,
                    });

                    results.push(``);
                    results.push(`Core cleanup:`);
                    results.push(`  Products deleted: ${result.products}`);
                    results.push(`  Categories deleted: ${result.categories}`);
                    if (args.deleteProps) {
                        results.push(`  Property groups deleted: ${result.propertyGroups}`);
                    }
                    if (args.deleteSalesChannel || args.full) {
                        results.push(`  SalesChannel deleted: ${result.salesChannelDeleted ? "Yes" : "No"}`);
                    }
                }
            }

            results.push(``);
            results.push(`Note: Local cache preserved. To also clear cached data:`);
            results.push(`  cache_clear(salesChannel: "${args.salesChannel}")`);

            return results.join("\n");
        },
    });

    // cleanup_media - Delete orphaned product media
    server.addTool({
        name: "cleanup_media",
        description:
            "Delete orphaned product media from Shopware (media not linked to any product). Global operation across all SalesChannels.",
        parameters: z.object({
            dryRun: z
                .boolean()
                .default(false)
                .describe("Preview what would be deleted without making changes"),
        }),
        execute: async (args) => {
            const swEnvUrl = process.env.SW_ENV_URL;
            if (!swEnvUrl) {
                return `Error: SW_ENV_URL is required in environment`;
            }

            const hydrator = new DataHydrator();
            try {
                await hydrator.authenticateWithClientCredentials(
                    swEnvUrl,
                    process.env.SW_CLIENT_ID,
                    process.env.SW_CLIENT_SECRET
                );
            } catch (error) {
                return `Error: Failed to authenticate with Shopware: ${error}`;
            }

            const results: string[] = [];
            results.push(`=== Orphaned Media Cleanup ===`);
            results.push(`Environment: ${swEnvUrl}`);
            if (args.dryRun) {
                results.push(`Mode: Dry run (no changes)`);
            }
            results.push(``);

            const count = await hydrator.deleteOrphanedProductMedia(args.dryRun);

            if (args.dryRun) {
                results.push(`Would delete ${count} orphaned media items`);
            } else {
                results.push(`Deleted ${count} orphaned media items`);
            }

            return results.join("\n");
        },
    });

    // cleanup_unused_props - Delete unused property groups
    server.addTool({
        name: "cleanup_unused_props",
        description:
            "Delete property groups where no options are used by any products. Global operation across all SalesChannels.",
        parameters: z.object({
            dryRun: z
                .boolean()
                .default(false)
                .describe("Preview what would be deleted without making changes"),
        }),
        execute: async (args) => {
            const swEnvUrl = process.env.SW_ENV_URL;
            if (!swEnvUrl) {
                return `Error: SW_ENV_URL is required in environment`;
            }

            const hydrator = new DataHydrator();
            try {
                await hydrator.authenticateWithClientCredentials(
                    swEnvUrl,
                    process.env.SW_CLIENT_ID,
                    process.env.SW_CLIENT_SECRET
                );
            } catch (error) {
                return `Error: Failed to authenticate with Shopware: ${error}`;
            }

            const results: string[] = [];
            results.push(`=== Unused Property Groups Cleanup ===`);
            results.push(`Environment: ${swEnvUrl}`);
            if (args.dryRun) {
                results.push(`Mode: Dry run (no changes)`);
            }
            results.push(``);

            const count = await hydrator.deleteUnusedPropertyGroups(args.dryRun);

            if (args.dryRun) {
                results.push(`Would delete ${count} unused property groups`);
            } else {
                results.push(`Deleted ${count} unused property groups`);
            }

            return results.join("\n");
        },
    });
}
