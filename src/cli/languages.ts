/**
 * Language selection for CLI commands: --languages flag, TRANSLATION_LANGUAGES env,
 * or an interactive question with the cost forecast (terminal only).
 */

import { createInterface } from "node:readline/promises";

import type { Formality, LanguageSelection } from "../types/index.js";
import type { CliArgs } from "./shared.js";

import {
    estimateTranslation,
    languageSelectionFromEnv,
    parseLanguageSelection,
} from "../services/translation-service.js";
import { CLIError } from "./shared.js";

/** --languages flag, then TRANSLATION_LANGUAGES; undefined when neither is set */
export function languagesFromArgs(args: CliArgs): LanguageSelection | undefined {
    try {
        return parseLanguageSelection(args.languages) ?? languageSelectionFromEnv();
    } catch (error) {
        throw new CLIError(
            error instanceof Error ? error.message : String(error),
            "INVALID_OPTION"
        );
    }
}

export function formalityFromArgs(args: CliArgs): Formality | undefined {
    if (!args.formality) return undefined;
    if (args.formality === "formal" || args.formality === "informal") return args.formality;
    throw new CLIError(
        `--formality must be 'formal' or 'informal' (got: ${args.formality})`,
        "INVALID_OPTION"
    );
}

function isInteractiveTerminal(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Ask whether to translate into all SalesChannel languages, showing the forecast first.
 * Returns undefined (English only) outside a terminal.
 */
export async function askForLanguages(
    salesChannelName: string,
    products: number
): Promise<LanguageSelection | undefined> {
    if (!isInteractiveTerminal()) return undefined;

    const forecast = await estimateTranslation(salesChannelName, { mode: "all" }, products);
    if (forecast.length <= 1) return undefined;

    for (const line of forecast) {
        console.log(line);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await rl.question(
            "Translate the catalog into these languages? [y/N] (skip with --languages=none) "
        );
        return /^y(es)?$/i.test(answer.trim()) ? { mode: "all" } : { mode: "none" };
    } finally {
        rl.close();
    }
}
