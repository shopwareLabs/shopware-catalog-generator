/**
 * Interactive language question with the cost forecast (terminal only). The --languages
 * flag and TRANSLATION_LANGUAGES are resolved by the services (resolveLanguageSelection).
 */

import { createInterface } from "node:readline/promises";

import type { LanguageSelection } from "../types/index.js";

import { estimateTranslation } from "../services/translation-service.js";

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
