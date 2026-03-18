/**
 * Generate Service - shared application logic for generate and process commands.
 *
 * Returns string[] (output lines) so both CLI (prints) and MCP (joins) can consume it.
 * Never calls console.log directly.
 */

import { createCacheFromEnv } from "../cache.js";
import { DEFAULT_PROCESSOR_OPTIONS, registry, runProcessors } from "../post-processors/index.js";
import {
    buildPropertyMaps,
    DataHydrator,
    syncCategories,
    syncProducts,
    syncPropertyGroups,
    syncPropertyIdsToBlueprint,
} from "../shopware/index.js";
import { createTemplateFetcherFromEnv } from "../templates/index.js";
import { isIncompleteHydration, logger, validateBlueprint } from "../utils/index.js";
import { createBlueprint, hydrateBlueprint } from "./blueprint-service.js";
import { createProcessorDeps } from "./shopware-context.js";

export interface GenerateOptions {
    products?: number;
    dryRun?: boolean;
    noTemplate?: boolean;
}

export async function generate(
    salesChannelName: string,
    description: string,
    options: GenerateOptions = {}
): Promise<string[]> {
    const { dryRun = false, noTemplate = false } = options;

    logger.configure({ enabled: true });

    const results: string[] = [
        `=== Shopware Data Generator v2 ===`,
        `Name: ${salesChannelName}`,
        `Description: ${description}`,
        `Log file: ${logger.getLogFile()}`,
        ``,
    ];

    const swEnvUrl = process.env.SW_ENV_URL;
    if (!swEnvUrl) {
        return [...results, `Error: SW_ENV_URL environment variable is required`];
    }

    const cache = createCacheFromEnv();

    // Check for pre-generated template
    let usedTemplate = false;
    if (!noTemplate && !cache.hasHydratedBlueprint(salesChannelName)) {
        results.push(`Checking for pre-generated template...`);
        const templateFetcher = createTemplateFetcherFromEnv();
        usedTemplate = await templateFetcher.tryUseTemplate(salesChannelName, cache);
        if (usedTemplate) {
            results.push(`Using pre-generated template for "${salesChannelName}"`);
        } else {
            results.push(`No template found, will generate from scratch`);
        }
    }

    if (!usedTemplate && !cache.hasBlueprint(salesChannelName)) {
        results.push(`Step 1: Creating blueprint...`);
        const lines = await createBlueprint(salesChannelName, description, options.products ?? 90);
        results.push(...lines.filter((l) => !l.startsWith("===")));
    } else {
        results.push(
            usedTemplate ? `Step 1: Using template blueprint` : `Step 1: Using existing blueprint`
        );
    }

    if (!usedTemplate && !cache.hasHydratedBlueprint(salesChannelName)) {
        const hydrateError = await runHydration(salesChannelName, results);
        if (hydrateError) return [...results, hydrateError];
    } else {
        results.push(
            usedTemplate
                ? `Step 2: Using template hydrated blueprint`
                : `Step 2: Using existing hydrated blueprint`
        );
    }

    let blueprint = cache.loadHydratedBlueprint(salesChannelName);
    if (!blueprint) {
        return [...results, `Error: Failed to load hydrated blueprint`];
    }

    let validationResult = validateBlueprint(blueprint, { autoFix: true, logFixes: false });

    if (!validationResult.valid && isIncompleteHydration(validationResult)) {
        results.push(
            `  Detected incomplete hydrated blueprint (likely from a previous failed attempt). Re-hydrating...`
        );
        cache.deleteHydratedBlueprint(salesChannelName);

        const hydrateError = await runHydration(salesChannelName, results);
        if (hydrateError) return [...results, hydrateError];

        blueprint = cache.loadHydratedBlueprint(salesChannelName);
        if (!blueprint) {
            return [...results, `Error: Failed to load hydrated blueprint after re-hydration`];
        }
        validationResult = validateBlueprint(blueprint, { autoFix: true, logFixes: false });
    }

    if (!validationResult.valid) {
        const issues = validationResult.issues.map((i) => `  - ${i.message}`).join("\n");
        return [
            ...results,
            `Error: Blueprint validation failed:\n${issues}`,
            ``,
            `This may be caused by an interrupted hydration (e.g., API credits exhausted).`,
            `To retry: bun run blueprint hydrate --name=${salesChannelName} --rehydrate`,
        ];
    }
    if (validationResult.fixesApplied > 0) {
        cache.saveHydratedBlueprint(salesChannelName, blueprint);
        results.push(`  Auto-fixed ${validationResult.fixesApplied} blueprint issue(s)`);
    }

    const originalBlueprint = cache.loadBlueprint(salesChannelName);
    if (originalBlueprint) {
        const expectedProducts = originalBlueprint.products.length;
        const actualProducts = blueprint.products.length;
        if (actualProducts < expectedProducts) {
            results.push(
                ``,
                `  ⚠ Partial hydration: ${actualProducts}/${expectedProducts} products were generated.`,
                `  Some branches may have failed (e.g., API rate limit or credits exhausted).`,
                `  To regenerate all products: bun run blueprint hydrate --name=${salesChannelName} --rehydrate`,
                ``
            );
        }
    }

    results.push(`Step 3: Syncing to Shopware...`);

    if (dryRun) {
        results.push(`  [DRY RUN] Would sync to ${swEnvUrl}`);
        results.push(``);
        results.push(`=== Dry Run Complete ===`);
        return results;
    }

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
        results.push(`  Created SalesChannel: ${salesChannel.name} (${salesChannel.id})`);
    } else {
        results.push(`  Using existing SalesChannel: ${salesChannel.name} (${salesChannel.id})`);
    }

    const categoryIdMap = await syncCategories(
        dataHydrator,
        blueprint,
        salesChannel,
        isNewSalesChannel
    );
    results.push(`  Synced ${categoryIdMap.size} categories`);

    await syncPropertyGroups(dataHydrator, blueprint);
    results.push(`  Synced ${blueprint.propertyGroups.length} property groups`);

    const propertyMaps = buildPropertyMaps(blueprint);
    syncPropertyIdsToBlueprint(blueprint, propertyMaps);
    cache.saveHydratedBlueprint(salesChannelName, blueprint);

    await syncProducts(
        dataHydrator,
        blueprint,
        salesChannel,
        categoryIdMap,
        propertyMaps.propertyOptionMap
    );
    results.push(`  Synced ${blueprint.products.length} products`);

    results.push(``, `=== Sync Complete ===`, ``, `Running post-processors...`);

    const deps = createProcessorDeps({
        baseURL: swEnvUrl,
        getAccessToken: () => dataHydrator.getAccessToken(),
        clientId: process.env.SW_CLIENT_ID,
        clientSecret: process.env.SW_CLIENT_SECRET,
    });

    const processorResults = await runProcessors(
        {
            salesChannelId: salesChannel.id,
            salesChannelName,
            blueprint,
            cache,
            textProvider: deps.textProvider,
            imageProvider: deps.imageProvider,
            api: deps.apiHelpers,
            options: { ...DEFAULT_PROCESSOR_OPTIONS, dryRun: false },
        },
        registry.getNames()
    );

    const totalProcessed = processorResults.reduce((sum, r) => sum + r.processed, 0);
    const totalErrors = processorResults.reduce((sum, r) => sum + r.errors.length, 0);

    results.push(
        ``,
        `=== Generation Complete ===`,
        `SalesChannel: ${salesChannelName}`,
        `Storefront: ${blueprint.salesChannel.baseUrl}`,
        `Post-processors: ${totalProcessed} processed, ${totalErrors} errors`
    );
    return results;
}

async function runHydration(
    salesChannelName: string,
    results: string[]
): Promise<string | undefined> {
    results.push(`Step 2: Hydrating blueprint...`);
    const lines = await hydrateBlueprint(salesChannelName, {});
    const errorLine = lines.find((l) => l.startsWith("Error:"));
    if (errorLine) {
        return errorLine;
    }
    results.push(...lines.filter((l) => !l.startsWith("===") && l !== ``));
    return undefined;
}

export async function runProcessorsForSalesChannel(
    salesChannelName: string,
    processors: string[],
    dryRun: boolean
): Promise<string[]> {
    const results: string[] = [`=== Post-Processors ===`, `Name: ${salesChannelName}`, ``];

    const cache = createCacheFromEnv();
    const blueprint = cache.loadHydratedBlueprint(salesChannelName);
    if (!blueprint) {
        return [
            ...results,
            `Error: No hydrated blueprint found for "${salesChannelName}". ` +
                `Run: generate --name=${salesChannelName}`,
        ];
    }

    const swEnvUrl = process.env.SW_ENV_URL;
    if (!swEnvUrl) {
        return [...results, `Error: SW_ENV_URL environment variable is required`];
    }

    const dataHydrator = new DataHydrator();
    await dataHydrator.authenticateWithClientCredentials(
        swEnvUrl,
        process.env.SW_CLIENT_ID,
        process.env.SW_CLIENT_SECRET
    );

    const salesChannel = await dataHydrator.findSalesChannelByName(salesChannelName);
    if (!salesChannel) {
        return [
            ...results,
            `Error: SalesChannel "${salesChannelName}" not found in Shopware. ` +
                `Run: generate --name=${salesChannelName}`,
        ];
    }

    const availableProcessors = registry.getNames();
    const selectedProcessors = processors.length > 0 ? processors : availableProcessors;

    const deps = createProcessorDeps({
        baseURL: swEnvUrl,
        getAccessToken: () => dataHydrator.getAccessToken(),
        clientId: process.env.SW_CLIENT_ID,
        clientSecret: process.env.SW_CLIENT_SECRET,
    });

    results.push(`Running processors: ${selectedProcessors.join(", ")}`);
    if (dryRun) results.push(`(Dry run mode - no changes will be made)`);
    results.push(``);

    const processorResults = await runProcessors(
        {
            salesChannelId: salesChannel.id,
            salesChannelName,
            blueprint,
            cache,
            textProvider: deps.textProvider,
            imageProvider: deps.imageProvider,
            api: deps.apiHelpers,
            options: { ...DEFAULT_PROCESSOR_OPTIONS, dryRun },
        },
        selectedProcessors
    );

    const totalProcessed = processorResults.reduce((sum, r) => sum + r.processed, 0);
    const totalErrors = processorResults.reduce((sum, r) => sum + r.errors.length, 0);

    results.push(
        `=== Post-Processing Complete ===`,
        `Processed: ${totalProcessed}`,
        `Errors: ${totalErrors}`
    );
    return results;
}
