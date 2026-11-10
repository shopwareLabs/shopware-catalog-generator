/**
 * Blueprint CLI commands: create, estimate, hydrate, translate, fix, inspire.
 *
 * Thin wrappers around the shared command specs (src/services/commands.ts), which the MCP
 * tools use as well.
 */

import type { CliCommandOptions } from "./command.js";
import type { CliArgs } from "./shared.js";

import { resolveCmsStoreDescription } from "../services/blueprint-service.js";
import {
    BLUEPRINT_CREATE,
    BLUEPRINT_ESTIMATE,
    BLUEPRINT_FIX,
    BLUEPRINT_HYDRATE,
    BLUEPRINT_INSPIRE,
    BLUEPRINT_TRANSLATE,
} from "../services/commands.js";
import { runCliCommand } from "./command.js";

// Re-export for backwards compatibility with tests
export { resolveCmsStoreDescription };

type Services = CliCommandOptions["services"];

export function blueprintCreate(args: CliArgs, services?: Services): Promise<void> {
    return runCliCommand(BLUEPRINT_CREATE, args, { errorCode: "INVALID_OPTION", services });
}

export function blueprintEstimate(args: CliArgs, services?: Services): Promise<void> {
    return runCliCommand(BLUEPRINT_ESTIMATE, args, { errorCode: "ESTIMATE_FAILED", services });
}

export function blueprintTranslate(args: CliArgs, services?: Services): Promise<void> {
    return runCliCommand(BLUEPRINT_TRANSLATE, args, {
        errorCode: "TRANSLATE_FAILED",
        printLogFile: true,
        services,
    });
}

export function blueprintHydrate(args: CliArgs, services?: Services): Promise<void> {
    return runCliCommand(BLUEPRINT_HYDRATE, args, {
        errorCode: "HYDRATE_FAILED",
        printLogFile: true,
        services,
    });
}

export function blueprintInspire(args: CliArgs, services?: Services): Promise<void> {
    return runCliCommand(BLUEPRINT_INSPIRE, args, { errorCode: "INSPIRE_FAILED", services });
}

export function blueprintFix(args: CliArgs, services?: Services): Promise<void> {
    return runCliCommand(BLUEPRINT_FIX, args, { errorCode: "FIX_FAILED", services });
}
