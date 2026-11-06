/**
 * Generation CLI commands: generate (full pipeline), process (post-processors only).
 *
 * Thin wrappers that delegate to src/services/generate-service.ts and print output.
 */

import type { LanguageSelection } from "../types/index.js";
import type { CliArgs } from "./shared.js";

import { createCacheFromEnv } from "../cache.js";
import {
    generate as generateService,
    runProcessorsForSalesChannel,
} from "../services/generate-service.js";
import { logger } from "../utils/index.js";
import { askForLanguages, languagesFromArgs } from "./languages.js";
import { requireValidName, throwIfServiceError, verifyShopwareConnection } from "./shared.js";

export async function generate(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);
    const description = args.description || `${salesChannelName} webshop`;

    logger.configure({ enabled: true });

    await verifyShopwareConnection(
        process.env.SW_ENV_URL,
        process.env.SW_CLIENT_ID,
        process.env.SW_CLIENT_SECRET
    );

    const lines = await generateService(salesChannelName, description, {
        products: args.products,
        dryRun: args.dryRun,
        noTemplate: args.noTemplate,
        languages: await resolveGenerateLanguages(args, salesChannelName),
    });

    printServiceOutput(lines);
    throwIfServiceError(lines, "GENERATE_FAILED");
}

/**
 * --languages / TRANSLATION_LANGUAGES, else ask in a terminal. Stores with cached
 * translations are not asked again: generate keeps and uploads those.
 */
async function resolveGenerateLanguages(
    args: CliArgs,
    salesChannelName: string
): Promise<LanguageSelection | undefined> {
    const explicit = languagesFromArgs(args);
    if (explicit) return explicit;
    if (args.dryRun) return undefined;
    if (createCacheFromEnv().listTranslationLocales(salesChannelName).length > 0) return undefined;
    return askForLanguages(salesChannelName, args.products ?? 90);
}

export async function processCommand(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);

    await verifyShopwareConnection(
        process.env.SW_ENV_URL,
        process.env.SW_CLIENT_ID,
        process.env.SW_CLIENT_SECRET
    );

    const processors = args.only ?? [];
    const lines = await runProcessorsForSalesChannel(
        salesChannelName,
        processors,
        args.dryRun ?? false
    );

    printServiceOutput(lines);
    throwIfServiceError(lines, "PROCESS_FAILED");
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
