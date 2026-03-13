/**
 * Shared CLI utilities: error class, validation helpers.
 */

import type { DataCache } from "../cache.js";
import type { HydratedBlueprint } from "../types/index.js";

import { createShopwareAdminClient } from "../shopware/index.js";
import { logger, validateSubdomainName } from "../utils/index.js";

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
    target?: string;
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

export type ShopwareConnectionFailure = "auth" | "unreachable" | "unknown";

export function classifyShopwareConnectionFailure(errorMessage: string): ShopwareConnectionFailure {
    const message = errorMessage.toLowerCase();

    if (
        message.includes("client authentication failed") ||
        message.includes("invalid_client") ||
        message.includes("401") ||
        message.includes("403")
    ) {
        return "auth";
    }

    if (
        message.includes("fetch failed") ||
        message.includes("econnrefused") ||
        message.includes("enotfound") ||
        message.includes("eai_again") ||
        message.includes("network")
    ) {
        return "unreachable";
    }

    return "unknown";
}

export function buildShopwareConnectionErrorMessage(
    swEnvUrl: string,
    failure: ShopwareConnectionFailure,
    logFilePath?: string
): string {
    const logHint = logFilePath ? `\n\nSee log file for full error details: ${logFilePath}` : "";

    if (failure === "auth") {
        return (
            `Cannot authenticate with Shopware at ${swEnvUrl}.\n\n` +
            `The instance is reachable, but SW_CLIENT_ID / SW_CLIENT_SECRET are invalid or outdated.\n\n` +
            `What to do:\n` +
            `1) Open Shopware Admin -> Settings -> System -> Integrations\n` +
            `2) Create a new integration and copy Access key ID + Secret access key\n` +
            `3) Update .env: SW_CLIENT_ID=<access key ID>, SW_CLIENT_SECRET=<secret access key>\n` +
            `4) Run the command again.` +
            logHint
        );
    }

    if (failure === "unreachable") {
        return (
            `Cannot reach Shopware instance at ${swEnvUrl}.\n\n` +
            `What to do:\n` +
            `1) Make sure the Shopware instance is running and accessible\n` +
            `2) Verify SW_ENV_URL in .env points to the correct base URL\n` +
            `3) If this is a fresh setup, create an integration and set SW_CLIENT_ID / SW_CLIENT_SECRET\n` +
            `4) Run the command again.` +
            logHint
        );
    }

    return (
        `Shopware preflight check failed for ${swEnvUrl}.\n\n` +
        `Please verify:\n` +
        `- Shopware instance is running\n` +
        `- SW_ENV_URL is correct\n` +
        `- SW_CLIENT_ID and SW_CLIENT_SECRET are valid integration credentials` +
        logHint
    );
}

export async function verifyShopwareConnection(
    swEnvUrl: string | undefined,
    clientId: string | undefined,
    clientSecret: string | undefined
): Promise<string> {
    if (!swEnvUrl) {
        throw new CLIError("SW_ENV_URL environment variable is required", "MISSING_ENV");
    }

    if (!clientId || !clientSecret) {
        throw new CLIError(
            `SW_CLIENT_ID and SW_CLIENT_SECRET are required.\n\n` +
                `Create a Shopware integration and set both values in your .env file.`,
            "MISSING_ENV"
        );
    }

    try {
        const adminClient = createShopwareAdminClient({
            baseURL: swEnvUrl,
            clientId,
            clientSecret,
        });
        await adminClient.invoke("searchSalesChannel post /search/sales-channel", {
            body: { limit: 1 },
        });
        return swEnvUrl;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const failure = classifyShopwareConnectionFailure(errorMessage);
        logger.error("Shopware preflight connection check failed", {
            data: { swEnvUrl, failure, error: errorMessage },
        });
        throw new CLIError(
            buildShopwareConnectionErrorMessage(swEnvUrl, failure, logger.getLogFile()),
            "SHOPWARE_CONNECTION_FAILED"
        );
    }
}
