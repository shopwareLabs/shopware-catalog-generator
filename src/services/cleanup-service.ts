/**
 * Cleanup service - delete generated data from Shopware, shared by the cleanup CLI and MCP tools.
 *
 * Every function returns output lines; a line starting with "Error:" marks a failure.
 * Dry run never deletes anything: processor cleanups get dryRun=true and the core cleanup
 * (products, categories, SalesChannel) only lists what it would delete.
 */

import fs from "node:fs";

import type { DataCache } from "../cache.js";
import type { PostProcessorCleanupResult } from "../post-processors/index.js";
import type { HydratedBlueprint } from "../types/index.js";

import { createCacheFromEnv } from "../cache.js";
import {
    cleanupProcessors,
    DEFAULT_PROCESSOR_OPTIONS,
    registry,
} from "../post-processors/index.js";
import { detectShopwareCapabilities } from "../shopware/index.js";
import {
    connectShopware,
    createProcessorDepsForConnection,
    shopwareConnectionFromEnv,
} from "./shopware-context.js";

type Env = Record<string, string | undefined>;

export interface CoreCleanupOptions {
    deletePropertyGroups: boolean;
    deleteSalesChannel: boolean;
}

export interface CoreCleanupResult {
    products: number;
    categories: number;
    propertyGroups: number;
    salesChannelDeleted: boolean;
    rootCategoryDeleted: boolean;
    errors: string[];
}

/** The Shopware operations cleanup needs (a fake in tests) */
export interface CleanupShopware {
    readonly url: string;
    findSalesChannelId(name: string): Promise<string | null>;
    cleanupProcessors(
        salesChannelName: string,
        salesChannelId: string,
        processors: string[],
        dryRun: boolean
    ): Promise<PostProcessorCleanupResult[]>;
    cleanupCore(salesChannelName: string, options: CoreCleanupOptions): Promise<CoreCleanupResult>;
    /** Delete these products if they exist, with or without a SalesChannel */
    deleteProductsByIds(productIds: string[]): Promise<number>;
    deleteUnusedPropertyGroups(dryRun: boolean): Promise<number>;
    deleteUnusedPropertyOptions(dryRun: boolean): Promise<number>;
    deleteOrphanedProductMedia(dryRun: boolean): Promise<number>;
}

export interface CleanupDeps {
    /** Connect to Shopware; throws when the connection is missing or rejected */
    connect: () => Promise<CleanupShopware>;
    cache: DataCache;
}

export interface SalesChannelCleanupOptions {
    salesChannel: string;
    deleteSalesChannel: boolean;
    deleteProps: boolean;
    /** Processor names, or "all" for every processor */
    processors: string[];
    /** All processor cleanups, then the core cleanup */
    full: boolean;
    dryRun: boolean;
}

export type GlobalCleanupTarget = "unused-props" | "unused-options" | "orphaned-media";

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

function emptyBlueprint(salesChannelName: string): HydratedBlueprint {
    const now = new Date().toISOString();
    return {
        version: "1.0",
        salesChannel: { name: salesChannelName, description: "" },
        categories: [],
        products: [],
        propertyGroups: [],
        createdAt: now,
        hydratedAt: now,
    };
}

/** Connect with SW_ENV_URL / SW_CLIENT_ID / SW_CLIENT_SECRET */
async function connectCleanupFromEnv(env: Env, cache: DataCache): Promise<CleanupShopware> {
    const connection = shopwareConnectionFromEnv(env);
    if (!connection) throw new Error("SW_ENV_URL environment variable is required");
    const hydrator = await connectShopware(connection);
    const { apiHelpers } = createProcessorDepsForConnection(connection, hydrator, {
        skipProviders: true,
    });

    return {
        url: connection.url,
        // By name only: getStandardSalesChannel falls back to the Storefront channel,
        // which must never be cleaned up by accident
        findSalesChannelId: async (name) =>
            (await hydrator.findSalesChannelByName(name))?.id ?? null,
        cleanupProcessors: async (salesChannelName, salesChannelId, processors, dryRun) =>
            cleanupProcessors(
                {
                    salesChannelId,
                    salesChannelName,
                    // Processor cleanup works without a blueprint (it searches Shopware)
                    blueprint:
                        cache.loadHydratedBlueprint(salesChannelName) ??
                        emptyBlueprint(salesChannelName),
                    cache,
                    api: apiHelpers,
                    shopware: await detectShopwareCapabilities(apiHelpers),
                    options: { ...DEFAULT_PROCESSOR_OPTIONS, dryRun },
                },
                processors
            ),
        cleanupCore: (salesChannelName, options) =>
            hydrator.cleanupSalesChannel(salesChannelName, {
                ...options,
                // Manufacturers belong to the manufacturers processor
                deleteManufacturers: false,
            }),
        deleteProductsByIds: (productIds) => hydrator.deleteProductsByIds(productIds),
        deleteUnusedPropertyGroups: (dryRun) => hydrator.deleteUnusedPropertyGroups(dryRun),
        deleteUnusedPropertyOptions: (dryRun) => hydrator.deleteUnusedPropertyOptions(dryRun),
        deleteOrphanedProductMedia: (dryRun) => hydrator.deleteOrphanedProductMedia(dryRun),
    };
}

/** Default deps from the environment (CLI and MCP) */
export function cleanupDepsFromEnv(env: Env = process.env): CleanupDeps {
    const cache = createCacheFromEnv(env);
    return { cache, connect: () => connectCleanupFromEnv(env, cache) };
}

async function connectOrError(
    deps: CleanupDeps
): Promise<{ shopware: CleanupShopware } | { error: string }> {
    try {
        return { shopware: await deps.connect() };
    } catch (error) {
        return { error: `Error: ${errorMessage(error)}` };
    }
}

/** Processors to clean up: "all" and full expand to every processor */
export function resolveCleanupProcessors(processors: string[], full: boolean): string[] {
    if (full || processors.includes("all")) return registry.getNames();
    return processors;
}

function cleanableProcessorNames(): string[] {
    return registry
        .getAll()
        .filter((processor) => typeof processor.cleanup === "function")
        .map((processor) => processor.name);
}

/** Delete the data of one SalesChannel (processor entities and/or products and categories) */
export async function cleanupSalesChannelData(
    options: SalesChannelCleanupOptions,
    deps: CleanupDeps = cleanupDepsFromEnv()
): Promise<string[]> {
    const { salesChannel, dryRun } = options;
    const processors = resolveCleanupProcessors(options.processors, options.full);
    const unknown = processors.filter((name) => !registry.has(name));
    if (unknown.length > 0) {
        return [
            `Error: Unknown processor(s): ${unknown.join(", ")}. ` +
                `Available: all, ${registry.getNames().join(", ")}`,
        ];
    }
    const runCore = processors.length === 0 || options.full;

    const connected = await connectOrError(deps);
    if ("error" in connected) return [connected.error];
    const { shopware } = connected;

    const lines = [
        "=== Shopware Cleanup ===",
        `Environment: ${shopware.url}`,
        `SalesChannel: ${salesChannel}`,
        ...(dryRun ? ["[DRY RUN] Preview mode - no changes will be made"] : []),
        "",
    ];

    if (processors.length > 0) {
        lines.push(...(await cleanupProcessorEntities(shopware, salesChannel, processors, dryRun)));
    }
    if (!runCore) return lines;

    const blueprintProductIds = deps.cache
        .loadHydratedBlueprint(salesChannel)
        ?.products.map((p) => p.id);
    lines.push(...(await cleanupCoreData(shopware, options, blueprintProductIds ?? [])));
    if (processors.length === 0) lines.push(...processorHint(salesChannel));
    lines.push(...cacheHint(deps.cache, salesChannel));
    return lines;
}

async function cleanupProcessorEntities(
    shopware: CleanupShopware,
    salesChannel: string,
    processors: string[],
    dryRun: boolean
): Promise<string[]> {
    const salesChannelId = await shopware.findSalesChannelId(salesChannel);
    if (!salesChannelId) {
        return [`Error: SalesChannel "${salesChannel}" not found in Shopware.`];
    }

    let results: PostProcessorCleanupResult[];
    try {
        results = await shopware.cleanupProcessors(
            salesChannel,
            salesChannelId,
            processors,
            dryRun
        );
    } catch (error) {
        return [`Error: Processor cleanup failed: ${errorMessage(error)}`];
    }

    const errors = results.flatMap((result) => result.errors.map((e) => `${result.name}: ${e}`));
    const deleted = results.reduce((sum, result) => sum + result.deleted, 0);
    return [
        `Processors: ${processors.join(", ")}`,
        ...results.map(
            (r) => `  ${r.name}: ${r.deleted} deleted${r.errors.length ? ", errors" : ""}`
        ),
        `=== Processor Cleanup Complete ===`,
        dryRun ? `Total that would be deleted: ${deleted}` : `Total deleted: ${deleted}`,
        ...(errors.length > 0 ? [`Error: Processor cleanup errors: ${errors.join("; ")}`] : []),
        "",
    ];
}

/** Lines that are only shown when `enabled` */
function when(enabled: boolean, ...lines: string[]): string[] {
    return enabled ? lines : [];
}

const yesNo = (value: boolean): string => (value ? "Yes" : "No");

function coreDryRunLines(options: SalesChannelCleanupOptions): string[] {
    return [
        "[DRY RUN] Would delete:",
        `  - Products in SalesChannel "${options.salesChannel}"`,
        "  - Products of its cached blueprint (also without the SalesChannel)",
        "  - Categories under its root category",
        ...when(options.deleteProps, "  - All property groups"),
        ...when(options.deleteSalesChannel, "  - The SalesChannel and its root category"),
        "",
    ];
}

function coreResultLines(result: CoreCleanupResult, options: SalesChannelCleanupOptions): string[] {
    return [
        "=== Core Cleanup Complete ===",
        `Products deleted: ${result.products}`,
        `Categories deleted: ${result.categories}`,
        ...when(options.deleteProps, `Property groups deleted: ${result.propertyGroups}`),
        ...when(
            options.deleteSalesChannel,
            `SalesChannel deleted: ${yesNo(result.salesChannelDeleted)}`,
            `Root category deleted: ${yesNo(result.rootCategoryDeleted)}`
        ),
        ...when(
            result.errors.length > 0,
            `Error: Core cleanup errors: ${result.errors.join("; ")}`
        ),
        "",
    ];
}

async function cleanupCoreData(
    shopware: CleanupShopware,
    options: SalesChannelCleanupOptions,
    blueprintProductIds: string[]
): Promise<string[]> {
    const header = [
        "=== Core Cleanup ===",
        `Delete SalesChannel: ${yesNo(options.deleteSalesChannel)}`,
        `Delete property groups: ${yesNo(options.deleteProps)}`,
    ];
    if (options.dryRun) return [...header, ...coreDryRunLines(options)];

    try {
        // Before the core cleanup: leftovers can block deleting property groups
        const leftovers = await shopware.deleteProductsByIds(blueprintProductIds);
        const result = await shopware.cleanupCore(options.salesChannel, {
            deletePropertyGroups: options.deleteProps,
            deleteSalesChannel: options.deleteSalesChannel,
        });
        return [
            ...header,
            ...when(leftovers > 0, `Products deleted by blueprint ID: ${leftovers}`),
            ...coreResultLines(result, options),
        ];
    } catch (error) {
        return [...header, `Error: Core cleanup failed: ${errorMessage(error)}`];
    }
}

function processorHint(salesChannel: string): string[] {
    const cleanable = cleanableProcessorNames();
    if (cleanable.length === 0) return [];
    return [
        "Note: Processor entities (CMS pages, customers, promotions, ...) were not removed.",
        `      Use processors=all or full=true (CLI: --salesChannel="${salesChannel}" --full).`,
        `      Cleanable processors: ${cleanable.join(", ")}`,
        "",
    ];
}

function cacheHint(cache: DataCache, salesChannel: string): string[] {
    if (!fs.existsSync(cache.getSalesChannelDir(salesChannel))) return [];
    return [
        "Note: Local cache preserved. To also clear it: " +
            `cache_clear (CLI: bun run cache:clear -- ${salesChannel})`,
    ];
}

const GLOBAL_CLEANUPS: Record<
    GlobalCleanupTarget,
    { title: string; run: (shopware: CleanupShopware, dryRun: boolean) => Promise<number> }
> = {
    "unused-props": {
        title: "Unused Property Groups",
        run: (shopware, dryRun) => shopware.deleteUnusedPropertyGroups(dryRun),
    },
    "unused-options": {
        title: "Unused Property Options",
        run: (shopware, dryRun) => shopware.deleteUnusedPropertyOptions(dryRun),
    },
    "orphaned-media": {
        title: "Orphaned Product Media",
        run: (shopware, dryRun) => shopware.deleteOrphanedProductMedia(dryRun),
    },
};

/** Shop-wide cleanups that need no SalesChannel (unused properties, orphaned media) */
export async function cleanupGlobal(
    options: { targets: GlobalCleanupTarget[]; dryRun: boolean },
    deps: CleanupDeps = cleanupDepsFromEnv()
): Promise<string[]> {
    const { targets, dryRun } = options;
    if (targets.length === 0) return ["Error: Nothing to clean up"];

    const connected = await connectOrError(deps);
    if ("error" in connected) return [connected.error];
    const { shopware } = connected;

    const lines = [
        "=== Global Cleanup ===",
        `Environment: ${shopware.url}`,
        ...(dryRun ? ["[DRY RUN] Preview mode - no changes will be made"] : []),
        "",
    ];
    let total = 0;
    for (const target of targets) {
        const cleanup = GLOBAL_CLEANUPS[target];
        try {
            const count = await cleanup.run(shopware, dryRun);
            total += count;
            lines.push(`${cleanup.title}: ${count} ${dryRun ? "would be deleted" : "deleted"}`);
        } catch (error) {
            lines.push(`Error: ${cleanup.title} cleanup failed: ${errorMessage(error)}`);
        }
    }
    lines.push(
        "",
        dryRun
            ? `Total entities that would be deleted: ${total}`
            : `Total entities deleted: ${total}`
    );
    return lines;
}
