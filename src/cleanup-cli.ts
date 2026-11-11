#!/usr/bin/env node
/**
 * Cleanup CLI for removing generated data from Shopware
 *
 * Usage:
 *   bun run cleanup -- --salesChannel="furniture"           - Delete products and categories
 *   bun run cleanup -- --salesChannel="furniture" --delete  - Also delete the SalesChannel itself
 *   bun run cleanup -- --salesChannel="furniture" --props   - Also delete property groups
 *   bun run cleanup -- --salesChannel="music" --processors=customers  - Cleanup specific processor entities
 *   bun run cleanup:media                                   - Delete unused product media
 *
 * Every mode runs the same spec as its MCP tool (src/services/commands.ts).
 */

import type { CommandServices } from "./services/commands.js";

import { cliFlagName, runCliParams } from "./cli/command.js";
import { CLIError } from "./cli/shared.js";
import { registry } from "./post-processors/index.js";
import {
    CLEANUP,
    CLEANUP_MEDIA,
    CLEANUP_UNUSED_OPTIONS,
    CLEANUP_UNUSED_PROPS,
} from "./services/commands.js";

export interface CleanupCliArgs {
    salesChannel?: string;
    deleteSalesChannel: boolean;
    deleteProps: boolean;
    orphanedMedia: boolean;
    unusedProps: boolean;
    unusedOptions: boolean;
    processors: string[];
    full: boolean;
    dryRun: boolean;
    help: boolean;
}

const FLAG_ALIASES: Record<string, keyof CleanupCliArgs> = {
    "--dry-run": "dryRun",
    "--delete": "deleteSalesChannel",
    "--delete-salesChannel": "deleteSalesChannel",
    "--props": "deleteProps",
    "--delete-props": "deleteProps",
    "--orphaned-media": "orphanedMedia",
    "--media": "orphanedMedia",
    "--unused-props": "unusedProps",
    "--unused-properties": "unusedProps",
    "--unused-options": "unusedOptions",
    "--full": "full",
    "--help": "help",
    "-h": "help",
};

const splitList = (value: string): string[] =>
    value
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);

/** Parse cleanup flags (argv without node and script path) */
export function parseCleanupArgs(argv: string[]): CleanupCliArgs {
    const args: CleanupCliArgs = {
        deleteSalesChannel: false,
        deleteProps: false,
        orphanedMedia: false,
        unusedProps: false,
        unusedOptions: false,
        processors: [],
        full: false,
        dryRun: false,
        help: false,
    };
    for (const arg of argv) {
        const [flag = "", value] = arg.split(/=(.*)/s, 2);
        const boolean = FLAG_ALIASES[flag];
        if (boolean) {
            Object.assign(args, { [boolean]: true });
        } else if (flag === "--salesChannel" && value !== undefined) {
            args.salesChannel = value.replace(/^["']|["']$/g, "");
        } else if ((flag === "--processors" || flag === "--only") && value !== undefined) {
            args.processors.push(...splitList(value));
        } else if (flag === "--manufacturers" || flag === "--delete-manufacturers") {
            // Manufacturers are SalesChannel-scoped entities of the manufacturers processor
            args.processors.push("manufacturers");
        }
    }
    return args;
}

/** processors is --processors here (main.ts uses --only) */
const formatCleanupParam = (param: string): string =>
    param === "processors" ? "--processors" : cliFlagName(param);

/** Run the cleanup CLI (argv without node and script path) */
export async function runCleanupCli(
    argv: string[],
    services?: Partial<CommandServices>
): Promise<void> {
    const args = parseCleanupArgs(argv);
    const options = { errorCode: "CLEANUP_ERROR", services, formatParam: formatCleanupParam };
    const dryRun = { dryRun: args.dryRun };

    const globalSpecs = [
        args.unusedProps && CLEANUP_UNUSED_PROPS,
        args.unusedOptions && CLEANUP_UNUSED_OPTIONS,
        args.orphanedMedia && CLEANUP_MEDIA,
    ].filter((spec) => spec !== false);

    if (args.help || (!args.salesChannel && globalSpecs.length === 0)) {
        printUsage();
        return;
    }

    // Global cleanups need no SalesChannel and run before a SalesChannel cleanup
    for (const spec of globalSpecs) {
        await runCliParams(spec, dryRun, options);
    }
    if (!args.salesChannel) return;

    await runCliParams(
        CLEANUP,
        {
            salesChannel: args.salesChannel,
            deleteSalesChannel: args.deleteSalesChannel,
            deleteProps: args.deleteProps,
            processors: [...new Set(args.processors)],
            full: args.full,
            ...dryRun,
        },
        options
    );
}

function printUsage(): void {
    console.log(`
Shopware Cleanup CLI - Removes data from Shopware instance

This command removes products, categories, and optionally the SalesChannel
from your Shopware instance. Local cached files are NOT deleted.

To also clear local cache, use: bun run cache:clear -- <salesChannel>

Usage:
  bun run cleanup -- --salesChannel="name"                   Delete products and categories
  bun run cleanup -- --salesChannel="name" --delete          Also delete the SalesChannel itself
  bun run cleanup -- --salesChannel="name" --props           Also delete property groups
  bun run cleanup -- --salesChannel="name" --manufacturers   Delete the store's manufacturers (processor)
  bun run cleanup -- --salesChannel="name" --processors=customers  Cleanup specific processor entities
  bun run cleanup -- --salesChannel="name" --processors=all  Cleanup ALL processor entities
  bun run cleanup -- --salesChannel="name" --full            Complete cleanup (processors + core)
  bun run cleanup -- --salesChannel="name" --full --delete   ... and delete the SalesChannel
  bun run cleanup:media                                      Delete orphaned product media

Global Cleanup (no SalesChannel required):
  bun run cleanup -- --unused-props                          Delete property groups with no used options
  bun run cleanup -- --unused-options                        Delete individual unused property options
  bun run cleanup -- --orphaned-media                        Delete media not linked to any product

Options:
  --salesChannel=<name>   SalesChannel to clean up (required for most operations)
  --delete                Also delete the SalesChannel itself
  --props                 Also delete all property groups (use with caution)
  --manufacturers         Same as adding "manufacturers" to --processors
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

Available Processors: ${registry.getNames().join(", ")}
`);
}

if (import.meta.main) {
    runCleanupCli(process.argv.slice(2)).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(error instanceof CLIError ? error.exitCode : 1);
    });
}
