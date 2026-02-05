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

import type { DataCache } from "../cache.js";
import type { ShopwareApiHelpers } from "../shopware/api-helpers.js";
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
    cache: DataCache;

    /** Text provider for AI generation (optional) */
    textProvider?: TextProvider;

    /** Image provider for image generation (optional) */
    imageProvider?: ImageProvider;

    /** Shopware API base URL */
    shopwareUrl: string;

    /**
     * Get a fresh Shopware API access token
     * This function handles token refresh automatically when the token is about to expire.
     * Post-processors should call this before each API request batch.
     */
    getAccessToken: () => Promise<string>;

    /**
     * Shopware API helpers for common operations
     * Provides searchEntities, syncEntities, deleteEntities, etc.
     * Optional for backwards compatibility - will be required in future versions.
     */
    api?: ShopwareApiHelpers;

    /** Processing options */
    options: PostProcessorOptions;
}

/** Options for post-processor execution */
export interface PostProcessorOptions {
    /** Batch size for parallel operations */
    batchSize: number;

    /** Dry run mode - log actions without executing */
    dryRun: boolean;
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

/**
 * Topological sort for dependency ordering
 * Returns processors in execution order (dependencies first)
 */
function topologicalSort(processors: PostProcessor[], selected: string[]): PostProcessor[] {
    // Build dependency graph for selected processors
    const graph = new Map<string, Set<string>>();
    const inDegree = new Map<string, number>();

    // Initialize
    for (const name of selected) {
        graph.set(name, new Set());
        inDegree.set(name, 0);
    }

    // Add dependencies (only for selected processors)
    for (const name of selected) {
        const processor = processors.find((p) => p.name === name);
        if (!processor) continue;

        for (const dep of processor.dependsOn) {
            if (selected.includes(dep)) {
                graph.get(dep)?.add(name);
                inDegree.set(name, (inDegree.get(name) || 0) + 1);
            }
        }
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [name, degree] of inDegree) {
        if (degree === 0) {
            queue.push(name);
        }
    }

    const sorted: PostProcessor[] = [];
    while (queue.length > 0) {
        const name = queue.shift();
        if (!name) continue;

        const processor = processors.find((p) => p.name === name);
        if (processor) {
            sorted.push(processor);
        }

        const dependents = graph.get(name);
        if (dependents) {
            for (const dep of dependents) {
                const newDegree = (inDegree.get(dep) || 1) - 1;
                inDegree.set(dep, newDegree);
                if (newDegree === 0) {
                    queue.push(dep);
                }
            }
        }
    }

    // Check for cycles
    if (sorted.length !== selected.length) {
        throw new Error("Circular dependency detected in processors");
    }

    return sorted;
}

/**
 * Group processors that can run in parallel
 * Returns batches where each batch can run concurrently
 */
function groupParallelizable(processors: PostProcessor[], selected: string[]): PostProcessor[][] {
    const sorted = topologicalSort(processors, selected);
    const batches: PostProcessor[][] = [];

    // Track completed processors
    const completed = new Set<string>();

    for (const processor of sorted) {
        // Check if all dependencies are complete
        const depsComplete = processor.dependsOn.every(
            (dep) => !selected.includes(dep) || completed.has(dep)
        );

        if (depsComplete) {
            // Can run in current batch or start new one
            const currentBatch = batches[batches.length - 1];
            if (currentBatch?.every((p) => !p.dependsOn.includes(processor.name))) {
                currentBatch.push(processor);
            } else {
                batches.push([processor]);
            }
        } else {
            // Start new batch
            batches.push([processor]);
        }

        completed.add(processor.name);
    }

    return batches;
}

// =============================================================================
// Processor Runner
// =============================================================================

/** Run selected post-processors with dependency ordering */
export async function runProcessors(
    context: PostProcessorContext,
    selected: string[]
): Promise<PostProcessorResult[]> {
    const allProcessors = registry.getAll();

    // Validate selected processors exist
    for (const name of selected) {
        if (!registry.has(name)) {
            throw new Error(
                `Unknown processor: "${name}". Available: ${registry.getNames().join(", ")}`
            );
        }
    }

    // Group into parallel batches
    const batches = groupParallelizable(allProcessors, selected);

    logger.cli(`Running ${selected.length} post-processors in ${batches.length} batch(es)...`);

    const allResults: PostProcessorResult[] = [];

    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        if (!batch) continue;

        const batchNames = batch.map((p) => p.name).join(", ");
        logger.cli(`  Batch ${i + 1}/${batches.length}: ${batchNames}`);

        // Run batch in parallel
        const batchResults = await Promise.all(
            batch.map(async (processor) => {
                const startTime = Date.now();
                try {
                    const result = await processor.process(context);
                    return {
                        ...result,
                        durationMs: Date.now() - startTime,
                    };
                } catch (error) {
                    return {
                        name: processor.name,
                        processed: 0,
                        skipped: 0,
                        errors: [error instanceof Error ? error.message : String(error)],
                        durationMs: Date.now() - startTime,
                    };
                }
            })
        );

        allResults.push(...batchResults);

        // Log batch results
        for (const result of batchResults) {
            const status = result.errors.length === 0 ? "✓" : "✗";
            logger.cli(
                `    ${status} ${result.name}: ${result.processed} processed, ${result.skipped} skipped (${result.durationMs}ms)`
            );
            if (result.errors.length > 0) {
                for (const error of result.errors) {
                    logger.cli(`      Error: ${error}`);
                }
            }
        }
    }

    return allResults;
}

/** Run cleanup for selected post-processors */
export async function cleanupProcessors(
    context: PostProcessorContext,
    selected: string[]
): Promise<PostProcessorCleanupResult[]> {
    // Validate selected processors exist
    for (const name of selected) {
        if (!registry.has(name)) {
            throw new Error(
                `Unknown processor: "${name}". Available: ${registry.getNames().join(", ")}`
            );
        }
    }

    // Filter to processors that have cleanup implemented
    const cleanableProcessors = selected.filter((name) => {
        const processor = registry.get(name);
        return processor && typeof processor.cleanup === "function";
    });

    if (cleanableProcessors.length === 0) {
        logger.cli("No processors with cleanup support selected.");
        return [];
    }

    logger.cli(`Running cleanup for ${cleanableProcessors.length} processor(s)...`);

    const results: PostProcessorCleanupResult[] = [];

    for (const name of cleanableProcessors) {
        const processor = registry.get(name);
        if (!processor || !processor.cleanup) continue;

        const startTime = Date.now();
        logger.cli(`  Cleaning up: ${name}`);

        try {
            const result = await processor.cleanup(context);
            results.push({
                ...result,
                durationMs: Date.now() - startTime,
            });

            const status = result.errors.length === 0 ? "✓" : "✗";
            logger.cli(
                `    ${status} ${name}: ${result.deleted} deleted (${Date.now() - startTime}ms)`
            );

            if (result.errors.length > 0) {
                for (const error of result.errors) {
                    logger.cli(`      Error: ${error}`);
                }
            }
        } catch (error) {
            const errorResult: PostProcessorCleanupResult = {
                name,
                deleted: 0,
                errors: [error instanceof Error ? error.message : String(error)],
                durationMs: Date.now() - startTime,
            };
            results.push(errorResult);
            logger.cli(`    ✗ ${name}: Error - ${errorResult.errors[0]}`);
        }
    }

    return results;
}

// =============================================================================
// Exports and Registration
// =============================================================================

// Import processors
import {
    CommerceProcessor,
    FormProcessor,
    ImagesProcessor,
    TestingProcessor,
    TextImagesProcessor,
    TextProcessor,
    VideoProcessor,
} from "./cms/index.js";
import { DigitalProductProcessor } from "./digital-product-processor.js";
import { ImageProcessor } from "./image-processor.js";
import { ManufacturerProcessor } from "./manufacturer-processor.js";
import { ReviewProcessor } from "./review-processor.js";
import { VariantProcessor } from "./variant-processor.js";

// Re-export processors
export {
    CommerceProcessor,
    FormProcessor,
    ImagesProcessor,
    TestingProcessor,
    TextImagesProcessor,
    TextProcessor,
    VideoProcessor,
} from "./cms/index.js";
export { DigitalProductProcessor } from "./digital-product-processor.js";
export { ImageProcessor } from "./image-processor.js";
export { ManufacturerProcessor } from "./manufacturer-processor.js";
export { ReviewProcessor } from "./review-processor.js";
export { VariantProcessor } from "./variant-processor.js";

// Register all processors with the registry
// CMS element processors (create individual demo pages)
registry.register(TextProcessor);
registry.register(ImagesProcessor);
registry.register(VideoProcessor);
registry.register(TextImagesProcessor);
registry.register(CommerceProcessor);
registry.register(FormProcessor);
// Digital product processor (runs after variants)
registry.register(DigitalProductProcessor);
// CMS orchestrator (creates Testing category hierarchy, runs last)
registry.register(TestingProcessor);
// Other processors
registry.register(ImageProcessor);
registry.register(ManufacturerProcessor);
registry.register(ReviewProcessor);
registry.register(VariantProcessor);
