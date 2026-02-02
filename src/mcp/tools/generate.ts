/**
 * Generate and Process Tools for MCP Server
 *
 * Exposes the main generate and process commands.
 */

import type { ExistingProperty } from "../../utils/index.js";
import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { createCacheFromEnv } from "../../cache.js";
import { BlueprintGenerator, BlueprintHydrator } from "../../generators/index.js";
import { DEFAULT_PROCESSOR_OPTIONS, registry, runProcessors } from "../../post-processors/index.js";
import { createProvidersFromEnv } from "../../providers/index.js";
import {
    buildPropertyMaps,
    createApiHelpers,
    createShopwareAdminClient,
    DataHydrator,
    syncCategories,
    syncProducts,
    syncPropertyGroups,
    syncPropertyIdsToBlueprint,
} from "../../shopware/index.js";
import { createTemplateFetcherFromEnv } from "../../templates/index.js";
import {
    countCategories,
    logger,
    PropertyCollector,
    validateBlueprint,
    validateSubdomainName,
} from "../../utils/index.js";

export function registerGenerateTools(server: FastMCP): void {
    // generate - Full pipeline: create + hydrate + upload
    server.addTool({
        name: "generate",
        description:
            "Full generation pipeline: create blueprint, hydrate with AI, and upload to Shopware. Creates SalesChannel if it doesn't exist.",
        parameters: z.object({
            name: z.string().describe("SalesChannel name (becomes subdomain, e.g., 'furniture')"),
            description: z
                .string()
                .optional()
                .describe("Store description for AI context (default: '{name} webshop')"),
            products: z
                .number()
                .default(90)
                .describe("Number of products to generate (default: 90)"),
            dryRun: z.boolean().default(false).describe("Preview actions without making changes"),
            noTemplate: z
                .boolean()
                .default(false)
                .describe("Skip checking for pre-generated templates"),
        }),
        execute: async (args) => {
            // Validate name
            const validation = validateSubdomainName(args.name);
            if (!validation.valid) {
                return `Error: Invalid name - ${validation.error}`;
            }
            const salesChannelName = validation.sanitized;
            const description = args.description || `${salesChannelName} webshop`;

            // Configure logger
            logger.configure({ enabled: true, verboseConsole: false });

            const cache = createCacheFromEnv();
            const results: string[] = [];
            results.push(`=== Shopware Data Generator ===`);
            results.push(`Name: ${salesChannelName}`);
            results.push(`Description: ${description}`);
            results.push(``);

            // Check for pre-generated template
            let usedTemplate = false;
            if (!args.noTemplate && !cache.hasHydratedBlueprint(salesChannelName)) {
                const templateFetcher = createTemplateFetcherFromEnv();
                usedTemplate = await templateFetcher.tryUseTemplate(salesChannelName, cache);
                if (usedTemplate) {
                    results.push(`Using pre-generated template for "${salesChannelName}"`);
                }
            }

            // Step 1: Create blueprint if not exists
            if (!usedTemplate && !cache.hasBlueprint(salesChannelName)) {
                results.push(`Step 1: Creating blueprint...`);
                const generator = new BlueprintGenerator({
                    totalProducts: args.products,
                    productsPerBranch: Math.ceil(args.products / 3),
                });
                const blueprint = generator.generateBlueprint(salesChannelName, description);
                cache.saveBlueprint(salesChannelName, blueprint);
                const categoryCount = countCategories(blueprint.categories);
                results.push(
                    `  Created ${categoryCount} categories, ${blueprint.products.length} products`
                );
            } else {
                results.push(`Step 1: Using existing blueprint`);
            }

            // Step 2: Hydrate blueprint if not exists
            if (!usedTemplate && !cache.hasHydratedBlueprint(salesChannelName)) {
                results.push(`Step 2: Hydrating blueprint with AI...`);
                const blueprint = cache.loadBlueprint(salesChannelName);
                if (!blueprint) {
                    return `Error: Failed to load blueprint`;
                }

                const { text: textProvider } = createProvidersFromEnv();

                // Get existing properties
                let existingProperties: ExistingProperty[] = [];
                try {
                    const hydrator = new DataHydrator();
                    const swEnvUrl = process.env.SW_ENV_URL;
                    if (swEnvUrl) {
                        await hydrator.authenticateWithClientCredentials(
                            swEnvUrl,
                            process.env.SW_CLIENT_ID,
                            process.env.SW_CLIENT_SECRET
                        );
                        existingProperties = await hydrator.getExistingPropertyGroups();
                    }
                } catch {
                    // Proceed without existing properties
                }

                const hydrator = new BlueprintHydrator(textProvider);
                const hydratedBlueprint = await hydrator.hydrate(blueprint, existingProperties);

                const collector = new PropertyCollector();
                const propertyGroups = collector.collectFromBlueprint(
                    hydratedBlueprint,
                    existingProperties
                );
                hydratedBlueprint.propertyGroups = propertyGroups;

                cache.saveHydratedBlueprint(salesChannelName, hydratedBlueprint);
                results.push(`  Hydrated with ${propertyGroups.length} property groups`);
            } else {
                results.push(`Step 2: Using existing hydrated blueprint`);
            }

            // Load hydrated blueprint
            const blueprint = cache.loadHydratedBlueprint(salesChannelName);
            if (!blueprint) {
                return `Error: Failed to load hydrated blueprint`;
            }

            // Validate and auto-fix
            const validationResult = validateBlueprint(blueprint, {
                autoFix: true,
                logFixes: false,
            });
            if (!validationResult.valid) {
                const issues = validationResult.issues.map((i) => `  - ${i.message}`).join("\n");
                return `Error: Blueprint validation failed:\n${issues}`;
            }
            if (validationResult.fixesApplied > 0) {
                cache.saveHydratedBlueprint(salesChannelName, blueprint);
            }

            // Step 3: Upload to Shopware
            results.push(`Step 3: Syncing to Shopware...`);
            const swEnvUrl = process.env.SW_ENV_URL;
            if (!swEnvUrl) {
                return `Error: SW_ENV_URL is required in environment`;
            }

            if (args.dryRun) {
                results.push(`  [DRY RUN] Would sync to ${swEnvUrl}`);
                results.push(``);
                results.push(`=== Dry Run Complete ===`);
                return results.join("\n");
            }

            const dataHydrator = new DataHydrator();
            await dataHydrator.authenticateWithClientCredentials(
                swEnvUrl,
                process.env.SW_CLIENT_ID,
                process.env.SW_CLIENT_SECRET
            );

            // Check if SalesChannel exists
            let salesChannel = await dataHydrator.findSalesChannelByName(salesChannelName);
            const isNewSalesChannel = !salesChannel;

            if (!salesChannel) {
                salesChannel = await dataHydrator.createSalesChannel({
                    name: salesChannelName,
                    description: blueprint.salesChannel.description,
                });
                results.push(`  Created SalesChannel: ${salesChannel.name}`);
            } else {
                results.push(`  Using existing SalesChannel: ${salesChannel.name}`);
            }

            // Sync categories
            const categoryIdMap = await syncCategories(
                dataHydrator,
                blueprint,
                salesChannel,
                isNewSalesChannel
            );
            results.push(`  Synced ${categoryIdMap.size} categories`);

            // Sync property groups
            await syncPropertyGroups(dataHydrator, blueprint);
            results.push(`  Synced ${blueprint.propertyGroups.length} property groups`);

            // Build property maps
            const propertyMaps = buildPropertyMaps(blueprint);
            syncPropertyIdsToBlueprint(blueprint, propertyMaps);
            cache.saveHydratedBlueprint(salesChannelName, blueprint);

            // Sync products
            await syncProducts(
                dataHydrator,
                blueprint,
                salesChannel,
                categoryIdMap,
                propertyMaps.propertyOptionMap
            );
            results.push(`  Synced ${blueprint.products.length} products`);

            // Run post-processors
            results.push(``);
            results.push(`Running post-processors...`);

            const adminClient = createShopwareAdminClient({
                baseURL: swEnvUrl,
                clientId: process.env.SW_CLIENT_ID,
                clientSecret: process.env.SW_CLIENT_SECRET,
            });
            const apiHelpers = createApiHelpers(adminClient, swEnvUrl, () =>
                dataHydrator.getAccessToken()
            );

            const { text: textProvider, image: imageProvider } = createProvidersFromEnv();

            const processorResults = await runProcessors(
                {
                    salesChannelId: salesChannel.id,
                    salesChannelName,
                    blueprint,
                    cache,
                    textProvider,
                    imageProvider,
                    shopwareUrl: swEnvUrl,
                    getAccessToken: () => dataHydrator.getAccessToken(),
                    api: apiHelpers,
                    options: DEFAULT_PROCESSOR_OPTIONS,
                },
                registry.getNames()
            );

            let totalProcessed = 0;
            let totalErrors = 0;
            for (const result of processorResults) {
                totalProcessed += result.processed;
                totalErrors += result.errors.length;
            }
            results.push(`  Processed: ${totalProcessed}, Errors: ${totalErrors}`);

            results.push(``);
            results.push(`=== Generation Complete ===`);
            results.push(`SalesChannel: ${salesChannelName}`);
            results.push(`Storefront: ${blueprint.salesChannel.baseUrl}`);

            return results.join("\n");
        },
    });

    // Get processor names for enum
    const processorNames = registry.getNames();

    // list_processors - Show available post-processors
    server.addTool({
        name: "list_processors",
        description: "List all available post-processors with their descriptions.",
        parameters: z.object({}),
        execute: async () => {
            const results: string[] = [];
            results.push("Available Post-Processors:");
            results.push("");

            for (const name of processorNames) {
                const processor = registry.get(name);
                if (processor) {
                    results.push(`  ${name}`);
                    results.push(`    ${processor.description}`);
                    if (processor.dependsOn.length > 0) {
                        results.push(`    Depends on: ${processor.dependsOn.join(", ")}`);
                    }
                    results.push("");
                }
            }

            results.push("Usage:");
            results.push("  process(name: 'store-name', processors: ['images', 'reviews'])");

            return results.join("\n");
        },
    });

    // process - Run post-processors on existing SalesChannel
    server.addTool({
        name: "process",
        description: `Run post-processors on an existing SalesChannel. Available processors: ${processorNames.join(", ")}. Use to add images, manufacturers, reviews, or variants after initial generation.`,
        parameters: z.object({
            name: z.string().describe("SalesChannel name (must exist in Shopware)"),
            processors: z
                .array(z.enum(processorNames as [string, ...string[]]))
                .optional()
                .describe("List of processors to run. If omitted, runs all processors."),
            dryRun: z.boolean().default(false).describe("Preview actions without making changes"),
        }),
        execute: async (args) => {
            // Validate name
            const validation = validateSubdomainName(args.name);
            if (!validation.valid) {
                return `Error: Invalid name - ${validation.error}`;
            }
            const salesChannelName = validation.sanitized;

            // Load hydrated blueprint
            const cache = createCacheFromEnv();
            const blueprint = cache.loadHydratedBlueprint(salesChannelName);

            if (!blueprint) {
                return `Error: No hydrated blueprint found for "${salesChannelName}"

Run generate first:
  generate(name: "${salesChannelName}", description: "Your store description")`;
            }

            // Get SalesChannel from Shopware
            const swEnvUrl = process.env.SW_ENV_URL;
            if (!swEnvUrl) {
                return `Error: SW_ENV_URL is required in environment`;
            }

            const dataHydrator = new DataHydrator();
            await dataHydrator.authenticateWithClientCredentials(
                swEnvUrl,
                process.env.SW_CLIENT_ID,
                process.env.SW_CLIENT_SECRET
            );

            const salesChannel = await dataHydrator.findSalesChannelByName(salesChannelName);
            if (!salesChannel) {
                return `Error: SalesChannel "${salesChannelName}" not found in Shopware

Run generate first to create it.`;
            }

            // Determine which processors to run
            const availableProcessors = registry.getNames();
            const selectedProcessors =
                args.processors && args.processors.length > 0
                    ? args.processors
                    : availableProcessors;

            const results: string[] = [];
            results.push(`=== Post-Processors ===`);
            results.push(`SalesChannel: ${salesChannelName}`);
            results.push(`Processors: ${selectedProcessors.join(", ")}`);
            if (args.dryRun) {
                results.push(`Mode: Dry run (no changes)`);
            }
            results.push(``);

            // Create API helpers
            const adminClient = createShopwareAdminClient({
                baseURL: swEnvUrl,
                clientId: process.env.SW_CLIENT_ID,
                clientSecret: process.env.SW_CLIENT_SECRET,
            });
            const apiHelpers = createApiHelpers(adminClient, swEnvUrl, () =>
                dataHydrator.getAccessToken()
            );

            const { text: textProvider, image: imageProvider } = createProvidersFromEnv();

            // Run processors
            const processorResults = await runProcessors(
                {
                    salesChannelId: salesChannel.id,
                    salesChannelName,
                    blueprint,
                    cache,
                    textProvider,
                    imageProvider,
                    shopwareUrl: swEnvUrl,
                    getAccessToken: () => dataHydrator.getAccessToken(),
                    api: apiHelpers,
                    options: {
                        ...DEFAULT_PROCESSOR_OPTIONS,
                        dryRun: args.dryRun,
                    },
                },
                selectedProcessors
            );

            // Summarize results
            for (const result of processorResults) {
                results.push(
                    `${result.name}: ${result.processed} processed, ${result.errors.length} errors`
                );
            }

            let totalProcessed = 0;
            let totalErrors = 0;
            for (const result of processorResults) {
                totalProcessed += result.processed;
                totalErrors += result.errors.length;
            }

            results.push(``);
            results.push(`=== Complete ===`);
            results.push(`Total processed: ${totalProcessed}`);
            results.push(`Total errors: ${totalErrors}`);

            return results.join("\n");
        },
    });
}
