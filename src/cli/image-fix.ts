/**
 * Image fix CLI command: regenerate images for products, categories, CMS pages, or theme media.
 *
 * Thin wrapper around the shared command spec (src/services/commands.ts).
 */

import type { CliCommandOptions } from "./command.js";
import type { CliArgs } from "./shared.js";

import { IMAGE_FIX } from "../services/commands.js";
import { runCliCommand } from "./command.js";

export function imageFixCommand(
    args: CliArgs,
    services?: CliCommandOptions["services"]
): Promise<void> {
    return runCliCommand(IMAGE_FIX, args, { errorCode: "IMAGE_FIX_FAILED", services });
}
