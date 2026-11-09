/**
 * Generate Service - shared application logic for generate and process commands.
 *
 * Returns string[] (output lines) so both CLI (prints) and MCP (joins) can consume it.
 * Never calls console.log directly.
 */

import type { PostProcessorResult } from "../post-processors/index.js";
import type { LanguageSelection, ProductSyncResult } from "../types/index.js";

import { createCacheFromEnv } from "../cache.js";
import { DEFAULT_PROCESSOR_OPTIONS, registry, runProcessors } from "../post-processors/index.js";
import {
    buildPropertyMaps,
    DataHydrator,
    detectShopwareCapabilities,
    syncCategories,
    syncProducts,
    syncPropertyGroups,
    syncPropertyIdsToBlueprint,
} from "../shopware/index.js";
import { createTemplateFetcherFromEnv } from "../templates/index.js";
import { isIncompleteHydration, logger, validateBlueprint } from "../utils/index.js";
import { createBlueprint, hydrateBlueprint } from "./blueprint-service.js";
import { createProcessorDeps } from "./shopware-context.js";
import { summarizeTemplateInfo } from "./template-service.js";
import {
    formatTranslationForecast,
    resolveTargetLocales,
    runTranslation,
} from "./translation-service.js";

export interface GenerateOptions {
    products?: number;
    dryRun?: boolean;
    noTemplate?: boolean;
    /**
     * Languages to translate the catalog into. Undefined keeps English only, but cached
     * translations (e.g. from a template) are still uploaded.
     */
    languages?: LanguageSelection;
}

/**
 * Build an "Error:" line when any post-processor reported errors without throwing,
 * so CLI wrappers exit non-zero instead of recording a false pass.
 * Returns undefined when every processor finished cleanly.
 */
export function formatProcessorErrorLine(results: PostProcessorResult[]): string | undefined {
    const failed = results.filter((r) => r.errors.length > 0);
    if (failed.length === 0) {
        return undefined;
    }
    const totalErrors = failed.reduce((sum, r) => sum + r.errors.length, 0);
    const summary = failed.map((r) => `${r.name} (${r.errors.length})`).join(", ");
    return `Error: ${totalErrors} post-processor error(s): ${summary}`;
}

/**
 * Build the "Error:" line for products Shopware rejected during upload.
 * Returns undefined when every product was accepted.
 */
export function formatProductSyncErrorLine(result: ProductSyncResult): string | undefined {
    if (result.failed === 0) {
        return undefined;
    }
    const total = result.synced + result.failed;
    return `Error: ${result.failed} of ${total} products failed to upload (see log for the Shopware response)`;
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
            const templateInfo = cache.loadTemplateInfo(salesChannelName);
            if (templateInfo) results.push(`  Template: ${summarizeTemplateInfo(templateInfo)}`);
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

    const translation = await runTranslationStep(salesChannelName, options.languages, dryRun);
    results.push(...translation.lines);
    if (translation.error) return [...results, translation.error];

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

    const deps = createProcessorDeps({
        baseURL: swEnvUrl,
        getAccessToken: () => dataHydrator.getAccessToken(),
        clientId: process.env.SW_CLIENT_ID,
        clientSecret: process.env.SW_CLIENT_SECRET,
    });
    const shopware = await detectShopwareCapabilities(deps.apiHelpers);
    results.push(`  Shopware: ${shopware.describe()}`);

    let salesChannel = await dataHydrator.findSalesChannelByName(salesChannelName);
    const isNewSalesChannel = !salesChannel;

    if (!salesChannel) {
        salesChannel = await dataHydrator.createSalesChannel({
            name: salesChannelName,
            description: blueprint.salesChannel.description,
            imperialEnglishDomain: shopware.supports("measurementUnits"),
            locales: translation.locales,
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

    // A rejected batch does not stop the run: post-processors still finish the products that
    // were uploaded, and the error line at the end makes the CLI exit non-zero.
    const productSync = await syncProducts(
        dataHydrator,
        blueprint,
        salesChannel,
        categoryIdMap,
        propertyMaps.propertyOptionMap,
        shopware
    );
    results.push(`  Synced ${productSync.synced} of ${blueprint.products.length} products`);

    results.push(``, `=== Sync Complete ===`, ``, `Running post-processors...`);

    const processorResults = await runProcessors(
        {
            salesChannelId: salesChannel.id,
            salesChannelName,
            blueprint,
            cache,
            textProvider: deps.textProvider,
            imageProvider: deps.imageProvider,
            api: deps.apiHelpers,
            shopware,
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
    const errorLines = [
        formatProductSyncErrorLine(productSync),
        formatProcessorErrorLine(processorResults),
    ].filter((line): line is string => line !== undefined);
    results.push(...errorLines);
    return results;
}

interface TranslationStepResult {
    lines: string[];
    /** Locales with a cached translation (become SalesChannel domains) */
    locales: string[];
    error?: string;
}

/**
 * Step 2b: translate the catalog. Without a selection, cached translations (e.g. from a
 * template) are kept and nothing is sent to the AI.
 */
async function runTranslationStep(
    salesChannelName: string,
    languages: LanguageSelection | undefined,
    dryRun: boolean
): Promise<TranslationStepResult> {
    const cache = createCacheFromEnv();
    const cached = cache.listTranslationLocales(salesChannelName);

    if (!languages || languages.mode === "none") {
        const lines =
            cached.length > 0
                ? [`Step 2b: Using cached translations (${cached.join(", ")})`]
                : [`Step 2b: English only (use --languages=all or --languages=de-DE to translate)`];
        return { lines, locales: cached };
    }

    if (dryRun) {
        const locales = await resolveTargetLocales(languages, salesChannelName);
        return {
            lines: [
                `Step 2b: [DRY RUN] Would translate into ${locales.join(", ") || "nothing"}`,
                ...formatTranslationForecast(cache, salesChannelName, locales),
            ],
            locales: cached,
        };
    }

    const result = await runTranslation(salesChannelName, { languages });
    const error = result.lines.find((l) => l.startsWith("Error:"));
    if (error) return { lines: [`Step 2b: Translating...`], locales: [], error };
    return { lines: [`Step 2b: Translating...`, ...result.lines], locales: result.locales };
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
            shopware: await detectShopwareCapabilities(deps.apiHelpers),
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
    const errorLine = formatProcessorErrorLine(processorResults);
    if (errorLine) {
        results.push(errorLine);
    }
    return results;
}
