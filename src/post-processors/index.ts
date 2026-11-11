/**
 * Post-Processors - Process products after initial Shopware upload
 *
 * Post-processors run after the SalesChannel is created and products are uploaded.
 * They handle heavy operations like image generation, variant creation, and reviews.
 *
 * Features:
 * - Dependency ordering (via dependsOn)
 * - Parallel execution for independent processors
 * - Registry for processor discovery
 */

import type { DataCacheApi } from "../cache.js";
import type { ShopwareApi } from "../shopware/api-helpers.js";
import type { ShopwareCapabilities } from "../shopware/version.js";
import type { HydratedBlueprint, ImageProvider, TextProvider } from "../types/index.js";

import { logger } from "../utils/index.js";

// =============================================================================
// Post-Processor Interface
// =============================================================================

/** Context passed to each post-processor */
export interface PostProcessorContext {
    /** SalesChannel ID in Shopware */
    salesChannelId: string;

    /** SalesChannel name */
    salesChannelName: string;

    /** Hydrated blueprint with all metadata */
    blueprint: HydratedBlueprint;

    /** Cache for reading/writing metadata */
    cache: DataCacheApi;

    /** Text provider for AI generation (optional) */
    textProvider?: TextProvider;

    /** Image provider for image generation (optional) */
    imageProvider?: ImageProvider;

    /**
     * Shopware API helpers — the single gateway for all Shopware calls.
     * Required. Provides searchEntities, syncEntities, deleteEntities, post, patch, postRaw, etc.
     */
    api: ShopwareApi;

    /**
     * Version and feature flags of the connected shop, detected once per run.
     * Use `shopware.supports("<feature>")` to leave out fields an older shop rejects.
     */
    shopware: ShopwareCapabilities;

    /** Processing options */
    options: PostProcessorOptions;
}

/** Options for post-processor execution */
export interface PostProcessorOptions {
    /** Batch size for parallel operations */
    batchSize: number;

    /** Dry run mode - log actions without executing */
    dryRun: boolean;

    /**
     * Names of processors in the current run.
     * Populated by the orchestrator before constructing the context.
     * Used by processors to conditionally render sections that depend on other processors.
     */
    activeProcessors?: string[];
}

/** Default processing options */
export const DEFAULT_PROCESSOR_OPTIONS: PostProcessorOptions = {
    batchSize: 5,
    dryRun: false,
};

/** Result from a post-processor */
export interface PostProcessorResult {
    /** Processor name */
    name: string;

    /** Number of items processed */
    processed: number;

    /** Number of items skipped (already processed or not applicable) */
    skipped: number;

    /** Errors encountered during processing */
    errors: string[];

    /** Duration in milliseconds */
    durationMs: number;
}

/** Result from a post-processor cleanup */
export interface PostProcessorCleanupResult {
    /** Processor name */
    name: string;

    /** Number of items deleted */
    deleted: number;

    /** Errors encountered during cleanup */
    errors: string[];

    /** Duration in milliseconds */
    durationMs: number;
}

/** Post-processor interface */
export interface PostProcessor {
    /** Unique processor name */
    readonly name: string;

    /** Human-readable description */
    readonly description: string;

    /** Dependencies - processors that must run before this one */
    readonly dependsOn: string[];

    /**
     * Process the SalesChannel
     * @param context - Processing context
     * @returns Result of processing
     */
    process(context: PostProcessorContext): Promise<PostProcessorResult>;

    /**
     * Cleanup entities created by this processor (optional)
     * @param context - Processing context
     * @returns Result of cleanup
     */
    cleanup?(context: PostProcessorContext): Promise<PostProcessorCleanupResult>;
}

// =============================================================================
// Processor Registry
// =============================================================================

/** Registry of all available post-processors */
class ProcessorRegistry {
    private readonly processors = new Map<string, PostProcessor>();

    /** Register a processor */
    register(processor: PostProcessor): void {
        if (this.processors.has(processor.name)) {
            throw new Error(`Processor "${processor.name}" is already registered`);
        }
        this.processors.set(processor.name, processor);
    }

    /** Get a processor by name */
    get(name: string): PostProcessor | undefined {
        return this.processors.get(name);
    }

    /** Get all registered processors */
    getAll(): PostProcessor[] {
        return Array.from(this.processors.values());
    }

    /** Get processor names */
    getNames(): string[] {
        return Array.from(this.processors.keys());
    }

    /** Check if a processor exists */
    has(name: string): boolean {
        return this.processors.has(name);
    }
}

/** Global processor registry */
export const registry = new ProcessorRegistry();

// =============================================================================
// Dependency Resolution and Execution
// =============================================================================

interface DependencyGraph {
    /** Processor name → names of selected processors that depend on it */
    dependents: Map<string, Set<string>>;
    /** Processor name → number of unresolved selected dependencies */
    inDegree: Map<string, number>;
}

/** Dependencies of a processor that are part of the selection */
function selectedDependencies(processor: PostProcessor, selected: string[]): string[] {
    return processor.dependsOn.filter((dep) => selected.includes(dep));
}

/** Build the dependency graph for the selected processors */
function buildDependencyGraph(processors: PostProcessor[], selected: string[]): DependencyGraph {
    const dependents = new Map<string, Set<string>>(selected.map((name) => [name, new Set()]));
    const inDegree = new Map<string, number>(selected.map((name) => [name, 0]));

    const selectedProcessors = processors.filter((p) => selected.includes(p.name));
    for (const processor of selectedProcessors) {
        const deps = selectedDependencies(processor, selected);
        deps.forEach((dep) => dependents.get(dep)?.add(processor.name));
        inDegree.set(processor.name, deps.length);
    }

    return { dependents, inDegree };
}

/** Decrement the in-degree of every dependent and return the ones that became ready */
function releaseDependents(graph: DependencyGraph, name: string): string[] {
    const dependents = [...(graph.dependents.get(name) ?? [])];
    return dependents.filter((dep) => {
        const newDegree = (graph.inDegree.get(dep) ?? 1) - 1;
        graph.inDegree.set(dep, newDegree);
        return newDegree === 0;
    });
}

/**
 * Topological sort for dependency ordering (Kahn's algorithm)
 * Returns processors in execution order (dependencies first)
 */
function topologicalSort(processors: PostProcessor[], selected: string[]): PostProcessor[] {
    const graph = buildDependencyGraph(processors, selected);
    const queue = [...graph.inDegree].filter(([, degree]) => degree === 0).map(([name]) => name);
    const sorted: PostProcessor[] = [];

    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        const processor = processors.find((p) => p.name === name);
        if (processor) sorted.push(processor);
        queue.push(...releaseDependents(graph, name));
    }

    if (sorted.length !== selected.length) {
        throw new Error("Circular dependency detected in processors");
    }

    return sorted;
}

/**
 * Whether a processor can join the current batch: none of its dependencies is in it.
 * The input is topologically sorted, so nothing in the batch can depend on the processor.
 */
function canJoinBatch(
    processor: PostProcessor,
    batch: PostProcessor[],
    selected: string[]
): boolean {
    const batchNames = new Set(batch.map((p) => p.name));
    return !selectedDependencies(processor, selected).some((dep) => batchNames.has(dep));
}

/**
 * Group processors that can run in parallel
 * Returns batches where each batch can run concurrently
 */
function groupParallelizable(processors: PostProcessor[], selected: string[]): PostProcessor[][] {
    const sorted = topologicalSort(processors, selected);
    const batches: PostProcessor[][] = [];

    for (const processor of sorted) {
        const currentBatch = batches[batches.length - 1];
        if (currentBatch && canJoinBatch(processor, currentBatch, selected)) {
            currentBatch.push(processor);
            continue;
        }
        batches.push([processor]);
    }

    return batches;
}

// =============================================================================
// Processor Runner
// =============================================================================

/** Throw when a selected processor is not registered */
function assertProcessorsExist(selected: string[]): void {
    const unknown = selected.find((name) => !registry.has(name));
    if (unknown === undefined) return;
    throw new Error(
        `Unknown processor: "${unknown}". Available: ${registry.getNames().join(", ")}`
    );
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function logResultErrors(errors: string[]): void {
    errors.forEach((error) => logger.error(`      Error: ${error}`, { cli: true }));
}

function statusIcon(errors: string[]): string {
    return errors.length === 0 ? "✓" : "✗";
}

/** Run one processor, turning a thrown error into an error result */
async function runSingleProcessor(
    processor: PostProcessor,
    context: PostProcessorContext
): Promise<PostProcessorResult> {
    const startTime = Date.now();
    try {
        const result = await processor.process(context);
        return { ...result, durationMs: Date.now() - startTime };
    } catch (error) {
        return {
            name: processor.name,
            processed: 0,
            skipped: 0,
            errors: [errorMessage(error)],
            durationMs: Date.now() - startTime,
        };
    }
}

function logProcessorResult(result: PostProcessorResult): void {
    logger.info(
        `    ${statusIcon(result.errors)} ${result.name}: ${result.processed} processed, ${result.skipped} skipped (${result.durationMs}ms)`,
        { cli: true }
    );
    logResultErrors(result.errors);
}

/** Run one batch of independent processors in parallel */
async function runBatch(
    batch: PostProcessor[],
    label: string,
    context: PostProcessorContext
): Promise<PostProcessorResult[]> {
    const batchNames = batch.map((p) => p.name).join(", ");
    logger.info(`  Batch ${label}: ${batchNames}`, { cli: true });

    const results = await Promise.all(batch.map((p) => runSingleProcessor(p, context)));
    results.forEach(logProcessorResult);
    return results;
}

/** Run selected post-processors with dependency ordering */
export async function runProcessors(
    context: PostProcessorContext,
    selected: string[]
): Promise<PostProcessorResult[]> {
    assertProcessorsExist(selected);

    // Populate activeProcessors so processors can conditionally render optional sections
    const contextWithActive: PostProcessorContext = {
        ...context,
        options: { ...context.options, activeProcessors: selected },
    };

    const batches = groupParallelizable(registry.getAll(), selected);

    logger.info(`Running ${selected.length} post-processors in ${batches.length} batch(es)...`, {
        cli: true,
    });

    const allResults: PostProcessorResult[] = [];
    for (const [index, batch] of batches.entries()) {
        const label = `${index + 1}/${batches.length}`;
        allResults.push(...(await runBatch(batch, label, contextWithActive)));
    }

    await clearShopHttpCache(context);
    return allResults;
}

/**
 * Cached storefront pages still show the old data (prices, images, hidden categories),
 * so the shop cache is cleared once after all processors. A failure is only a warning.
 */
async function clearShopHttpCache(context: PostProcessorContext): Promise<void> {
    if (context.options.dryRun) return;
    try {
        await context.api.httpDelete("_action/cache");
        logger.info("✓ Cleared shop cache", { cli: true });
    } catch (error) {
        logger.warn(
            `Could not clear shop cache, run bin/console cache:clear: ${errorMessage(error)}`,
            {
                cli: true,
            }
        );
    }
}

type CleanupFn = NonNullable<PostProcessor["cleanup"]>;

/** Run cleanup of one processor, turning a thrown error into an error result */
async function cleanupSingleProcessor(
    processor: PostProcessor,
    cleanup: CleanupFn,
    context: PostProcessorContext
): Promise<PostProcessorCleanupResult> {
    const name = processor.name;
    const startTime = Date.now();
    logger.info(`  Cleaning up: ${name}`, { cli: true });

    try {
        const result = await cleanup.call(processor, context);
        const durationMs = Date.now() - startTime;
        logger.info(
            `    ${statusIcon(result.errors)} ${name}: ${result.deleted} deleted (${durationMs}ms)`,
            { cli: true }
        );
        logResultErrors(result.errors);
        return { ...result, durationMs };
    } catch (error) {
        const message = errorMessage(error);
        logger.error(`    ✗ ${name}: Error - ${message}`, { cli: true });
        return { name, deleted: 0, errors: [message], durationMs: Date.now() - startTime };
    }
}

interface CleanableProcessor {
    processor: PostProcessor;
    cleanup: CleanupFn;
}

/** Selected processors that implement cleanup(), in selection order */
function cleanableProcessors(selected: string[]): CleanableProcessor[] {
    return selected.flatMap((name): CleanableProcessor[] => {
        const processor = registry.get(name);
        return processor?.cleanup ? [{ processor, cleanup: processor.cleanup }] : [];
    });
}

/** Run cleanup for selected post-processors */
export async function cleanupProcessors(
    context: PostProcessorContext,
    selected: string[]
): Promise<PostProcessorCleanupResult[]> {
    assertProcessorsExist(selected);

    const cleanable = cleanableProcessors(selected);
    if (cleanable.length === 0) {
        logger.info("No processors with cleanup support selected.", { cli: true });
        return [];
    }

    logger.info(`Running cleanup for ${cleanable.length} processor(s)...`, { cli: true });

    const results: PostProcessorCleanupResult[] = [];
    for (const { processor, cleanup } of cleanable) {
        results.push(await cleanupSingleProcessor(processor, cleanup, context));
    }

    return results;
}

// =============================================================================
// Exports and Registration
// =============================================================================

// Import processors
import {
    CommerceProcessor,
    FooterPagesProcessor,
    FormProcessor,
    HomeProcessor,
    ImagesProcessor,
    TestingProcessor,
    TextImagesProcessor,
    TextProcessor,
    VideoProcessor,
} from "./cms/index.js";
import { CrossSellingProcessor } from "./cross-selling-processor.js";
import { CustomerProcessor } from "./customer-processor.js";
import { DigitalProductProcessor } from "./digital-product-processor.js";
import { ImageProcessor } from "./image-processor.js";
import { ManufacturerProcessor } from "./manufacturer-processor.js";
import { MediaProductProcessor } from "./media-product-processor.js";
import { PromotionProcessor } from "./promotion-processor.js";
import { ReviewProcessor } from "./review-processor.js";
import { ThemeProcessor } from "./theme-processor.js";
import { TranslationProcessor } from "./translation-processor.js";
import { VariantImageProcessor } from "./variant-image-processor.js";
import { VariantProcessor } from "./variant-processor.js";

// Re-export processors
export {
    CommerceProcessor,
    FooterPagesProcessor,
    FormProcessor,
    HomeProcessor,
    ImagesProcessor,
    TestingProcessor,
    TextImagesProcessor,
    TextProcessor,
    VideoProcessor,
} from "./cms/index.js";
export { CrossSellingProcessor } from "./cross-selling-processor.js";
export { CustomerProcessor } from "./customer-processor.js";
export { DigitalProductProcessor } from "./digital-product-processor.js";
export { ImageProcessor } from "./image-processor.js";
export { ManufacturerProcessor } from "./manufacturer-processor.js";
export { MediaProductProcessor } from "./media-product-processor.js";
export { PromotionProcessor } from "./promotion-processor.js";
export { ReviewProcessor } from "./review-processor.js";
export { ThemeProcessor } from "./theme-processor.js";
export { TranslationProcessor } from "./translation-processor.js";
export { VariantImageProcessor } from "./variant-image-processor.js";
export { VariantProcessor } from "./variant-processor.js";

// Register all processors with the registry
// CMS element processors (create individual demo pages)
registry.register(TextProcessor);
registry.register(ImagesProcessor);
registry.register(VideoProcessor);
registry.register(TextImagesProcessor);
registry.register(CommerceProcessor);
registry.register(FormProcessor);
// CMS homepage (root category layout with product listing)
registry.register(HomeProcessor);
// Shared footer legal pages for all SalesChannels
registry.register(FooterPagesProcessor);
registry.register(DigitalProductProcessor);
registry.register(MediaProductProcessor);
// CMS orchestrator (creates Testing category hierarchy, runs last)
registry.register(TestingProcessor);
// Other processors
registry.register(CrossSellingProcessor);
registry.register(CustomerProcessor);
registry.register(ImageProcessor);
registry.register(ManufacturerProcessor);
registry.register(PromotionProcessor);
registry.register(ReviewProcessor);
registry.register(ThemeProcessor);
registry.register(VariantProcessor);
// Colour images per variant (after variants and parent images exist)
registry.register(VariantImageProcessor);
// Writes cached translations after all translated entities exist
registry.register(TranslationProcessor);
