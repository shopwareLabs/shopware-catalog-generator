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
 *   bun run cache:restore -- --all           - Restore every item from trash
 *   bun run cache:empty-trash -- --confirm   - Permanently delete trash
 *
 * Every command runs the same spec as its MCP tool (src/services/commands.ts).
 */

import type { CommandServices } from "./services/commands.js";

import { runCliParams } from "./cli/command.js";
import { CLIError } from "./cli/shared.js";
import {
    CACHE_CLEAR,
    CACHE_EMPTY_TRASH,
    CACHE_LIST,
    CACHE_RESTORE,
    CACHE_TRASH,
} from "./services/commands.js";

const USAGE = `
Cache Management CLI - Manages local cached files

This command manages local cached data (products, images, categories) stored
in CACHE_DIR (default: generated/). It does NOT affect your Shopware instance.

To also clean Shopware data, use: bun run cleanup -- --salesChannel=<name>

Usage:
  bun run cache:list                       List all cached SalesChannels with stats
  bun run cache:clear                      Move all cached data to trash
  bun run cache:clear -- [salesChannel]    Move specific SalesChannel cache to trash
  bun run cache:trash                      List trash contents (recoverable data)
  bun run cache:restore -- <item>          Restore specific item from trash
  bun run cache:restore -- --all           Restore all items from trash
  bun run cache:empty-trash -- --confirm   Permanently delete all trash (IRREVERSIBLE)

Examples:
  bun run cache:list
  bun run cache:clear
  bun run cache:clear -- furniture
  bun run cache:trash
  bun run cache:restore -- sales-channel-furniture-2024-01-15T10-30-00-000Z
  bun run cache:empty-trash -- --confirm
`;

const positional = (args: string[]): string | undefined => args.find((a) => !a.startsWith("--"));

/** Run a cache command from argv (without node and script path) */
export async function runCacheCli(
    argv: string[],
    services?: Partial<CommandServices>
): Promise<void> {
    const [command, ...rest] = argv;
    const options = { errorCode: "CACHE_ERROR", services };

    switch (command) {
        case "list":
            return runCliParams(CACHE_LIST, {}, options);
        case "clear":
            return runCliParams(CACHE_CLEAR, { salesChannel: positional(rest) }, options);
        case "trash":
            return runCliParams(CACHE_TRASH, {}, options);
        case "restore":
            return runCliParams(
                CACHE_RESTORE,
                { item: positional(rest), all: rest.includes("--all") },
                options
            );
        case "empty-trash":
            return runCliParams(
                CACHE_EMPTY_TRASH,
                { confirm: rest.includes("--confirm") },
                options
            );
        default:
            console.log(USAGE);
    }
}

if (import.meta.main) {
    runCacheCli(process.argv.slice(2)).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(error instanceof CLIError ? error.exitCode : 1);
    });
}
