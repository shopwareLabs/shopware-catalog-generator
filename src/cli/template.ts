/**
 * Template CLI commands: write template.json for the templates repo.
 *
 * Thin wrapper around the shared command spec (src/services/commands.ts).
 */

import type { CliCommandOptions } from "./command.js";
import type { CliArgs } from "./shared.js";

import { TEMPLATE_METADATA } from "../services/commands.js";
import { runCliCommand } from "./command.js";

export function templateMetadataCommand(
    args: CliArgs,
    services?: CliCommandOptions["services"]
): Promise<void> {
    return runCliCommand(TEMPLATE_METADATA, args, {
        errorCode: "TEMPLATE_METADATA_FAILED",
        services,
    });
}
