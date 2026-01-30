/**
 * HTTP Server for Shopware Catalog Generator
 *
 * Provides REST API for generating products with background processing.
 * Each generation runs in the background and can be monitored via status endpoint.
 */

import { DataCache } from "./cache.js";
import { BlueprintGenerator, BlueprintHydrator } from "./generators/index.js";
import { DEFAULT_PROCESSOR_OPTIONS, registry, runProcessors } from "./post-processors/index.js";
import { createProvidersFromEnv } from "./providers/index.js";
import type { ProcessContext } from "./server/index.js";
import { processManager } from "./server/index.js";
import { createTemplateFetcherFromEnv } from "./templates/index.js";
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
import { PropertyCollector, validateSubdomainName } from "./utils/index.js";

const port = Number(process.env.SERVER_PORT) || 3000;

// =============================================================================
// Request/Response Helpers
// =============================================================================

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
    try {
        return (await request.json()) as Record<string, unknown>;
    } catch {
        return {};
    }
}

function jsonResponse(data: unknown, status = 200): Response {
    return Response.json(data, { status });
}

function errorResponse(error: string, status = 500): Response {
    return Response.json({ error }, { status });
}

// =============================================================================
// Generate Task
// =============================================================================

interface GenerateParams {
    envPath: string;
    salesChannel: string;
    description: string;
    productCount: number;
    shopwareUser: string;
    shopwarePassword: string;
    clearFirst: boolean;
    skipProcessors: boolean;
    skipTemplate: boolean;
}

/**
 * The actual generation task that runs in the background
 */
async function generateTask(params: GenerateParams, ctx: ProcessContext): Promise<unknown> {
    const { envPath, salesChannel, description, productCount, shopwareUser, shopwarePassword } =
        params;

    // Create instances per-request to avoid shared state
    const { text: textProvider } = createProvidersFromEnv();
    const cache = new DataCache({
        enabled: true,
        cacheDir: process.env.CACHE_DIR || "./generated",
        useCache: true,
        saveToCache: true,
    });

    // Clear cache if requested
    if (params.clearFirst) {
        cache.clearSalesChannel(salesChannel);
        ctx.log(`Cleared existing cache for "${salesChannel}"`);
    }

    // Create DataHydrator and authenticate
    ctx.log("Authenticating with Shopware...");
    ctx.setProgress("auth", 0, 1);

    const dataHydrator = new DataHydrator();
    const authSuccess = await dataHydrator.authenticateWithUserCredentials(
        envPath,
        shopwareUser,
        shopwarePassword
    );

    if (!authSuccess) {
        throw new Error("Authentication with Shopware failed");
    }
    ctx.log("Authentication successful");
    ctx.setProgress("auth", 1, 1);

    // Check for pre-generated template (unless skipTemplate is set or data already cached)
    let usedTemplate = false;
    if (!params.skipTemplate && !cache.hasHydratedBlueprint(salesChannel)) {
        ctx.log("Checking for pre-generated template...");
        const templateFetcher = createTemplateFetcherFromEnv();
        usedTemplate = await templateFetcher.tryUseTemplate(salesChannel, cache);
        if (usedTemplate) {
            ctx.log(`Using pre-generated template for "${salesChannel}"`);
        } else {
            ctx.log("No template found, will generate from scratch");
        }
    }

    // Phase 1: Blueprint
    ctx.setProgress("blueprint", 0, 2);

    if (!usedTemplate && !cache.hasBlueprint(salesChannel)) {
        ctx.log("Creating blueprint...");
        const generator = new BlueprintGenerator({
            totalProducts: productCount,
            productsPerBranch: Math.ceil(productCount / 3),
        });
        const blueprint = generator.generateBlueprint(salesChannel, description);
        cache.saveBlueprint(salesChannel, blueprint);
        ctx.log(`Blueprint created: ${blueprint.products.length} products`);
    } else if (usedTemplate) {
        ctx.log("Using template blueprint");
    } else {
        ctx.log("Using existing blueprint");
    }
    ctx.setProgress("blueprint", 1, 2);

    // Phase 2: Hydration
    if (!usedTemplate && !cache.hasHydratedBlueprint(salesChannel)) {
        ctx.log("Hydrating blueprint with AI...");
        const blueprint = cache.loadBlueprint(salesChannel);
        if (!blueprint) {
            throw new Error("Failed to load blueprint");
        }

        const existingProperties = await dataHydrator.getExistingPropertyGroups();
        ctx.log(`Found ${existingProperties.length} existing property groups`);

        const hydrator = new BlueprintHydrator(textProvider);
        const hydratedBlueprint = await hydrator.hydrate(blueprint, existingProperties);

        const collector = new PropertyCollector();
        const propertyGroups = collector.collectFromBlueprint(hydratedBlueprint, existingProperties);
        hydratedBlueprint.propertyGroups = propertyGroups;

        cache.saveHydratedBlueprint(salesChannel, hydratedBlueprint);
        ctx.log("Blueprint hydrated successfully");
    } else if (usedTemplate) {
        ctx.log("Using template hydrated blueprint");
    } else {
        ctx.log("Using existing hydrated blueprint");
    }
    ctx.setProgress("blueprint", 2, 2);

    // Phase 3: Upload
    ctx.log("Loading hydrated blueprint...");
    const hydratedBlueprint = cache.loadHydratedBlueprint(salesChannel);
    if (!hydratedBlueprint) {
        throw new Error("Failed to load hydrated blueprint");
    }

    ctx.setProgress("upload", 0, 4);

    // Create or find SalesChannel
    let salesChannelEntity = await dataHydrator.findSalesChannelByName(salesChannel);
    const isNew = !salesChannelEntity;

    if (!salesChannelEntity) {
        ctx.log("Creating SalesChannel...");
        salesChannelEntity = await dataHydrator.createSalesChannel({
            name: salesChannel,
            description: hydratedBlueprint.salesChannel.description,
        });
        ctx.log(`Created SalesChannel: ${salesChannelEntity.id}`);
    } else {
        ctx.log(`Using existing SalesChannel: ${salesChannelEntity.id}`);
    }
    ctx.setProgress("upload", 1, 4);

    // Sync categories
    ctx.log("Syncing categories...");
    const categoryIdMap = await syncCategories(
        dataHydrator,
        hydratedBlueprint,
        salesChannelEntity,
        isNew
    );
    ctx.log(`Synced ${categoryIdMap.size} categories`);
    ctx.setProgress("upload", 2, 4);

    // Sync property groups
    ctx.log("Syncing property groups...");
    await syncPropertyGroups(dataHydrator, hydratedBlueprint);
    ctx.setProgress("upload", 3, 4);

    // Sync products
    ctx.log("Syncing products...");
    const propertyMaps = buildPropertyMaps(hydratedBlueprint);
    syncPropertyIdsToBlueprint(hydratedBlueprint, propertyMaps);
    cache.saveHydratedBlueprint(salesChannel, hydratedBlueprint);

    await syncProducts(
        dataHydrator,
        hydratedBlueprint,
        salesChannelEntity,
        categoryIdMap,
        propertyMaps.propertyOptionMap
    );
    ctx.log(`Synced ${hydratedBlueprint.products.length} products`);
    ctx.setProgress("upload", 4, 4);

    // Phase 4: Post-processors (unless skipped)
    const processorResults: { name: string; processed: number; errors: string[] }[] = [];

    if (!params.skipProcessors) {
        const processorNames = registry.getNames();
        ctx.log(`Running post-processors: ${processorNames.join(", ")}`);
        ctx.setProgress("processors", 0, processorNames.length);

        // Get providers for processors
        const { text: textProvider, image: imageProvider } = createProvidersFromEnv();

        // Create API helpers for processors
        const adminClient = createShopwareAdminClient({
            baseURL: envPath,
            username: shopwareUser,
            password: shopwarePassword,
        });
        const apiHelpers = createApiHelpers(
            adminClient,
            envPath,
            () => dataHydrator.getAccessToken()
        );

        // Run all registered processors
        const results = await runProcessors(
            {
                salesChannelId: salesChannelEntity.id,
                salesChannelName: salesChannel,
                blueprint: hydratedBlueprint,
                cache,
                textProvider,
                imageProvider,
                shopwareUrl: envPath,
                getAccessToken: () => dataHydrator.getAccessToken(),
                api: apiHelpers,
                options: DEFAULT_PROCESSOR_OPTIONS,
            },
            processorNames
        );

        for (const result of results) {
            processorResults.push({
                name: result.name,
                processed: result.processed,
                errors: result.errors,
            });
            ctx.log(`  ${result.name}: ${result.processed} processed`);
        }
        ctx.setProgress("processors", processorNames.length, processorNames.length);
    } else {
        ctx.log("Skipping post-processors (skipProcessors=true)");
    }

    return {
        salesChannelId: salesChannelEntity.id,
        salesChannelName: salesChannel,
        categories: categoryIdMap.size,
        products: hydratedBlueprint.products.length,
        propertyGroups: hydratedBlueprint.propertyGroups.length,
        processors: processorResults,
    };
}

// =============================================================================
// Route Handlers
// =============================================================================

/** POST /generate - Start background generation */
async function handleGenerate(request: Request): Promise<Response> {
    const body = await parseJsonBody(request);

    const envPath = body.envPath as string | undefined;
    const salesChannelRaw = (body.salesChannel as string) || "demo-store";
    const productCount = (body.productCount as number) || 90;
    const shopwareUser = body.shopwareUser as string | undefined;
    const shopwarePassword = body.shopwarePassword as string | undefined;
    const cacheOptions = (body.cache as Record<string, unknown>) || {};
    const clearFirst = cacheOptions.clearFirst === true;
    const skipProcessors = body.skipProcessors === true;
    const skipTemplate = body.skipTemplate === true;

    // Validate required fields
    if (!envPath) {
        return errorResponse('Missing parameter "envPath"', 400);
    }
    if (!shopwareUser || !shopwarePassword) {
        return errorResponse("Missing shopwareUser or shopwarePassword", 400);
    }

    // Validate and sanitize salesChannel name
    const validation = validateSubdomainName(salesChannelRaw);
    if (!validation.valid) {
        return errorResponse(`Invalid salesChannel name: ${validation.error}`, 400);
    }
    const salesChannel = validation.sanitized;
    const description = (body.description as string) || `${salesChannel} webshop`;

    // Start background process
    const processId = processManager.start(`Generate ${salesChannel}`, async (ctx) => {
        return await generateTask(
            {
                envPath,
                salesChannel,
                description,
                productCount,
                shopwareUser,
                shopwarePassword,
                clearFirst,
                skipProcessors,
                skipTemplate,
            },
            ctx
        );
    });

    return jsonResponse({
        processId,
        message: "Generation started in background",
        salesChannel,
        statusUrl: `/status/${processId}`,
    });
}

/** GET /status/:id - Get process status and logs */
function handleStatus(processId: string, request: Request): Response {
    const state = processManager.get(processId);

    if (!state) {
        return errorResponse(`Process "${processId}" not found`, 404);
    }

    // Check for log offset query param
    const url = new URL(request.url);
    const fromIndex = parseInt(url.searchParams.get("from") || "0", 10);
    const logs = processManager.getLogs(processId, fromIndex);

    return jsonResponse({
        id: state.id,
        name: state.name,
        status: state.status,
        progress: state.progress,
        startedAt: state.startedAt.toISOString(),
        completedAt: state.completedAt?.toISOString(),
        logs,
        logCount: state.logs.length,
        result: state.status === "completed" ? state.result : undefined,
        error: state.status === "failed" ? state.error : undefined,
    });
}

/** GET /health - Health check */
function handleHealth(): Response {
    const stats = processManager.getStats();

    return jsonResponse({
        status: "ok",
        activeProcesses: stats.active,
        totalProcesses: stats.total,
        uptime: process.uptime(),
    });
}

// =============================================================================
// Main Server
// =============================================================================

const server = Bun.serve({
    port,
    async fetch(request) {
        const url = new URL(request.url);
        const { pathname } = url;
        const method = request.method;

        // POST /generate - Start background generation
        if (pathname === "/generate" && method === "POST") {
            return await handleGenerate(request);
        }

        // GET /status/:id - Get process status
        if (pathname.startsWith("/status/") && method === "GET") {
            const processId = decodeURIComponent(pathname.slice("/status/".length));
            if (processId) {
                return handleStatus(processId, request);
            }
        }

        // GET /health - Health check
        if (pathname === "/health" && method === "GET") {
            return handleHealth();
        }

        return new Response("Not Found", { status: 404 });
    },
});

console.log(`Server started on port ${server.port}`);
console.log(`Endpoints:`);
console.log(`  POST /generate     - Start generation (returns processId)`);
console.log(`  GET  /status/:id   - Get process status and logs`);
console.log(`  GET  /health       - Health check`);
