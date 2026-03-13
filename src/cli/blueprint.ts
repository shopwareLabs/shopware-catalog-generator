/**
 * Blueprint CLI commands: create, hydrate, fix.
 *
 * Thin wrappers that delegate to src/services/blueprint-service.ts and print output.
 */

import type { CliArgs } from "./shared.js";

import {
    createBlueprint,
    fixBlueprint,
    hydrateBlueprint,
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

export async function blueprintHydrate(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);

    const hydrateOnly = args.only?.[0] as "categories" | "properties" | "cms" | undefined;
    const forceHydration = args.rehydrate === true;

    if (hydrateOnly && !["categories", "properties", "cms"].includes(hydrateOnly)) {
        throw new CLIError(
            `--only must be 'categories', 'properties', or 'cms' for blueprint hydrate (got: ${hydrateOnly})`,
            "INVALID_OPTION"
        );
    }

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

export async function blueprintFix(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);

    const lines = await fixBlueprint(salesChannelName);

    throwIfServiceError(lines, "FIX_FAILED");

    for (const line of lines) {
        console.log(line);
    }
}
