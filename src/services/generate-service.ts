/**
 * Generate Service - shared application logic for generate and process commands.
 *
 * Returns string[] (output lines) so both CLI (prints) and MCP (joins) can consume it.
 * Never calls console.log directly.
 */

import type { VariantSettingOverrides } from "../blueprint/index.js";
import type { PostProcessorResult } from "../post-processors/index.js";
import type { DataHydrator } from "../shopware/index.js";
import type { HydratedBlueprint, LanguageSelection, ProductSyncResult } from "../types/index.js";
import type { ShopwareConnection } from "./shopware-context.js";

import { applyColorSystem, hasVariantOverrides } from "../blueprint/index.js";
import { createCacheFromEnv } from "../cache.js";
import { DEFAULT_PROCESSOR_OPTIONS, registry, runProcessors } from "../post-processors/index.js";
import {
    buildPropertyMaps,
    detectShopwareCapabilities,
    syncCategories,
    syncProducts,
    syncPropertyGroups,
    syncPropertyIdsToBlueprint,
} from "../shopware/index.js";
import { createTemplateFetcherFromEnv } from "../templates/index.js";
import { isIncompleteHydration, logger, validateBlueprint } from "../utils/index.js";
import { createBlueprint, hydrateBlueprint, inspireBlueprint } from "./blueprint-service.js";
import {
    connectShopware,
    createProcessorDepsForConnection,
    shopwareConnectionFromEnv,
} from "./shopware-context.js";
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
    /** Variant settings for a new blueprint (ignored with a warning for an existing one) */
    variants?: VariantSettingOverrides;
    /** Move the cached SalesChannel data to the trash first */
    clearCache?: boolean;
    /** Crawl this store for inspiration before the blueprint is created */
    inspirationUrl?: string;
    /** Upload only, no post-processors */
    skipProcessors?: boolean;
    /** Shopware to upload to (default: SW_ENV_URL integration) */
    connection?: ShopwareConnection;
    /** Live progress for callers that report while the run is going (HTTP server) */
    hooks?: GenerateHooks;
}

export interface GenerateHooks {
    /** Every output line, as soon as it is written */
    onLine?: (line: string) => void;
    onProgress?: (phase: GeneratePhase, current: number, total: number) => void;
}

export type GeneratePhase = "blueprint" | "upload" | "processors";

/** What a finished upload produced (absent for errors before the upload and for dry runs) */
export interface GenerateSummary {
    salesChannelId: string;
    salesChannelName: string;
    categories: number;
    products: number;
    failedProducts: number;
    propertyGroups: number;
    processors: { name: string; processed: number; errors: string[] }[];
}

export interface GenerateRun {
    lines: string[];
    summary?: GenerateSummary;
}

/** Output lines of a run, forwarded to the onLine hook as they are written */
class RunOutput {
    readonly lines: string[] = [];

    constructor(private readonly onLine?: (line: string) => void) {}

    push(...lines: string[]): void {
        this.lines.push(...lines);
        for (const line of lines) this.onLine?.(line);
    }

    /** Add the final lines and return the run */
    end(...lines: string[]): GenerateRun {
        this.push(...lines);
        return { lines: this.lines };
    }
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

/**
 * Full pipeline: blueprint, hydration, translation, upload, post-processors.
 * The single implementation behind CLI, MCP and the HTTP server.
 * Without a description, the crawled brand description or "{name} webshop" is used.
 */
export async function runGenerate(
    salesChannelName: string,
    description: string | undefined,
    options: GenerateOptions = {}
): Promise<GenerateRun> {
    const { dryRun = false } = options;
    const progress = options.hooks?.onProgress ?? (() => {});

    logger.configure({ enabled: true });

    const out = new RunOutput(options.hooks?.onLine);
    const cache = createCacheFromEnv();

    if (options.clearCache) {
        cache.clearSalesChannel(salesChannelName);
    }
    const inspirationLines = await runInspirationStep(salesChannelName, options.inspirationUrl);
    const effectiveDescription =
        description ||
        cache.loadInspiration(salesChannelName)?.brandDescription ||
        `${salesChannelName} webshop`;

    out.push(
        `=== Shopware Data Generator v2 ===`,
        `Name: ${salesChannelName}`,
        `Description: ${effectiveDescription}`,
        `Log file: ${logger.getLogFile()}`,
        ``
    );
    if (options.clearCache) out.push(`Cleared cached data for "${salesChannelName}"`);
    out.push(...inspirationLines);

    const connection = options.connection ?? shopwareConnectionFromEnv();
    if (!connection) {
        return out.end(`Error: SW_ENV_URL environment variable is required`);
    }

    progress("blueprint", 0, 2);
    const blueprintError = await prepareBlueprints(
        salesChannelName,
        effectiveDescription,
        options,
        connection,
        out
    );
    if (blueprintError) return out.end(blueprintError);
    progress("blueprint", 2, 2);

    const loaded = await loadValidatedBlueprint(salesChannelName, connection, out);
    if (typeof loaded === "string") return out.end(loaded);
    const blueprint = loaded;

    const translation = await runTranslationStep(salesChannelName, options.languages, dryRun);
    out.push(...translation.lines);
    if (translation.error) return out.end(translation.error);

    out.push(`Step 3: Syncing to Shopware...`);

    if (dryRun) {
        return out.end(
            `  [DRY RUN] Would sync to ${connection.url}`,
            ``,
            `=== Dry Run Complete ===`
        );
    }

    let dataHydrator: DataHydrator;
    try {
        dataHydrator = await connectShopware(connection);
    } catch (error) {
        return out.end(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    const deps = createProcessorDepsForConnection(connection, dataHydrator, {
        skipProviders: options.skipProcessors,
    });
    const shopware = await detectShopwareCapabilities(deps.apiHelpers);
    out.push(`  Shopware: ${shopware.describe()}`);
    progress("upload", 0, 4);

    let salesChannel = await dataHydrator.findSalesChannelByName(salesChannelName);
    const isNewSalesChannel = !salesChannel;

    if (!salesChannel) {
        salesChannel = await dataHydrator.createSalesChannel({
            name: salesChannelName,
            description: blueprint.salesChannel.description,
            imperialEnglishDomain: shopware.supports("measurementUnits"),
            locales: translation.locales,
        });
        out.push(`  Created SalesChannel: ${salesChannel.name} (${salesChannel.id})`);
    } else {
        out.push(`  Using existing SalesChannel: ${salesChannel.name} (${salesChannel.id})`);
    }
    progress("upload", 1, 4);

    const categoryIdMap = await syncCategories(
        dataHydrator,
        blueprint,
        salesChannel,
        isNewSalesChannel
    );
    out.push(`  Synced ${categoryIdMap.size} categories`);
    progress("upload", 2, 4);

    await syncPropertyGroups(dataHydrator, blueprint);
    out.push(`  Synced ${blueprint.propertyGroups.length} property groups`);
    progress("upload", 3, 4);

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
    out.push(`  Synced ${productSync.synced} of ${blueprint.products.length} products`);
    progress("upload", 4, 4);

    out.push(``, `=== Sync Complete ===`, ``);

    const processorNames = options.skipProcessors ? [] : registry.getNames();
    if (options.skipProcessors) {
        out.push(`Skipping post-processors`);
    } else {
        out.push(`Running post-processors...`);
    }
    progress("processors", 0, processorNames.length);
    const processorResults =
        processorNames.length === 0
            ? []
            : await runProcessors(
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
                  processorNames
              );
    progress("processors", processorNames.length, processorNames.length);

    const totalProcessed = processorResults.reduce((sum, r) => sum + r.processed, 0);
    const totalErrors = processorResults.reduce((sum, r) => sum + r.errors.length, 0);

    out.push(
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
    out.push(...errorLines);

    return {
        lines: out.lines,
        summary: {
            salesChannelId: salesChannel.id,
            salesChannelName,
            categories: categoryIdMap.size,
            products: productSync.synced,
            failedProducts: productSync.failed,
            propertyGroups: blueprint.propertyGroups.length,
            processors: processorResults.map((r) => ({
                name: r.name,
                processed: r.processed,
                errors: r.errors,
            })),
        },
    };
}

/** Signature of runGenerate, injected by CLI, MCP and server so tests can record the call */
export type RunGenerate = typeof runGenerate;

/** Step 0 (optional): crawl a real store. A failed crawl never stops the run. */
async function runInspirationStep(
    salesChannelName: string,
    inspirationUrl: string | undefined
): Promise<string[]> {
    if (!inspirationUrl) return [];
    if (createCacheFromEnv().hasInspiration(salesChannelName)) {
        return [`Step 0: Using cached inspiration`];
    }
    try {
        const lines = await inspireBlueprint(inspirationUrl, salesChannelName);
        const error = lines.find((l) => l.startsWith("Error:"));
        if (error) return [`  ⚠ Inspiration crawl failed: ${error.slice("Error: ".length)}`];
        return [`Step 0: Inspiration saved from ${inspirationUrl}`];
    } catch (error) {
        return [
            `  ⚠ Inspiration crawl failed: ${error instanceof Error ? error.message : String(error)}`,
        ];
    }
}

/** Steps 1 and 2: template, blueprint and hydration. Returns an "Error:" line on failure. */
async function prepareBlueprints(
    salesChannelName: string,
    description: string,
    options: GenerateOptions,
    connection: ShopwareConnection,
    out: RunOutput
): Promise<string | undefined> {
    const cache = createCacheFromEnv();

    let usedTemplate = false;
    if (!options.noTemplate && !cache.hasHydratedBlueprint(salesChannelName)) {
        out.push(`Checking for pre-generated template...`);
        const templateFetcher = createTemplateFetcherFromEnv();
        usedTemplate = await templateFetcher.tryUseTemplate(salesChannelName, cache);
        if (usedTemplate) {
            out.push(`Using pre-generated template for "${salesChannelName}"`);
            const templateInfo = cache.loadTemplateInfo(salesChannelName);
            if (templateInfo) out.push(`  Template: ${summarizeTemplateInfo(templateInfo)}`);
        } else {
            out.push(`No template found, will generate from scratch`);
        }
    }

    if (!usedTemplate && !cache.hasBlueprint(salesChannelName)) {
        out.push(`Step 1: Creating blueprint...`);
        const lines = await createBlueprint(
            salesChannelName,
            description,
            options.products ?? 90,
            options.variants
        );
        const createError = lines.find((l) => l.startsWith("Error:"));
        if (createError) return createError;
        out.push(...lines.filter((l) => !l.startsWith("===")));
    } else {
        if (options.variants && hasVariantOverrides(options.variants)) {
            out.push(
                `⚠ Variant settings are ignored for an existing blueprint. ` +
                    `Use: blueprint hydrate --name=${salesChannelName} --only=variants`
            );
        }
        out.push(
            usedTemplate ? `Step 1: Using template blueprint` : `Step 1: Using existing blueprint`
        );
    }
    options.hooks?.onProgress?.("blueprint", 1, 2);

    if (!usedTemplate && !cache.hasHydratedBlueprint(salesChannelName)) {
        return runHydration(salesChannelName, connection, out);
    }
    out.push(
        usedTemplate
            ? `Step 2: Using template hydrated blueprint`
            : `Step 2: Using existing hydrated blueprint`
    );
    return undefined;
}

/**
 * Load the hydrated blueprint, re-hydrate a broken one from a failed run, validate it and
 * apply the colour system. Returns the blueprint or an "Error:" line.
 */
async function loadValidatedBlueprint(
    salesChannelName: string,
    connection: ShopwareConnection,
    out: RunOutput
): Promise<HydratedBlueprint | string> {
    const cache = createCacheFromEnv();
    let blueprint = cache.loadHydratedBlueprint(salesChannelName);
    if (!blueprint) {
        return `Error: Failed to load hydrated blueprint`;
    }

    let validationResult = validateBlueprint(blueprint, { autoFix: true, logFixes: false });

    if (!validationResult.valid && isIncompleteHydration(validationResult)) {
        out.push(
            `  Detected incomplete hydrated blueprint (likely from a previous failed attempt). Re-hydrating...`
        );
        cache.deleteHydratedBlueprint(salesChannelName);

        const hydrateError = await runHydration(salesChannelName, connection, out);
        if (hydrateError) return hydrateError;

        blueprint = cache.loadHydratedBlueprint(salesChannelName);
        if (!blueprint) {
            return `Error: Failed to load hydrated blueprint after re-hydration`;
        }
        validationResult = validateBlueprint(blueprint, { autoFix: true, logFixes: false });
    }

    if (!validationResult.valid) {
        const issues = validationResult.issues.map((i) => `  - ${i.message}`).join("\n");
        return [
            `Error: Blueprint validation failed:`,
            issues,
            ``,
            `This may be caused by an interrupted hydration (e.g., API credits exhausted).`,
            `To retry: bun run blueprint hydrate --name=${salesChannelName} --rehydrate`,
        ].join("\n");
    }
    if (validationResult.fixesApplied > 0) {
        out.push(`  Auto-fixed ${validationResult.fixesApplied} blueprint issue(s)`);
    }

    // Blueprints from older runs and templates get the colour system before translation
    // and upload (no AI: unknown shades are estimated)
    applyColorSystem(blueprint, cache.loadColorShades(salesChannelName));
    cache.saveHydratedBlueprint(salesChannelName, blueprint);

    const originalBlueprint = cache.loadBlueprint(salesChannelName);
    const expectedProducts = originalBlueprint?.products.length ?? 0;
    if (blueprint.products.length < expectedProducts) {
        out.push(
            ``,
            `  ⚠ Partial hydration: ${blueprint.products.length}/${expectedProducts} products were generated.`,
            `  Some branches may have failed (e.g., API rate limit or credits exhausted).`,
            `  To regenerate all products: bun run blueprint hydrate --name=${salesChannelName} --rehydrate`,
            ``
        );
    }
    return blueprint;
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
    connection: ShopwareConnection,
    out: RunOutput
): Promise<string | undefined> {
    out.push(`Step 2: Hydrating blueprint...`);
    const lines = await hydrateBlueprint(salesChannelName, { connection });
    const errorLine = lines.find((l) => l.startsWith("Error:"));
    if (errorLine) {
        return errorLine;
    }
    out.push(...lines.filter((l) => !l.startsWith("===") && l !== ``));
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

    const connection = shopwareConnectionFromEnv();
    if (!connection) {
        return [...results, `Error: SW_ENV_URL environment variable is required`];
    }

    let dataHydrator: DataHydrator;
    try {
        dataHydrator = await connectShopware(connection);
    } catch (error) {
        return [...results, `Error: ${error instanceof Error ? error.message : String(error)}`];
    }

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

    const deps = createProcessorDepsForConnection(connection, dataHydrator);

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
