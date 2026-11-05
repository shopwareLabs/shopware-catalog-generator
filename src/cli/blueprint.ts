/**
 * Blueprint CLI commands: create, estimate, hydrate, fix, inspire.
 *
 * Thin wrappers that delegate to src/services/blueprint-service.ts and print output.
 */

import type { CliArgs } from "./shared.js";

import {
    createBlueprint,
    estimateBlueprintCost,
    fixBlueprint,
    hydrateBlueprint,
    inspireBlueprint,
    resolveCmsStoreDescription,
} from "../services/blueprint-service.js";
import { logger } from "../utils/index.js";

// Re-export for backwards compatibility with tests
export { resolveCmsStoreDescription };
import { CLIError, requireValidName, throwIfServiceError } from "./shared.js";

export async function blueprintCreate(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);
    const description = args.description || `${salesChannelName} webshop`;
    const products = args.products || 90;

    const lines = await createBlueprint(salesChannelName, description, products);
    for (const line of lines) {
        console.log(line);
    }
}

type HydrateOnly = "categories" | "properties" | "cms";

function parseHydrateOnly(args: CliArgs, command: string): HydrateOnly | undefined {
    const hydrateOnly = args.only?.[0];
    if (!hydrateOnly) return undefined;
    if (hydrateOnly === "categories" || hydrateOnly === "properties" || hydrateOnly === "cms") {
        return hydrateOnly;
    }
    throw new CLIError(
        `--only must be 'categories', 'properties', or 'cms' for ${command} (got: ${hydrateOnly})`,
        "INVALID_OPTION"
    );
}

export async function blueprintEstimate(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);
    const lines = estimateBlueprintCost(salesChannelName, {
        only: parseHydrateOnly(args, "blueprint estimate"),
    });

    throwIfServiceError(lines, "ESTIMATE_FAILED");

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
