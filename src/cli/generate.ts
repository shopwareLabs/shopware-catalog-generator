/**
 * Generation CLI commands: generate (full pipeline), process (post-processors only).
 *
 * Thin wrappers that delegate to src/services/generate-service.ts and print output.
 */

import type { CliArgs } from "./shared.js";

import {
    generate as generateService,
    runProcessorsForSalesChannel,
} from "../services/generate-service.js";
import { logger } from "../utils/index.js";
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
        noTemplate: args.noTemplate || args.force, // --force implies --no-template
    });

    throwIfServiceError(lines, "GENERATE_FAILED");

    for (const line of lines) {
        console.log(line);
    }
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

    throwIfServiceError(lines, "PROCESS_FAILED");

    for (const line of lines) {
        console.log(line);
    }
}
