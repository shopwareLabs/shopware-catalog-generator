/**
 * Shopware Data Generator v2 - Main Entry Point
 *
 * Subcommand-based CLI:
 * - blueprint create  - Generate blueprint.json (no AI)
 * - blueprint hydrate - AI fills blueprint -> hydrated-blueprint.json
 * - generate          - Full flow: create + hydrate + upload to Shopware
 * - process           - Run post-processors on existing SalesChannel
 */

import { createCacheFromEnv } from "./cache.js";
import { BlueprintGenerator, BlueprintHydrator } from "./generators/index.js";
import { DEFAULT_PROCESSOR_OPTIONS, registry, runProcessors } from "./post-processors/index.js";
import { createProvidersFromEnv } from "./providers/index.js";
import {
    buildPropertyMaps,
    createApiHelpers,
    createShopwareAdminClient,
    DataHydrator,
    syncCategories,
    syncProducts,
    syncPropertyGroups,
    syncPropertyIdsToBlueprint,
} from "./shopware/index.js";
import type { ExistingProperty } from "./utils/index.js";
import {
    countCategories,
    logger,
    PropertyCollector,
    validateBlueprint,
    validateSubdomainName,
} from "./utils/index.js";

// =============================================================================
// CLI Argument Parsing
// =============================================================================

interface CliArgs {
    command: "blueprint" | "generate" | "process" | "help";
    subcommand?: "create" | "hydrate" | "fix";
    name?: string;
    description?: string;
    products?: number;
    interactive?: boolean;
    only?: string[];
    dryRun?: boolean;
}

function parseCliArgs(): CliArgs {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
        return { command: "help" };
    }

    const command = args[0] as CliArgs["command"];

    // Parse flags
    const flags: Record<string, string | boolean> = {};
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (!arg) continue;

        if (arg.startsWith("--")) {
            const parts = arg.slice(2).split("=");
            const key = parts[0] || "";
            const value = parts[1];
            if (key) {
                flags[key] = value ?? true;
            }
        } else if (arg.startsWith("-")) {
            const key = arg.slice(1);
            if (key) {
                flags[key] = true;
            }
        } else if (command === "blueprint" && !flags.subcommand) {
            flags.subcommand = arg;
        }
    }

    return {
        command,
        subcommand: flags.subcommand as CliArgs["subcommand"],
        name: flags.name as string | undefined,
        description: flags.description as string | undefined,
        products: flags.products ? parseInt(flags.products as string, 10) : undefined,
        interactive: flags.i === true || flags.interactive === true,
        only: flags.only ? (flags.only as string).split(",") : undefined,
        dryRun: flags["dry-run"] === true,
    };
}

function showHelp(): void {
    console.log(`
Shopware Data Generator v2

Usage:
  bun run src/main.ts <command> [options]

Commands:
  blueprint create   Generate blueprint.json (no AI calls)
  blueprint hydrate  Hydrate blueprint with AI -> hydrated-blueprint.json
  blueprint fix      Fix placeholder names in hydrated blueprint
  generate           Full flow: create + hydrate + upload to Shopware
  process            Run post-processors on existing SalesChannel

Options:
  --name=<name>         SalesChannel name (required for most commands)
  --description=<text>  Store description for AI generation
  --products=<n>        Number of products (default: 90)
  --only=<list>         Post-processors to run (comma-separated)
  --dry-run             Log actions without executing
  -i, --interactive     Run interactive wizard

Examples:
  bun run src/main.ts blueprint create --name=furniture --description="Wood furniture store"
  bun run src/main.ts blueprint hydrate --name=furniture
  bun run src/main.ts blueprint fix --name=furniture
  bun run src/main.ts generate --name=furniture --description="Wood furniture store"
  bun run src/main.ts process --name=furniture --only=images,manufacturers
`);
}

// =============================================================================
// Commands
// =============================================================================

async function blueprintCreate(args: CliArgs): Promise<void> {
    if (!args.name) {
        console.error("Error: --name is required");
        process.exit(1);
    }

    // Validate name
    const validation = validateSubdomainName(args.name);
    if (!validation.valid) {
        console.error(`Error: Invalid name: ${validation.error}`);
        process.exit(1);
    }
    const salesChannelName = validation.sanitized;

    const description = args.description || `${salesChannelName} webshop`;
    const products = args.products || 90;

    console.log(`\n=== Blueprint Create ===`);
    console.log(`Name: ${salesChannelName}`);
    console.log(`Description: ${description}`);
    console.log(`Products: ${products}`);
    console.log();

    // Create cache
    const cache = createCacheFromEnv();

    // Generate blueprint
    const generator = new BlueprintGenerator({
        totalProducts: products,
        productsPerBranch: Math.ceil(products / 3),
    });

    console.log("Generating blueprint...");
    const blueprint = generator.generateBlueprint(salesChannelName, description);

    // Save to cache
    cache.saveBlueprint(salesChannelName, blueprint);

    const categoryCount = countCategories(blueprint.categories);
    console.log(`\nBlueprint created:`);
    console.log(`  Categories: ${categoryCount}`);
    console.log(`  Products: ${blueprint.products.length}`);
    console.log(`  Saved to: generated/sales-channels/${salesChannelName}/blueprint.json`);
}

async function blueprintHydrate(args: CliArgs): Promise<void> {
    if (!args.name) {
        console.error("Error: --name is required");
        process.exit(1);
    }

    const validation = validateSubdomainName(args.name);
    if (!validation.valid) {
        console.error(`Error: Invalid name: ${validation.error}`);
        process.exit(1);
    }
    const salesChannelName = validation.sanitized;

    // Enable verbose logging for hydration
    logger.configure({ verboseConsole: true, minLevel: "debug" });
    console.log(`\n=== Blueprint Hydrate ===`);
    console.log(`Name: ${salesChannelName}`);
    console.log(`Log file: ${logger.getLogFile()}`);
    console.log();

    // Load blueprint
    const cache = createCacheFromEnv();
    const blueprint = cache.loadBlueprint(salesChannelName);

    if (!blueprint) {
        console.error(`Error: No blueprint found for "${salesChannelName}"`);
        console.error(`Run: bun run src/main.ts blueprint create --name=${salesChannelName}`);
        process.exit(1);
    }

    // Create providers
    const { text: textProvider } = createProvidersFromEnv();

    // Get existing properties from Shopware (if connected)
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
            console.log(`Found ${existingProperties.length} existing property groups in Shopware`);
        }
    } catch {
        console.log("Could not connect to Shopware, proceeding without existing properties");
    }

    // Hydrate blueprint
    const hydrator = new BlueprintHydrator(textProvider);
    const hydratedBlueprint = await hydrator.hydrate(blueprint, existingProperties);

    // Collect properties
    const collector = new PropertyCollector();
    const propertyGroups = collector.collectFromBlueprint(hydratedBlueprint, existingProperties);
    hydratedBlueprint.propertyGroups = propertyGroups;

    // Save hydrated blueprint
    cache.saveHydratedBlueprint(salesChannelName, hydratedBlueprint);

    console.log(`\nHydrated blueprint saved:`);
    console.log(`  Property groups: ${propertyGroups.length}`);
    console.log(`  Manufacturers: ${collector.collectManufacturers(hydratedBlueprint).length}`);
    console.log(`  Saved to: generated/sales-channels/${salesChannelName}/hydrated-blueprint.json`);
}

async function blueprintFix(args: CliArgs): Promise<void> {
    if (!args.name) {
        console.error("Error: --name is required");
        process.exit(1);
    }

    const salesChannelName = args.name;

    console.log(`\n=== Blueprint Fix ===`);
    console.log(`Name: ${salesChannelName}`);
    console.log();

    // Enable verbose logging
    logger.configure({ verboseConsole: true, minLevel: "debug" });

    // Create cache
    const cache = createCacheFromEnv();

    // Load hydrated blueprint
    const blueprint = cache.loadHydratedBlueprint(salesChannelName);
    if (!blueprint) {
        console.error(`Error: No hydrated blueprint found for "${salesChannelName}"`);
        console.error("Run 'blueprint hydrate' first.");
        process.exit(1);
    }

    // Create providers
    const { text: textProvider } = createProvidersFromEnv();
    console.log(`Text provider: ${textProvider.name} (sequential: ${textProvider.isSequential})`);
    console.log();

    // Create hydrator and fix placeholders
    const hydrator = new BlueprintHydrator(textProvider);

    // Find placeholders first (for reporting)
    const placeholderCategories = hydrator.findPlaceholderCategories(blueprint.categories);
    const placeholderProducts = hydrator.findPlaceholderProducts(blueprint.products);

    console.log(`Found ${placeholderCategories.length} placeholder categories:`);
    for (const cat of placeholderCategories) {
        console.log(`  - ${cat.name}`);
    }
    console.log(`Found ${placeholderProducts.length} placeholder products:`);
    for (const prod of placeholderProducts.slice(0, 10)) {
        console.log(`  - ${prod.name}`);
    }
    if (placeholderProducts.length > 10) {
        console.log(`  ... and ${placeholderProducts.length - 10} more`);
    }
    console.log();

    if (placeholderCategories.length === 0 && placeholderProducts.length === 0) {
        console.log("No placeholders to fix. Blueprint is complete.");
        return;
    }

    // Fix placeholders
    const fixedBlueprint = await hydrator.fixPlaceholders(blueprint);

    // Update property groups if products were fixed
    if (placeholderProducts.length > 0) {
        const collector = new PropertyCollector();
        // Convert blueprint property groups to ExistingProperty format for reuse
        const existingProperties: ExistingProperty[] = blueprint.propertyGroups.map((pg) => ({
            id: pg.id,
            name: pg.name,
            displayType: pg.displayType || "text",
            options: pg.options.map((o) => ({
                id: o.id,
                name: o.name,
                colorHexCode: o.colorHexCode,
            })),
        }));
        const propertyGroups = collector.collectFromBlueprint(fixedBlueprint, existingProperties);
        fixedBlueprint.propertyGroups = propertyGroups;
    }

    // Save fixed blueprint
    cache.saveHydratedBlueprint(salesChannelName, fixedBlueprint);

    console.log(`\nFixed blueprint saved:`);
    console.log(`  Categories fixed: ${placeholderCategories.length}`);
    console.log(`  Products fixed: ${placeholderProducts.length}`);
    console.log(`  Saved to: generated/sales-channels/${salesChannelName}/hydrated-blueprint.json`);
}

// =============================================================================
// Generate Command
// =============================================================================

async function generate(args: CliArgs): Promise<void> {
    if (!args.name) {
        console.error("Error: --name is required");
        process.exit(1);
    }

    const validation = validateSubdomainName(args.name);
    if (!validation.valid) {
        console.error(`Error: Invalid name: ${validation.error}`);
        process.exit(1);
    }
    const salesChannelName = validation.sanitized;
    const description = args.description || `${salesChannelName} webshop`;

    console.log(`\n=== Shopware Data Generator v2 ===`);
    console.log(`Name: ${salesChannelName}`);
    console.log(`Description: ${description}`);
    console.log();

    // Configure logger
    logger.configure({ enabled: true });
    console.log(`Log file: ${logger.getLogFile()}\n`);

    const cache = createCacheFromEnv();

    // Step 1: Create blueprint if not exists
    if (!cache.hasBlueprint(salesChannelName)) {
        console.log("Step 1: Creating blueprint...");
        await blueprintCreate({ ...args, name: salesChannelName, description });
    } else {
        console.log("Step 1: Using existing blueprint");
    }

    // Step 2: Hydrate blueprint if not exists
    if (!cache.hasHydratedBlueprint(salesChannelName)) {
        console.log("\nStep 2: Hydrating blueprint...");
        await blueprintHydrate({ ...args, name: salesChannelName });
    } else {
        console.log("Step 2: Using existing hydrated blueprint");
    }

    // Load hydrated blueprint
    const blueprint = cache.loadHydratedBlueprint(salesChannelName);
    if (!blueprint) {
        console.error("Error: Failed to load hydrated blueprint");
        process.exit(1);
    }

    // Validate and auto-fix blueprint issues
    const validationResult = validateBlueprint(blueprint, { autoFix: true, logFixes: true });
    if (!validationResult.valid) {
        console.error("\nBlueprint validation failed:");
        for (const issue of validationResult.issues) {
            console.error(`  ${issue.type === "error" ? "✗" : "⚠"} ${issue.message}`);
        }
        process.exit(1);
    }
    if (validationResult.fixesApplied > 0) {
        // Save the fixed blueprint
        cache.saveHydratedBlueprint(salesChannelName, blueprint);
        console.log(`  Saved fixed blueprint`);
    }

    // Step 3: Upload to Shopware
    console.log("\nStep 3: Syncing to Shopware...");
    const swEnvUrl = process.env.SW_ENV_URL;
    if (!swEnvUrl) {
        console.error("Error: SW_ENV_URL is required");
        process.exit(1);
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
        // Create SalesChannel
        salesChannel = await dataHydrator.createSalesChannel({
            name: salesChannelName,
            description: blueprint.salesChannel.description,
        });
        console.log(`  Created SalesChannel: ${salesChannel.name} (${salesChannel.id})`);
    } else {
        console.log(`  Using existing SalesChannel: ${salesChannel.name} (${salesChannel.id})`);
    }

    // Sync categories (idempotent - works for both new and existing)
    const categoryIdMap = await syncCategories(
        dataHydrator,
        blueprint,
        salesChannel,
        isNewSalesChannel
    );

    // Sync property groups (idempotent)
    await syncPropertyGroups(dataHydrator, blueprint);

    // Build property maps for product creation
    const propertyMaps = buildPropertyMaps(blueprint);

    // Sync IDs back to product properties in the blueprint
    syncPropertyIdsToBlueprint(blueprint, propertyMaps);

    // Save updated blueprint with synced IDs
    cache.saveHydratedBlueprint(salesChannelName, blueprint);
    console.log(`  Synced property IDs to blueprint`);

    // Sync products (idempotent)
    await syncProducts(
        dataHydrator,
        blueprint,
        salesChannel,
        categoryIdMap,
        propertyMaps.propertyOptionMap
    );

    console.log(`\n=== Generation Complete ===`);
    console.log(`SalesChannel: ${salesChannelName}`);
    console.log(`Storefront: ${blueprint.salesChannel.baseUrl}`);
    console.log();
}

async function processCommand(args: CliArgs): Promise<void> {
    if (!args.name) {
        console.error("Error: --name is required");
        process.exit(1);
    }

    const validation = validateSubdomainName(args.name);
    if (!validation.valid) {
        console.error(`Error: Invalid name: ${validation.error}`);
        process.exit(1);
    }
    const salesChannelName = validation.sanitized;

    console.log(`\n=== Post-Processors ===`);
    console.log(`Name: ${salesChannelName}`);
    console.log();

    // Load hydrated blueprint
    const cache = createCacheFromEnv();
    const blueprint = cache.loadHydratedBlueprint(salesChannelName);

    if (!blueprint) {
        console.error(`Error: No hydrated blueprint found for "${salesChannelName}"`);
        console.error(`Run: bun run src/main.ts generate --name=${salesChannelName}`);
        process.exit(1);
    }

    // Get SalesChannel from Shopware
    const swEnvUrl = process.env.SW_ENV_URL;
    if (!swEnvUrl) {
        console.error("Error: SW_ENV_URL is required");
        process.exit(1);
    }

    const dataHydrator = new DataHydrator();
    await dataHydrator.authenticateWithClientCredentials(
        swEnvUrl,
        process.env.SW_CLIENT_ID,
        process.env.SW_CLIENT_SECRET
    );

    const salesChannel = await dataHydrator.findSalesChannelByName(salesChannelName);
    if (!salesChannel) {
        console.error(`Error: SalesChannel "${salesChannelName}" not found in Shopware`);
        console.error(`Run: bun run src/main.ts generate --name=${salesChannelName}`);
        process.exit(1);
    }

    // Create API helpers using official client
    const adminClient = createShopwareAdminClient({
        baseURL: swEnvUrl,
        clientId: process.env.SW_CLIENT_ID,
        clientSecret: process.env.SW_CLIENT_SECRET,
    });
    const apiHelpers = createApiHelpers(adminClient, swEnvUrl, () => dataHydrator.getAccessToken());

    // Create providers
    const { text: textProvider, image: imageProvider } = createProvidersFromEnv();

    // Determine which processors to run
    const availableProcessors = registry.getNames();
    const selectedProcessors = args.only || availableProcessors;

    // Validate selected processors
    for (const name of selectedProcessors) {
        if (!registry.has(name)) {
            console.error(`Error: Unknown processor "${name}"`);
            console.error(`Available: ${availableProcessors.join(", ")}`);
            process.exit(1);
        }
    }

    console.log(`Running processors: ${selectedProcessors.join(", ")}`);
    if (args.dryRun) {
        console.log("(Dry run mode - no changes will be made)\n");
    }
    console.log();

    // Run processors
    const results = await runProcessors(
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
                dryRun: args.dryRun || false,
            },
        },
        selectedProcessors
    );

    // Summary
    console.log(`\n=== Post-Processing Complete ===`);
    let totalProcessed = 0;
    let totalErrors = 0;
    for (const result of results) {
        totalProcessed += result.processed;
        totalErrors += result.errors.length;
    }
    console.log(`Processed: ${totalProcessed}`);
    console.log(`Errors: ${totalErrors}`);
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
    const args = parseCliArgs();

    try {
        switch (args.command) {
            case "blueprint":
                if (args.subcommand === "create") {
                    await blueprintCreate(args);
                } else if (args.subcommand === "hydrate") {
                    await blueprintHydrate(args);
                } else if (args.subcommand === "fix") {
                    await blueprintFix(args);
                } else {
                    console.error("Error: blueprint requires subcommand: create, hydrate, or fix");
                    showHelp();
                    process.exit(1);
                }
                break;

            case "generate":
                await generate(args);
                break;

            case "process":
                await processCommand(args);
                break;

            default:
                showHelp();
                break;
        }
    } catch (error) {
        console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

main();
