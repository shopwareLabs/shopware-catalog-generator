/**
 * Run a shared command spec (src/services/commands.ts) from CLI flags.
 *
 * Flags map to the spec parameters by name (--dry-run → dryRun, --variant-colors →
 * variantColors), so the CLI validates and defaults exactly like the MCP tool.
 */

import type { z } from "zod";

import type { CommandSpec, ExecuteCommandOptions } from "../services/commands.js";
import type { CliArgs } from "./shared.js";

import { executeCommand } from "../services/commands.js";
import { logger } from "../utils/index.js";
import { throwIfServiceError } from "./shared.js";

export interface CliCommandOptions extends Pick<ExecuteCommandOptions, "services" | "beforeRun"> {
    /** CLIError code when the command fails */
    errorCode: string;
    /** Print the log file path first (long-running AI commands) */
    printLogFile?: boolean;
}

/** Parameter name → CLI flag (processors is --only, the rest is kebab-case) */
export function cliFlagName(param: string): string {
    if (param === "processors") return "--only";
    return `--${param.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** Number flags arrive as strings; a flag without a value ("") must fail validation */
function flagNumber(value: string | number | undefined): number | undefined {
    if (value === undefined || typeof value === "number") return value;
    return value.trim() === "" ? Number.NaN : Number(value);
}

/** CLI args as spec parameters (unknown keys are stripped by the spec schema) */
export function commandParamsFromArgs(args: CliArgs): Record<string, unknown> {
    const { command: _command, subcommand: _subcommand, only, variants = {}, ...rest } = args;
    return {
        ...rest,
        only: only?.[0],
        processors: only,
        variantColors: flagNumber(variants.colors),
        variantOptions: flagNumber(variants.options),
        maxVariants: flagNumber(variants.maxVariants),
        variantShare: flagNumber(variants.share),
    };
}

/** Run the command, print its output and throw a CLIError for an "Error:" line */
export async function runCliCommand<Shape extends z.ZodRawShape>(
    spec: CommandSpec<Shape>,
    args: CliArgs,
    options: CliCommandOptions
): Promise<void> {
    if (options.printLogFile) console.log(`Log file: ${logger.getLogFile()}`);
    await runCliParams(spec, commandParamsFromArgs(args), options);
}

export interface CliParamsOptions extends CliCommandOptions {
    /** Parameter name → flag in error messages (default: cliFlagName) */
    formatParam?: (param: string) => string;
}

/** Run a spec with already mapped parameters (CLIs with their own flag parser) */
export async function runCliParams<Shape extends z.ZodRawShape>(
    spec: CommandSpec<Shape>,
    params: Record<string, unknown>,
    options: CliParamsOptions
): Promise<void> {
    const lines = await executeCommand(spec, params, {
        services: options.services,
        beforeRun: options.beforeRun,
        formatParam: options.formatParam ?? cliFlagName,
    });

    // Print progress first so it is not lost when the run ends with an error
    for (const line of lines.filter((l) => !l.startsWith("Error:"))) {
        console.log(line);
    }
    throwIfServiceError(lines, options.errorCode);
}
