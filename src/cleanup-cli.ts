#!/usr/bin/env node
/**
 * Cleanup CLI for removing generated data from Shopware
 *
 * Usage:
 *   bun run cleanup -- --salesChannel="furniture"           - Delete products and categories
 *   bun run cleanup -- --salesChannel="furniture" --delete  - Also delete the SalesChannel itself
 *   bun run cleanup -- --salesChannel="furniture" --props   - Also delete property groups
 *   bun run cleanup -- --salesChannel="music" --processors=cms  - Cleanup specific processor entities
 *   bun run cleanup:media                                   - Delete unused product media
 */

import fs from "node:fs";
import path from "node:path";

import { DataCache } from "./cache.js";
import { cleanupProcessors, registry } from "./post-processors/index.js";
import { createApiHelpers, createShopwareAdminClient, DataHydrator } from "./shopware/index.js";

interface CleanupArgs {
    salesChannel?: string;
    deleteSalesChannel: boolean;
    deleteProps: boolean;
    deleteManufacturers: boolean;
    orphanedMedia: boolean;
    processors: string[];
    full: boolean;
    help: boolean;
}

function parseArgs(): CleanupArgs {
    const args = process.argv.slice(2);
    let salesChannel: string | undefined;
    let deleteSalesChannel = false;
    let deleteProps = false;
    let deleteManufacturers = false;
    let orphanedMedia = false;
    let processors: string[] = [];
    let full = false;
    let help = false;

    for (const arg of args) {
        if (arg.startsWith("--salesChannel=")) {
            const value = arg.substring("--salesChannel=".length);
            salesChannel = value.replace(/^["']|["']$/g, "");
        } else if (arg === "--delete" || arg === "--delete-salesChannel") {
            deleteSalesChannel = true;
        } else if (arg === "--props" || arg === "--delete-props") {
            deleteProps = true;
        } else if (arg === "--manufacturers" || arg === "--delete-manufacturers") {
            deleteManufacturers = true;
        } else if (arg === "--orphaned-media" || arg === "--media") {
            orphanedMedia = true;
        } else if (arg.startsWith("--processors=") || arg.startsWith("--only=")) {
            const value = arg.includes("--processors=")
                ? arg.substring("--processors=".length)
                : arg.substring("--only=".length);
            processors = value
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean);
        } else if (arg === "--full") {
            full = true;
        } else if (arg === "--help" || arg === "-h") {
            help = true;
        }
    }

    return {
        salesChannel,
        deleteSalesChannel,
        deleteProps,
        deleteManufacturers,
        orphanedMedia,
        processors,
        full,
        help,
    };
}

function printUsage(): void {
    const availableProcessors = registry.getNames().join(", ");

    console.log(`
Shopware Cleanup CLI - Removes data from Shopware instance

This command removes products, categories, and optionally the SalesChannel
from your Shopware instance. Local cached files are NOT deleted.

To also clear local cache, use: bun run cache:clear -- <salesChannel>

Usage:
  bun run cleanup -- --salesChannel="name"                   Delete products and categories
  bun run cleanup -- --salesChannel="name" --delete          Also delete the SalesChannel itself
  bun run cleanup -- --salesChannel="name" --props           Also delete property groups
  bun run cleanup -- --salesChannel="name" --processors=cms  Cleanup specific processor entities
  bun run cleanup -- --salesChannel="name" --processors=all  Cleanup ALL processor entities
  bun run cleanup -- --salesChannel="name" --full            Complete cleanup (processors + core + SC)
  bun run cleanup:media                                      Delete orphaned product media

Options:
  --salesChannel=<name>   SalesChannel to clean up (required)
  --delete                Also delete the SalesChannel itself
  --props                 Also delete all property groups (use with caution)
  --processors=<list>     Cleanup entities from specific processors (comma-separated)
  --processors=all        Cleanup entities from ALL processors
  --full                  Full cleanup: run all processor cleanups, then core cleanup
  --orphaned-media        Delete media where the linked product no longer exists
  --help, -h              Show this help message

Available Processors: ${availableProcessors}

Examples:
  bun run cleanup -- --salesChannel="furniture"
  bun run cleanup -- --salesChannel="electronics" --delete
  bun run cleanup -- --salesChannel="soft-drinks" --delete --props
  bun run cleanup -- --salesChannel="music" --processors=cms
  bun run cleanup -- --salesChannel="music" --processors=all
  bun run cleanup -- --salesChannel="music" --full --delete
  bun run cleanup:media
`);
}

async function main(): Promise<void> {
    const {
        salesChannel,
        deleteSalesChannel,
        deleteProps,
        deleteManufacturers,
        orphanedMedia,
        processors,
        full,
        help,
    } = parseArgs();

    // Show help
    if (help) {
        printUsage();
        process.exit(0);
    }

    // Validate arguments
    if (!salesChannel && !orphanedMedia) {
        printUsage();
        process.exit(1);
    }

    // Get Shopware credentials from environment
    const swEnvUrl = process.env.SW_ENV_URL;
    const clientId = process.env.SW_CLIENT_ID;
    const clientSecret = process.env.SW_CLIENT_SECRET;

    if (!swEnvUrl) {
        console.error("Error: SW_ENV_URL is required in .env file");
        process.exit(1);
    }

    const hydrator = new DataHydrator();

    try {
        await hydrator.authenticateWithClientCredentials(swEnvUrl, clientId, clientSecret);
    } catch (error) {
        console.error("Error: Failed to authenticate with Shopware:", error);
        process.exit(1);
    }

    console.log(`\n=== Shopware Cleanup ===\n`);
    console.log(`Environment: ${swEnvUrl}`);

    if (orphanedMedia) {
        // Delete orphaned product media
        console.log(`\nSearching for orphaned product media...`);
        const count = await hydrator.deleteOrphanedProductMedia();
        console.log(`\nCleanup complete: ${count} orphaned media files deleted.`);
    } else if (salesChannel && (processors.length > 0 || full)) {
        // Expand "all" to all processor names
        let processorList = processors;
        if (processors.includes("all") || full) {
            processorList = registry.getNames();
        }

        // Processor-specific cleanup (or full cleanup first phase)
        console.log(`SalesChannel: ${salesChannel}`);
        if (full) {
            console.log(`Mode: Full cleanup (processors + core)`);
        }
        console.log(`Processors: ${processorList.join(", ")}\n`);

        // We need to create a context for the processor cleanup
        const cache = new DataCache();
        const metadata = cache.loadSalesChannelMetadata(salesChannel);

        // Try to get SalesChannel ID from cache, otherwise lookup from Shopware
        let salesChannelId = metadata?.shopwareId;
        if (!salesChannelId) {
            console.log(
                `Note: SalesChannel "${salesChannel}" not in cache, looking up from Shopware...`
            );
            const scFromShopware = await hydrator.getStandardSalesChannel(salesChannel);
            if (!scFromShopware) {
                console.error(
                    `Error: SalesChannel "${salesChannel}" not found in Shopware or cache.`
                );
                process.exit(1);
            }
            salesChannelId = scFromShopware.id;
            console.log(`Found SalesChannel in Shopware: ${salesChannelId}\n`);
        }

        // Blueprint is optional for processor cleanup - use empty if not found
        const blueprint = cache.loadHydratedBlueprint(salesChannel) ?? {
            version: "1.0",
            salesChannel: { name: salesChannel, description: "" },
            categories: [],
            products: [],
            propertyGroups: [],
            createdAt: new Date().toISOString(),
            hydratedAt: new Date().toISOString(),
        };

        // Create API helpers using official client
        const adminClient = createShopwareAdminClient({
            baseURL: swEnvUrl,
            clientId: process.env.SW_CLIENT_ID,
            clientSecret: process.env.SW_CLIENT_SECRET,
        });
        const apiHelpers = createApiHelpers(adminClient, swEnvUrl, () => hydrator.getAccessToken());

        // Build processor context
        const context = {
            salesChannelId,
            salesChannelName: salesChannel,
            blueprint,
            cache,
            shopwareUrl: swEnvUrl,
            getAccessToken: async () => hydrator.getAccessToken(),
            api: apiHelpers,
            options: {
                batchSize: 5,
                dryRun: false,
            },
        };

        const results = await cleanupProcessors(context, processorList);

        console.log(`\n=== Processor Cleanup Complete ===`);
        let totalDeleted = 0;
        let totalErrors = 0;
        for (const result of results) {
            totalDeleted += result.deleted;
            totalErrors += result.errors.length;
        }
        console.log(`Total deleted: ${totalDeleted}`);
        if (totalErrors > 0) {
            console.log(`Errors: ${totalErrors}`);
        }

        // If --full, also run core cleanup
        if (full) {
            console.log(`\n=== Core Cleanup ===`);
            console.log(`Delete SalesChannel: ${deleteSalesChannel ? "Yes" : "No"}`);
            console.log(`Delete property groups: ${deleteProps ? "Yes" : "No"}\n`);

            const result = await hydrator.cleanupSalesChannel(salesChannel, {
                deletePropertyGroups: deleteProps,
                deleteSalesChannel: deleteSalesChannel,
                deleteManufacturers: false, // Handled by manufacturer processor
            });

            console.log(`\n=== Core Cleanup Complete ===`);
            console.log(`Products deleted: ${result.products}`);
            console.log(`Categories deleted: ${result.categories}`);
            if (deleteProps) {
                console.log(`Property groups deleted: ${result.propertyGroups}`);
            }
            if (deleteSalesChannel) {
                console.log(`SalesChannel deleted: ${result.salesChannelDeleted ? "Yes" : "No"}`);
                console.log(`Root category deleted: ${result.rootCategoryDeleted ? "Yes" : "No"}`);
            }
        }
    } else if (salesChannel) {
        // SalesChannel cleanup
        console.log(`SalesChannel: ${salesChannel}`);
        console.log(`Delete SalesChannel: ${deleteSalesChannel ? "Yes" : "No"}`);
        console.log(`Delete property groups: ${deleteProps ? "Yes" : "No"}\n`);

        if (deleteManufacturers) {
            console.log(
                `Note: Use --processors=manufacturers for SalesChannel-scoped manufacturer cleanup.\n`
            );
        }

        const result = await hydrator.cleanupSalesChannel(salesChannel, {
            deletePropertyGroups: deleteProps,
            deleteSalesChannel: deleteSalesChannel,
            deleteManufacturers: false, // Now handled by processor
        });

        console.log(`\n=== Cleanup Complete ===`);
        console.log(`Products deleted: ${result.products}`);
        console.log(`Categories deleted: ${result.categories}`);
        if (deleteProps) {
            console.log(`Property groups deleted: ${result.propertyGroups}`);
        }
        if (deleteSalesChannel) {
            console.log(`SalesChannel deleted: ${result.salesChannelDeleted ? "Yes" : "No"}`);
            console.log(`Root category deleted: ${result.rootCategoryDeleted ? "Yes" : "No"}`);
        }

        // Hint about cache (only if cache folder exists)
        const cacheDir = path.join(
            process.cwd(),
            "generated",
            "sales-channels",
            salesChannel.toLowerCase().replace(/\s+/g, "-")
        );
        if (fs.existsSync(cacheDir)) {
            console.log(`\nNote: Local cache preserved. To also clear cached data:`);
            console.log(`  bun run cache:clear -- ${salesChannel}`);
        }
    }

    console.log();
}

main().catch((error) => {
    console.error("Error: Cleanup failed:", error);
    process.exit(1);
});
