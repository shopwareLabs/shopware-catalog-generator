/**
 * Generation CLI commands: generate (full pipeline), process (post-processors only).
 */

import type { CliArgs } from "./shared.js";

import { createCacheFromEnv } from "../cache.js";
import {
    buildPropertyMaps,
    DataHydrator,
    syncCategories,
    syncProducts,
    syncPropertyGroups,
    syncPropertyIdsToBlueprint,
} from "../shopware/index.js";
import { createTemplateFetcherFromEnv } from "../templates/index.js";
import { logger, validateBlueprint } from "../utils/index.js";
import { blueprintCreate, blueprintHydrate } from "./blueprint.js";
import {
    CLIError,
    executePostProcessors,
    requireHydratedBlueprint,
    requireValidName,
    verifyShopwareConnection,
} from "./shared.js";

export async function generate(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);
    const description = args.description || `${salesChannelName} webshop`;

    console.log(`\n=== Shopware Data Generator v2 ===`);
    console.log(`Name: ${salesChannelName}`);
    console.log(`Description: ${description}`);
    console.log();

    logger.configure({ enabled: true });
    console.log(`Log file: ${logger.getLogFile()}\n`);

    console.log("Step 0: Checking Shopware connection...");
    const swEnvUrl = await verifyShopwareConnection(
        process.env.SW_ENV_URL,
        process.env.SW_CLIENT_ID,
        process.env.SW_CLIENT_SECRET
    );
    console.log("  Shopware connection OK");

    const cache = createCacheFromEnv();

    let usedTemplate = false;
    if (!args.noTemplate && !cache.hasHydratedBlueprint(salesChannelName)) {
        console.log("Checking for pre-generated template...");
        const templateFetcher = createTemplateFetcherFromEnv();
        usedTemplate = await templateFetcher.tryUseTemplate(salesChannelName, cache);
        if (usedTemplate) {
            console.log(`Using pre-generated template for "${salesChannelName}"`);
        } else {
            console.log("No template found, will generate from scratch");
        }
        console.log();
    }

    if (!usedTemplate && !cache.hasBlueprint(salesChannelName)) {
        console.log("Step 1: Creating blueprint...");
        await blueprintCreate({ ...args, name: salesChannelName, description });
    } else if (usedTemplate) {
        console.log("Step 1: Using template blueprint");
    } else {
        console.log("Step 1: Using existing blueprint");
    }

    if (!usedTemplate && !cache.hasHydratedBlueprint(salesChannelName)) {
        console.log("\nStep 2: Hydrating blueprint...");
        await blueprintHydrate({ ...args, name: salesChannelName });
    } else if (usedTemplate) {
        console.log("Step 2: Using template hydrated blueprint");
    } else {
        console.log("Step 2: Using existing hydrated blueprint");
    }

    const blueprint = cache.loadHydratedBlueprint(salesChannelName);
    if (!blueprint) {
        throw new CLIError("Failed to load hydrated blueprint", "BLUEPRINT_LOAD_FAILED");
    }

    const validationResult = validateBlueprint(blueprint, { autoFix: true, logFixes: true });
    if (!validationResult.valid) {
        const issueMessages = validationResult.issues
            .map((issue) => `${issue.type === "error" ? "✗" : "⚠"} ${issue.message}`)
            .join("; ");
        throw new CLIError(`Blueprint validation failed: ${issueMessages}`, "VALIDATION_FAILED");
    }
    if (validationResult.fixesApplied > 0) {
        cache.saveHydratedBlueprint(salesChannelName, blueprint);
        console.log(`  Saved fixed blueprint`);
    }

    console.log("\nStep 3: Syncing to Shopware...");

    const dataHydrator = new DataHydrator();
    await dataHydrator.authenticateWithClientCredentials(
        swEnvUrl,
        process.env.SW_CLIENT_ID,
        process.env.SW_CLIENT_SECRET
    );

    let salesChannel = await dataHydrator.findSalesChannelByName(salesChannelName);
    const isNewSalesChannel = !salesChannel;

    if (!salesChannel) {
        salesChannel = await dataHydrator.createSalesChannel({
            name: salesChannelName,
            description: blueprint.salesChannel.description,
        });
        console.log(`  Created SalesChannel: ${salesChannel.name} (${salesChannel.id})`);
    } else {
        console.log(`  Using existing SalesChannel: ${salesChannel.name} (${salesChannel.id})`);
    }

    const categoryIdMap = await syncCategories(
        dataHydrator,
        blueprint,
        salesChannel,
        isNewSalesChannel
    );

    await syncPropertyGroups(dataHydrator, blueprint);

    const propertyMaps = buildPropertyMaps(blueprint);

    syncPropertyIdsToBlueprint(blueprint, propertyMaps);

    cache.saveHydratedBlueprint(salesChannelName, blueprint);
    console.log(`  Synced property IDs to blueprint`);

    await syncProducts(
        dataHydrator,
        blueprint,
        salesChannel,
        categoryIdMap,
        propertyMaps.propertyOptionMap
    );

    console.log(`\n=== Sync Complete ===`);

    console.log(`\n=== Running Post-Processors ===\n`);

    const { totalProcessed, totalErrors } = await executePostProcessors({
        salesChannelId: salesChannel.id,
        salesChannelName,
        blueprint,
        cache,
        swEnvUrl,
        getAccessToken: () => dataHydrator.getAccessToken(),
        dryRun: args.dryRun,
    });

    console.log(`\n=== Generation Complete ===`);
    console.log(`SalesChannel: ${salesChannelName}`);
    console.log(`Storefront: ${blueprint.salesChannel.baseUrl}`);
    console.log(`Post-processors: ${totalProcessed} processed, ${totalErrors} errors`);
    console.log();
}

export async function processCommand(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);

    console.log(`\n=== Post-Processors ===`);
    console.log(`Name: ${salesChannelName}`);
    console.log();

    const cache = createCacheFromEnv();
    const blueprint = requireHydratedBlueprint(cache, salesChannelName);

    console.log("Step 0: Checking Shopware connection...");
    const swEnvUrl = await verifyShopwareConnection(
        process.env.SW_ENV_URL,
        process.env.SW_CLIENT_ID,
        process.env.SW_CLIENT_SECRET
    );
    console.log("  Shopware connection OK");

    const dataHydrator = new DataHydrator();
    await dataHydrator.authenticateWithClientCredentials(
        swEnvUrl,
        process.env.SW_CLIENT_ID,
        process.env.SW_CLIENT_SECRET
    );

    const salesChannel = await dataHydrator.findSalesChannelByName(salesChannelName);
    if (!salesChannel) {
        throw new CLIError(
            `SalesChannel "${salesChannelName}" not found in Shopware. ` +
                `Run: bun run src/main.ts generate --name=${salesChannelName}`,
            "SALESCHANNEL_NOT_FOUND"
        );
    }

    const { totalProcessed, totalErrors } = await executePostProcessors({
        salesChannelId: salesChannel.id,
        salesChannelName,
        blueprint,
        cache,
        swEnvUrl,
        getAccessToken: () => dataHydrator.getAccessToken(),
        processors: args.only,
        dryRun: args.dryRun,
    });

    console.log(`\n=== Post-Processing Complete ===`);
    console.log(`Processed: ${totalProcessed}`);
    console.log(`Errors: ${totalErrors}`);
}
