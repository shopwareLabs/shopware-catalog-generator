/**
 * Shared CLI utilities: error class, validation helpers, post-processor execution.
 */

import type { DataCache } from "../cache.js";
import type { HydratedBlueprint } from "../types/index.js";

import { DEFAULT_PROCESSOR_OPTIONS, registry, runProcessors } from "../post-processors/index.js";
import { createProvidersFromEnv } from "../providers/index.js";
import { createApiHelpers, createShopwareAdminClient } from "../shopware/index.js";
import { validateSubdomainName } from "../utils/index.js";

// =============================================================================
// CLI Error & Types
// =============================================================================

/**
 * Structured error class for CLI operations.
 * Allows clean error propagation with exit codes instead of abrupt process.exit().
 */
export class CLIError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly exitCode: number = 1
    ) {
        super(message);
        this.name = "CLIError";
    }
}

export interface CliArgs {
    command: "blueprint" | "generate" | "process" | "image" | "help";
    subcommand?: "create" | "hydrate" | "fix";
    name?: string;
    description?: string;
    products?: number;
    product?: string;
    interactive?: boolean;
    only?: string[];
    dryRun?: boolean;
    noTemplate?: boolean;
    force?: boolean;
    type?: string;
}

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validate and sanitize the SalesChannel name from CLI args.
 * Throws CLIError if name is missing or invalid.
 */
export function requireValidName(args: CliArgs): string {
    if (!args.name) {
        throw new CLIError("--name is required", "MISSING_ARG");
    }

    const validation = validateSubdomainName(args.name);
    if (!validation.valid) {
        throw new CLIError(`Invalid name: ${validation.error}`, "INVALID_NAME");
    }

    return validation.sanitized;
}

/**
 * Load a hydrated blueprint from cache.
 * Throws CLIError if blueprint is not found.
 */
export function requireHydratedBlueprint(
    cache: DataCache,
    salesChannelName: string
): HydratedBlueprint {
    const blueprint = cache.loadHydratedBlueprint(salesChannelName);
    if (!blueprint) {
        throw new CLIError(
            `No hydrated blueprint found for "${salesChannelName}". ` +
                `Run: bun run src/main.ts blueprint hydrate --name=${salesChannelName}`,
            "BLUEPRINT_NOT_FOUND"
        );
    }
    return blueprint;
}

// =============================================================================
// Run Post-Processors
// =============================================================================

export interface RunProcessorsParams {
    salesChannelId: string;
    salesChannelName: string;
    blueprint: HydratedBlueprint;
    cache: DataCache;
    swEnvUrl: string;
    getAccessToken: () => Promise<string>;
    processors?: string[];
    dryRun?: boolean;
}

export interface ProcessorsSummary {
    totalProcessed: number;
    totalErrors: number;
}

/**
 * Run post-processors with shared setup logic.
 * Used by generate, process, and image-fix commands.
 */
export async function executePostProcessors(
    params: RunProcessorsParams
): Promise<ProcessorsSummary> {
    const {
        salesChannelId,
        salesChannelName,
        blueprint,
        cache,
        swEnvUrl,
        getAccessToken,
        processors,
        dryRun = false,
    } = params;

    const adminClient = createShopwareAdminClient({
        baseURL: swEnvUrl,
        clientId: process.env.SW_CLIENT_ID,
        clientSecret: process.env.SW_CLIENT_SECRET,
    });
    const apiHelpers = createApiHelpers(adminClient, swEnvUrl, getAccessToken);

    const { text: textProvider, image: imageProvider } = createProvidersFromEnv();

    const availableProcessors = registry.getNames();
    const selectedProcessors = processors || availableProcessors;

    for (const name of selectedProcessors) {
        if (!registry.has(name)) {
            throw new Error(
                `Unknown processor "${name}". Available: ${availableProcessors.join(", ")}`
            );
        }
    }

    console.log(`Running processors: ${selectedProcessors.join(", ")}`);
    if (dryRun) {
        console.log("(Dry run mode - no changes will be made)");
    }
    console.log();

    const results = await runProcessors(
        {
            salesChannelId,
            salesChannelName,
            blueprint,
            cache,
            textProvider,
            imageProvider,
            shopwareUrl: swEnvUrl,
            getAccessToken,
            api: apiHelpers,
            options: {
                ...DEFAULT_PROCESSOR_OPTIONS,
                dryRun,
            },
        },
        selectedProcessors
    );

    let totalProcessed = 0;
    let totalErrors = 0;
    for (const result of results) {
        totalProcessed += result.processed;
        totalErrors += result.errors.length;
    }

    return { totalProcessed, totalErrors };
}
