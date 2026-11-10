/**
 * Generation CLI commands: generate (full pipeline), process (post-processors only).
 *
 * Thin wrappers that delegate to src/services/generate-service.ts and print output.
 */

import type { GenerateInput } from "../services/generate-request.js";
import type { GenerateOptions, RunGenerate } from "../services/generate-service.js";
import type { LanguageSelection } from "../types/index.js";
import type { CliCommandOptions } from "./command.js";
import type { CliArgs } from "./shared.js";

import { createCacheFromEnv } from "../cache.js";
import { PROCESS } from "../services/commands.js";
import { buildGenerateRequest } from "../services/generate-request.js";
import { runGenerate } from "../services/generate-service.js";
import { logger } from "../utils/index.js";
import { runCliCommand } from "./command.js";
import { askForLanguages } from "./languages.js";
import {
    CLIError,
    requireValidName,
    throwIfServiceError,
    verifyShopwareConnection,
} from "./shared.js";

/** CLI flags to the surface-neutral generate input */
export function generateInputFromArgs(args: CliArgs): GenerateInput {
    return {
        name: args.name,
        description: args.description,
        products: args.products,
        dryRun: args.dryRun,
        noTemplate: args.noTemplate,
        languages: args.languages,
        variants: args.variants,
    };
}

export interface GenerateCommandDeps {
    runGenerate: RunGenerate;
    verifyConnection: typeof verifyShopwareConnection;
}

const defaultGenerateDeps: GenerateCommandDeps = {
    runGenerate,
    verifyConnection: verifyShopwareConnection,
};

export async function generate(
    args: CliArgs,
    deps: GenerateCommandDeps = defaultGenerateDeps
): Promise<void> {
    requireValidName(args);
    const built = buildGenerateRequest(generateInputFromArgs(args));
    if ("error" in built) {
        throw new CLIError(built.error.slice("Error: ".length), "INVALID_OPTION");
    }
    const { salesChannelName, description, options } = built.request;

    logger.configure({ enabled: true });

    await deps.verifyConnection(
        process.env.SW_ENV_URL,
        process.env.SW_CLIENT_ID,
        process.env.SW_CLIENT_SECRET
    );

    const { lines } = await deps.runGenerate(salesChannelName, description, {
        ...options,
        languages: options.languages ?? (await askForMissingLanguages(options, salesChannelName)),
    });

    printServiceOutput(lines);
    throwIfServiceError(lines, "GENERATE_FAILED");
}

/**
 * Neither --languages nor TRANSLATION_LANGUAGES: ask in a terminal. Stores with cached
 * translations are not asked again: generate keeps and uploads those.
 */
async function askForMissingLanguages(
    options: GenerateOptions,
    salesChannelName: string
): Promise<LanguageSelection | undefined> {
    if (options.dryRun) return undefined;
    if (createCacheFromEnv().listTranslationLocales(salesChannelName).length > 0) return undefined;
    return askForLanguages(salesChannelName, options.products ?? 90);
}

export interface ProcessCommandDeps {
    services?: CliCommandOptions["services"];
    /** Checks SW_ENV_URL and the integration before the processors run */
    verifyConnection: () => Promise<unknown>;
}

const defaultProcessDeps: ProcessCommandDeps = {
    verifyConnection: () =>
        verifyShopwareConnection(
            process.env.SW_ENV_URL,
            process.env.SW_CLIENT_ID,
            process.env.SW_CLIENT_SECRET
        ),
};

export function processCommand(
    args: CliArgs,
    deps: ProcessCommandDeps = defaultProcessDeps
): Promise<void> {
    return runCliCommand(PROCESS, args, {
        errorCode: "PROCESS_FAILED",
        services: deps.services,
        beforeRun: deps.verifyConnection,
    });
}

/**
 * Print the progress and summary lines so they are not lost when the run ends with an error.
 * The "Error:" line itself is reported by the thrown CLIError.
 */
function printServiceOutput(lines: string[]): void {
    for (const line of lines.filter((l) => !l.startsWith("Error:"))) {
        console.log(line);
    }
}
