/**
 * Template CLI commands: write template.json for the templates repo.
 *
 * Thin wrapper that delegates to src/services/template-service.ts and prints output.
 */

import type { CliArgs } from "./shared.js";

import { writeTemplateMetadata } from "../services/template-service.js";
import { requireValidName, throwIfServiceError } from "./shared.js";

export function templateMetadataCommand(args: CliArgs): void {
    const salesChannelName = requireValidName(args);
    const lines = writeTemplateMetadata(salesChannelName, { e2eDir: args.e2e });

    throwIfServiceError(lines, "TEMPLATE_METADATA_FAILED");

    for (const line of lines) {
        console.log(line);
    }
}
