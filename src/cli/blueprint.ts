/**
 * Blueprint CLI commands: create, estimate, hydrate, translate, fix, inspire.
 *
 * Thin wrappers that delegate to src/services/blueprint-service.ts and print output.
 */

import type { HydrateOnly } from "../services/blueprint-service.js";
import type { CliArgs } from "./shared.js";

import {
    createBlueprint,
    estimateBlueprintCost,
    fixBlueprint,
    hydrateBlueprint,
    inspireBlueprint,
    resolveCmsStoreDescription,
} from "../services/blueprint-service.js";
import { estimateTranslation, translateBlueprint } from "../services/translation-service.js";
import { logger } from "../utils/index.js";
import { formalityFromArgs, languagesFromArgs } from "./languages.js";

// Re-export for backwards compatibility with tests
export { resolveCmsStoreDescription };
import { CLIError, requireValidName, throwIfServiceError } from "./shared.js";

export async function blueprintCreate(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);
    const description = args.description || `${salesChannelName} webshop`;
    const products = args.products || 90;

    const lines = await createBlueprint(salesChannelName, description, products, args.variants);
    throwIfServiceError(lines, "INVALID_OPTION");
    for (const line of lines) {
        console.log(line);
    }
}

const HYDRATE_ONLY_MODES: readonly HydrateOnly[] = ["categories", "properties", "cms", "variants"];

function isHydrateOnly(value: string): value is HydrateOnly {
    return HYDRATE_ONLY_MODES.some((mode) => mode === value);
}

function parseHydrateOnly(args: CliArgs, command: string): HydrateOnly | undefined {
    const hydrateOnly = args.only?.[0];
    if (!hydrateOnly) return undefined;
    if (isHydrateOnly(hydrateOnly)) return hydrateOnly;
    throw new CLIError(
        `--only must be 'categories', 'properties', 'cms', or 'variants' for ${command} (got: ${hydrateOnly})`,
        "INVALID_OPTION"
    );
}

export async function blueprintEstimate(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);
    const lines = estimateBlueprintCost(salesChannelName, {
        only: parseHydrateOnly(args, "blueprint estimate"),
        variants: args.variants,
    });

    throwIfServiceError(lines, "ESTIMATE_FAILED");

    const languages = languagesFromArgs(args);
    const translationLines = languages
        ? ["", ...(await estimateTranslation(salesChannelName, languages))]
        : [];

    for (const line of [...lines, ...translationLines]) {
        console.log(line);
    }
}

export async function blueprintTranslate(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);
    const languages = languagesFromArgs(args) ?? { mode: "all" };

    console.log(`Log file: ${logger.getLogFile()}`);

    const lines = await translateBlueprint(salesChannelName, {
        languages,
        formality: formalityFromArgs(args),
        force: args.force === true,
    });

    throwIfServiceError(lines, "TRANSLATE_FAILED");

    for (const line of lines) {
        console.log(line);
    }
}

export async function blueprintHydrate(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);

    const hydrateOnly = parseHydrateOnly(args, "blueprint hydrate");
    const forceHydration = args.rehydrate === true;

    console.log(`Log file: ${logger.getLogFile()}`);

    const lines = await hydrateBlueprint(salesChannelName, {
        only: hydrateOnly,
        force: forceHydration,
        variants: args.variants,
    });

    throwIfServiceError(lines, "HYDRATE_FAILED");

    for (const line of lines) {
        console.log(line);
    }
}

export async function blueprintInspire(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);

    if (!args.url) {
        throw new CLIError("--url is required for blueprint inspire", "MISSING_ARG");
    }

    const lines = await inspireBlueprint(args.url, salesChannelName);
    throwIfServiceError(lines, "INSPIRE_FAILED");

    for (const line of lines) {
        console.log(line);
    }
}

export async function blueprintFix(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);

    const lines = await fixBlueprint(salesChannelName);

    throwIfServiceError(lines, "FIX_FAILED");

    for (const line of lines) {
        console.log(line);
    }
}
