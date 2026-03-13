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
    unusedProps: boolean;
    unusedOptions: boolean;
    processors: string[];
    full: boolean;
    dryRun: boolean;
    help: boolean;
}

function parseArgs(): CleanupArgs {
    const args = process.argv.slice(2);
    let salesChannel: string | undefined;
    let deleteSalesChannel = false;
    let deleteProps = false;
    let deleteManufacturers = false;
    let orphanedMedia = false;
    let unusedProps = false;
    let unusedOptions = false;
    let processors: string[] = [];
    let full = false;
    let dryRun = false;
    let help = false;

    for (const arg of args) {
        if (arg === "--dry-run") {
            dryRun = true;
        } else if (arg.startsWith("--salesChannel=")) {
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
        } else if (arg === "--unused-props" || arg === "--unused-properties") {
            unusedProps = true;
        } else if (arg === "--unused-options") {
            unusedOptions = true;
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
        unusedProps,
        unusedOptions,
        processors,
        full,
        dryRun,
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

Global Cleanup (no SalesChannel required):
  bun run cleanup -- --unused-props                          Delete property groups with no used options
  bun run cleanup -- --unused-options                        Delete individual unused property options
  bun run cleanup -- --orphaned-media                        Delete media not linked to any product

Options:
  --salesChannel=<name>   SalesChannel to clean up (required for most operations)
  --delete                Also delete the SalesChannel itself
  --props                 Also delete all property groups (use with caution)
  --processors=<list>     Cleanup entities from specific processors (comma-separated)
  --processors=all        Cleanup entities from ALL processors
  --full                  Full cleanup: run all processor cleanups, then core cleanup
  --orphaned-media        Delete media where the linked product no longer exists
  --unused-props          Delete property groups where no options are used by products
  --unused-options        Delete individual property options not used by any product
  --dry-run               Preview what would be deleted without making changes
  --help, -h              Show this help message

Note: Reviews are cascade-deleted by Shopware when products are deleted.
      Use --processors=reviews with --salesChannel to delete reviews for a specific store.

Available Processors: ${availableProcessors}

Examples:
  bun run cleanup -- --salesChannel="furniture"
  bun run cleanup -- --salesChannel="electronics" --delete
  bun run cleanup -- --salesChannel="soft-drinks" --delete --props
  bun run cleanup -- --salesChannel="music" --processors=cms
  bun run cleanup -- --salesChannel="music" --processors=reviews  # Delete reviews for this store
  bun run cleanup -- --salesChannel="music" --processors=all
  bun run cleanup -- --salesChannel="music" --full --delete
  bun run cleanup:media

  # Global cleanup (removes unused entities across ALL SalesChannels)
  bun run cleanup -- --unused-props                    # Clean up unused property groups
  bun run cleanup -- --unused-options                  # Clean up unused property options only
  bun run cleanup -- --unused-props --dry-run          # Preview without deleting
`);
}

async function main(): Promise<void> {
    const {
        salesChannel,
        deleteSalesChannel,
        deleteProps,
        deleteManufacturers,
        orphanedMedia,
        unusedProps,
        unusedOptions,
        processors,
        full,
        dryRun,
        help,
    } = parseArgs();

    // Show help
    if (help) {
        printUsage();
        process.exit(0);
    }

    // Check if any global cleanup operation is requested
    const hasGlobalCleanup = orphanedMedia || unusedProps || unusedOptions;

    // Validate arguments
    if (!salesChannel && !hasGlobalCleanup) {
        printUsage();
        process.exit(0);
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

    // Handle global cleanup operations (no SalesChannel required)
    if (hasGlobalCleanup) {
        if (dryRun) {
            console.log(`\n[DRY RUN] Preview mode - no changes will be made\n`);
        }

        let totalDeleted = 0;

        if (unusedProps) {
            console.log(`\n--- Unused Property Groups ---`);
            const count = await hydrator.deleteUnusedPropertyGroups(dryRun);
            totalDeleted += count;
        }

        if (unusedOptions) {
            console.log(`\n--- Unused Property Options ---`);
            const count = await hydrator.deleteUnusedPropertyOptions(dryRun);
            totalDeleted += count;
        }

        if (orphanedMedia) {
            console.log(`\n--- Orphaned Product Media ---`);
            const count = await hydrator.deleteOrphanedProductMedia(dryRun);
            totalDeleted += count;
        }

        console.log(`\n=== Global Cleanup Complete ===`);
        if (dryRun) {
            console.log(`Total entities that would be deleted: ${totalDeleted}`);
        } else {
            console.log(`Total entities deleted: ${totalDeleted}`);
        }
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
            api: apiHelpers,
            options: {
                batchSize: 5,
                dryRun,
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
            if (result.errors.length > 0) {
                console.error(`\nErrors during cleanup:`);
                for (const err of result.errors) {
                    console.error(`  - ${err}`);
                }
            }
        }
    } else if (salesChannel) {
        // SalesChannel cleanup
        console.log(`SalesChannel: ${salesChannel}`);
        console.log(`Delete SalesChannel: ${deleteSalesChannel ? "Yes" : "No"}`);
        console.log(`Delete property groups: ${deleteProps ? "Yes" : "No"}\n`);

        const cleanableProcessors = registry
            .getAll()
            .filter((processor) => typeof processor.cleanup === "function")
            .map((processor) => processor.name);
        if (cleanableProcessors.length > 0) {
            console.log(`Note: Processor cleanup is not included in this mode.`);
            console.log(`      Run one of these if you want processor entities removed too:`);
            console.log(
                `      - bun run cleanup -- --salesChannel="${salesChannel}" --processors=all`
            );
            console.log(`      - bun run cleanup -- --salesChannel="${salesChannel}" --full`);
            console.log(`      Cleanable processors: ${cleanableProcessors.join(", ")}\n`);
        }

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
        if (result.errors.length > 0) {
            console.error(`\nErrors during cleanup:`);
            for (const err of result.errors) {
                console.error(`  - ${err}`);
            }
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
