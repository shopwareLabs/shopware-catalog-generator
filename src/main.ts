/**
 * Shopware Data Generator v2 - Main Entry Point
 *
 * Subcommand-based CLI:
 * - blueprint create  - Generate blueprint.json (no AI)
 * - blueprint hydrate - AI fills blueprint -> hydrated-blueprint.json
 * - generate          - Full flow: create + hydrate + upload to Shopware
 * - process           - Run post-processors on existing SalesChannel
 */

import type { DataCache } from "./cache.js";
import type { HydratedBlueprint } from "./types/index.js";
import type { ExistingProperty } from "./utils/index.js";

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
import { createTemplateFetcherFromEnv } from "./templates/index.js";
import {
    countCategories,
    logger,
    PropertyCollector,
    validateBlueprint,
    validateSubdomainName,
} from "./utils/index.js";

// =============================================================================
// CLI Error Handling
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

// =============================================================================
// Shared Helper: Run Post-Processors
// =============================================================================

interface RunProcessorsParams {
    salesChannelId: string;
    salesChannelName: string;
    blueprint: HydratedBlueprint;
    cache: DataCache;
    swEnvUrl: string;
    getAccessToken: () => Promise<string>;
    processors?: string[];
    dryRun?: boolean;
}

interface ProcessorsSummary {
    totalProcessed: number;
    totalErrors: number;
}

/**
 * Run post-processors with shared setup logic.
 * Extracted to avoid duplication between generate and process commands.
 */
async function executePostProcessors(params: RunProcessorsParams): Promise<ProcessorsSummary> {
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

    // Create API helpers using official client
    const adminClient = createShopwareAdminClient({
        baseURL: swEnvUrl,
        clientId: process.env.SW_CLIENT_ID,
        clientSecret: process.env.SW_CLIENT_SECRET,
    });
    const apiHelpers = createApiHelpers(adminClient, swEnvUrl, getAccessToken);

    // Create providers
    const { text: textProvider, image: imageProvider } = createProvidersFromEnv();

    // Determine which processors to run
    const availableProcessors = registry.getNames();
    const selectedProcessors = processors || availableProcessors;

    // Validate selected processors
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

    // Run processors
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

    // Calculate summary
    let totalProcessed = 0;
    let totalErrors = 0;
    for (const result of results) {
        totalProcessed += result.processed;
        totalErrors += result.errors.length;
    }

    return { totalProcessed, totalErrors };
}

// =============================================================================
// CLI Argument Parsing
// =============================================================================

interface CliArgs {
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
        } else if ((command === "blueprint" || command === "image") && !flags.subcommand) {
            flags.subcommand = arg;
        }
    }

    return {
        command,
        subcommand: flags.subcommand as CliArgs["subcommand"],
        name: flags.name as string | undefined,
        description: flags.description as string | undefined,
        products: flags.products ? parseInt(flags.products as string, 10) : undefined,
        product: flags.product as string | undefined,
        interactive: flags.i === true || flags.interactive === true,
        only: flags.only ? (flags.only as string).split(",") : undefined,
        dryRun: flags["dry-run"] === true,
        noTemplate: flags["no-template"] === true,
        force: flags.force === true,
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
  image fix          Regenerate images for a specific product

Options:
  --name=<name>         SalesChannel name (required for most commands)
  --description=<text>  Store description for AI generation
  --products=<n>        Number of products (default: 90)
  --product=<name>      Product name or ID (for image fix)
  --only=<list>         Comma-separated list:
                        - For 'process': processor names (images, manufacturers, etc.)
                        - For 'blueprint hydrate': categories or properties
  --force               Force full re-hydration (overwrites existing, changes product names)
  --dry-run             Log actions without executing
  --no-template         Skip checking for pre-generated templates
  -i, --interactive     Run interactive wizard

Examples:
  bun run src/main.ts blueprint create --name=furniture --description="Wood furniture store"
  bun run src/main.ts blueprint hydrate --name=furniture
  bun run src/main.ts blueprint hydrate --name=furniture --only=categories  # Categories only
  bun run src/main.ts blueprint hydrate --name=furniture --only=properties  # Properties only
  bun run src/main.ts blueprint hydrate --name=furniture --force            # Full re-hydration
  bun run src/main.ts blueprint fix --name=furniture
  bun run src/main.ts generate --name=furniture --description="Wood furniture store"
  bun run src/main.ts process --name=furniture --only=images,manufacturers
  bun run src/main.ts image fix --name=beauty --product="Eyelash Curler - Silver"
`);
}

// =============================================================================
// Shared Validation Helpers
// =============================================================================

/**
 * Validate and sanitize the SalesChannel name from CLI args.
 * Exits with error if name is missing or invalid.
 *
 * @param args - CLI arguments
 * @returns Sanitized sales channel name
 */
function requireValidName(args: CliArgs): string {
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
 * Exits with error if blueprint is not found.
 *
 * @param cache - Data cache instance
 * @param salesChannelName - Sales channel name
 * @returns Hydrated blueprint
 */
function requireHydratedBlueprint(cache: DataCache, salesChannelName: string): HydratedBlueprint {
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
// Commands
// =============================================================================

async function blueprintCreate(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);
    const description = args.description || `${salesChannelName} webshop`;
    const products = args.products || 90;

    // Products per category can be configured via env (default: 30)
    const maxProductsPerBranch = parseInt(process.env.PRODUCTS_PER_CATEGORY || "30", 10);
    const topLevelCategories = Math.max(1, Math.ceil(products / maxProductsPerBranch));
    // Distribute products evenly across categories
    const productsPerBranch = Math.ceil(products / topLevelCategories);

    console.log(`\n=== Blueprint Create ===`);
    console.log(`Name: ${salesChannelName}`);
    console.log(`Description: ${description}`);
    console.log(`Products: ${products} (${topLevelCategories} categories)`);
    console.log();

    // Create cache
    const cache = createCacheFromEnv();

    // Generate blueprint
    const generator = new BlueprintGenerator({
        totalProducts: products,
        topLevelCategories,
        productsPerBranch,
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
    const salesChannelName = requireValidName(args);

    // Determine hydration mode
    const hydrateOnly = args.only?.[0] as "categories" | "properties" | undefined;
    const forceHydration = args.force === true;

    // Validate --only value
    if (hydrateOnly && hydrateOnly !== "categories" && hydrateOnly !== "properties") {
        throw new CLIError(
            `--only must be 'categories' or 'properties' for blueprint hydrate (got: ${hydrateOnly})`,
            "INVALID_OPTION"
        );
    }

    // Enable verbose logging for hydration
    logger.configure({ minLevel: "debug" });
    console.log(`\n=== Blueprint Hydrate ===`);
    console.log(`Name: ${salesChannelName}`);
    if (hydrateOnly) {
        console.log(
            `Mode: ${hydrateOnly} only (preserving ${hydrateOnly === "categories" ? "products" : "product names"})`
        );
    } else if (forceHydration) {
        console.log(`Mode: full (--force)`);
    }
    console.log(`Log file: ${logger.getLogFile()}`);
    console.log();

    // Load cache
    const cache = createCacheFromEnv();

    // Check if hydrated blueprint exists
    const existingHydratedBlueprint = cache.loadHydratedBlueprint(salesChannelName);

    if (existingHydratedBlueprint && !hydrateOnly && !forceHydration) {
        throw new CLIError(
            `Hydrated blueprint already exists for "${salesChannelName}". ` +
                `Re-hydrating will change product names and trigger image regeneration. ` +
                `Use --only=categories, --only=properties, or --force.`,
            "BLUEPRINT_EXISTS"
        );
    }

    // Load base blueprint
    const blueprint = cache.loadBlueprint(salesChannelName);
    if (!blueprint) {
        throw new CLIError(
            `No blueprint found for "${salesChannelName}". ` +
                `Run: bun run src/main.ts blueprint create --name=${salesChannelName}`,
            "BLUEPRINT_NOT_FOUND"
        );
    }

    // Create providers
    const { text: textProvider } = createProvidersFromEnv();

    // Get existing properties from Shopware (if connected)
    let existingProperties: ExistingProperty[] = [];
    try {
        const dataHydrator = new DataHydrator();
        const swEnvUrl = process.env.SW_ENV_URL;
        if (swEnvUrl) {
            await dataHydrator.authenticateWithClientCredentials(
                swEnvUrl,
                process.env.SW_CLIENT_ID,
                process.env.SW_CLIENT_SECRET
            );
            existingProperties = await dataHydrator.getExistingPropertyGroups();
            console.log(`Found ${existingProperties.length} existing property groups in Shopware`);
        }
    } catch {
        console.log("Could not connect to Shopware, proceeding without existing properties");
    }

    // Create hydrator
    const hydrator = new BlueprintHydrator(textProvider);
    let hydratedBlueprint: HydratedBlueprint;

    // Execute hydration based on mode
    if (hydrateOnly === "categories" && existingHydratedBlueprint) {
        // Categories-only mode
        hydratedBlueprint = await hydrator.hydrateCategoriesOnly(existingHydratedBlueprint);
    } else if (hydrateOnly === "properties" && existingHydratedBlueprint) {
        // Properties-only mode
        hydratedBlueprint = await hydrator.hydratePropertiesOnly(
            existingHydratedBlueprint,
            existingProperties
        );
    } else {
        // Full hydration (new or --force)
        hydratedBlueprint = await hydrator.hydrate(blueprint, existingProperties);
    }

    // Collect properties (for full and properties-only modes)
    const collector = new PropertyCollector();
    const propertyGroups = collector.collectFromBlueprint(hydratedBlueprint, existingProperties);
    hydratedBlueprint.propertyGroups = propertyGroups;

    // Save hydrated blueprint
    cache.saveHydratedBlueprint(salesChannelName, hydratedBlueprint);

    console.log(`\nHydrated blueprint saved:`);
    console.log(`  Mode: ${hydrateOnly || "full"}`);
    console.log(`  Property groups: ${propertyGroups.length}`);
    console.log(`  Manufacturers: ${collector.collectManufacturers(hydratedBlueprint).length}`);
    console.log(`  Saved to: generated/sales-channels/${salesChannelName}/hydrated-blueprint.json`);
}

async function blueprintFix(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);

    console.log(`\n=== Blueprint Fix ===`);
    console.log(`Name: ${salesChannelName}`);
    console.log();

    // Enable verbose logging
    logger.configure({ minLevel: "debug" });

    // Create cache
    const cache = createCacheFromEnv();

    // Load hydrated blueprint
    const blueprint = requireHydratedBlueprint(cache, salesChannelName);

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
    const salesChannelName = requireValidName(args);
    const description = args.description || `${salesChannelName} webshop`;

    console.log(`\n=== Shopware Data Generator v2 ===`);
    console.log(`Name: ${salesChannelName}`);
    console.log(`Description: ${description}`);
    console.log();

    // Configure logger
    logger.configure({ enabled: true });
    console.log(`Log file: ${logger.getLogFile()}\n`);

    const cache = createCacheFromEnv();

    // Check for pre-generated template (unless --no-template is set or data already cached)
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

    // Step 1: Create blueprint if not exists (skip if template was used)
    if (!usedTemplate && !cache.hasBlueprint(salesChannelName)) {
        console.log("Step 1: Creating blueprint...");
        await blueprintCreate({ ...args, name: salesChannelName, description });
    } else if (usedTemplate) {
        console.log("Step 1: Using template blueprint");
    } else {
        console.log("Step 1: Using existing blueprint");
    }

    // Step 2: Hydrate blueprint if not exists (skip if template was used)
    if (!usedTemplate && !cache.hasHydratedBlueprint(salesChannelName)) {
        console.log("\nStep 2: Hydrating blueprint...");
        await blueprintHydrate({ ...args, name: salesChannelName });
    } else if (usedTemplate) {
        console.log("Step 2: Using template hydrated blueprint");
    } else {
        console.log("Step 2: Using existing hydrated blueprint");
    }

    // Load hydrated blueprint
    const blueprint = cache.loadHydratedBlueprint(salesChannelName);
    if (!blueprint) {
        throw new CLIError("Failed to load hydrated blueprint", "BLUEPRINT_LOAD_FAILED");
    }

    // Validate and auto-fix blueprint issues
    const validationResult = validateBlueprint(blueprint, { autoFix: true, logFixes: true });
    if (!validationResult.valid) {
        const issueMessages = validationResult.issues
            .map((issue) => `${issue.type === "error" ? "✗" : "⚠"} ${issue.message}`)
            .join("; ");
        throw new CLIError(`Blueprint validation failed: ${issueMessages}`, "VALIDATION_FAILED");
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
        throw new CLIError("SW_ENV_URL environment variable is required", "MISSING_ENV");
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

    console.log(`\n=== Sync Complete ===`);

    // Run post-processors
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

async function processCommand(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);

    console.log(`\n=== Post-Processors ===`);
    console.log(`Name: ${salesChannelName}`);
    console.log();

    // Load hydrated blueprint
    const cache = createCacheFromEnv();
    const blueprint = requireHydratedBlueprint(cache, salesChannelName);

    // Get SalesChannel from Shopware
    const swEnvUrl = process.env.SW_ENV_URL;
    if (!swEnvUrl) {
        throw new CLIError("SW_ENV_URL environment variable is required", "MISSING_ENV");
    }

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

// =============================================================================
// Image Fix Command
// =============================================================================

async function imageFixCommand(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);

    if (!args.product) {
        throw new CLIError("--product is required (product name or ID)", "MISSING_ARG");
    }

    console.log(`\n=== Image Fix ===`);
    console.log(`SalesChannel: ${salesChannelName}`);
    console.log(`Product: ${args.product}`);
    console.log();

    // Load hydrated blueprint
    const cache = createCacheFromEnv();
    const blueprint = requireHydratedBlueprint(cache, salesChannelName);

    // Find the product in blueprint (by name or ID)
    const searchTerm = args.product.toLowerCase();
    const product = blueprint.products.find(
        (p) => p.id === args.product || p.name.toLowerCase().includes(searchTerm)
    );

    if (!product) {
        const availableProducts = blueprint.products
            .slice(0, 10)
            .map((p) => p.name)
            .join(", ");
        throw new CLIError(
            `Product "${args.product}" not found in blueprint. Available: ${availableProducts}...`,
            "PRODUCT_NOT_FOUND"
        );
    }

    console.log(`Found product: ${product.name} (${product.id})`);

    const imageDescriptions = product.metadata.imageDescriptions;
    if (imageDescriptions.length === 0) {
        throw new CLIError(
            "Product has no image descriptions in metadata",
            "NO_IMAGE_DESCRIPTIONS"
        );
    }

    console.log(`Images to generate: ${imageDescriptions.length}`);
    for (const desc of imageDescriptions) {
        console.log(`  - ${desc.view}: ${desc.prompt.substring(0, 50)}...`);
    }
    console.log();

    if (args.dryRun) {
        console.log("[DRY RUN] Would generate and upload images");
        return;
    }

    // Create providers
    const { image: imageProvider } = createProvidersFromEnv();

    // Generate and cache images
    for (const desc of imageDescriptions) {
        console.log(`Generating ${desc.view} image...`);

        // Delete existing cached image if any
        cache.deleteImageWithView(salesChannelName, product.id, desc.view);

        const imageData = await imageProvider.generateImage(desc.prompt);
        if (!imageData) {
            console.error(`  ✗ Failed to generate ${desc.view} image`);
            continue;
        }

        cache.saveImageWithView(salesChannelName, product.id, desc.view, imageData, desc.prompt);
        console.log(`  ✓ Generated and cached ${desc.view} image`);
    }

    // Upload to Shopware
    console.log(`\nUploading to Shopware...`);

    const swEnvUrl = process.env.SW_ENV_URL;
    if (!swEnvUrl) {
        throw new CLIError("SW_ENV_URL environment variable is required", "MISSING_ENV");
    }

    const dataHydrator = new DataHydrator();
    await dataHydrator.authenticateWithClientCredentials(
        swEnvUrl,
        process.env.SW_CLIENT_ID,
        process.env.SW_CLIENT_SECRET
    );

    const salesChannel = await dataHydrator.findSalesChannelByName(salesChannelName);
    if (!salesChannel) {
        throw new CLIError(
            `SalesChannel "${salesChannelName}" not found in Shopware`,
            "SALESCHANNEL_NOT_FOUND"
        );
    }

    // Create a filtered blueprint with just this product for the image processor
    const filteredBlueprint: HydratedBlueprint = {
        ...blueprint,
        products: [product],
    };

    // Run only the image processor
    const { totalProcessed, totalErrors } = await executePostProcessors({
        salesChannelId: salesChannel.id,
        salesChannelName,
        blueprint: filteredBlueprint,
        cache,
        swEnvUrl,
        getAccessToken: () => dataHydrator.getAccessToken(),
        processors: ["images"],
        dryRun: false,
    });

    console.log(`\n=== Image Fix Complete ===`);
    console.log(`Product: ${product.name}`);
    console.log(`Processed: ${totalProcessed}, Errors: ${totalErrors}`);
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
                    showHelp();
                    throw new CLIError(
                        "blueprint requires subcommand: create, hydrate, or fix",
                        "MISSING_SUBCOMMAND"
                    );
                }
                break;

            case "generate":
                await generate(args);
                break;

            case "process":
                await processCommand(args);
                break;

            case "image":
                if (args.subcommand === "fix") {
                    await imageFixCommand(args);
                } else {
                    showHelp();
                    throw new CLIError("image requires subcommand: fix", "MISSING_SUBCOMMAND");
                }
                break;

            default:
                showHelp();
                break;
        }
    } catch (error) {
        if (error instanceof CLIError) {
            console.error(`\nError [${error.code}]: ${error.message}`);
            process.exit(error.exitCode);
        }
        console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

main();
