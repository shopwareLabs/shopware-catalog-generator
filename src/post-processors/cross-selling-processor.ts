/**
 * Cross-Selling Processor - Creates product cross-selling relationships
 *
 * Uses product streams to show "Similar Products" from the same category.
 * For each leaf category with products, creates a product stream filtered by categoryId,
 * then assigns a cross-selling entry to each product pointing to that stream.
 *
 * The default Shopware product detail CMS layout already includes a cross-selling
 * element -- this processor just provides the data it needs to render.
 */

import type { BlueprintProduct } from "../types/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

import { getAllSalesChannelProductIds, searchAllByEqualsAny } from "../shopware/api-helpers.js";
import { generateUUID, logger } from "../utils/index.js";

const CROSS_SELLING_NAME = "Similar Products";
const STREAM_PREFIX = "cross-sell";

/** Existing Shopware data the processor reuses */
interface ExistingCrossSelling {
    /** Stream name → stream ID */
    streams: Map<string, string>;
    productsWithCrossSelling: Set<string>;
}

interface CategoryOutcome {
    processed: number;
    skipped: number;
    error?: string;
}

interface CrossSellingEntry {
    id: string;
    productStreamId?: string;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Product IDs grouped by primary category, in blueprint order */
function groupProductsByCategory(products: BlueprintProduct[]): Map<string, string[]> {
    const productsByCategory = new Map<string, string[]>();
    products.forEach((product) => {
        const productIds = productsByCategory.get(product.primaryCategoryId) ?? [];
        productsByCategory.set(product.primaryCategoryId, [...productIds, product.id]);
    });
    return productsByCategory;
}

/** Product stream that selects every product of a category */
function categoryStreamPayload(
    streamId: string,
    streamName: string,
    categoryId: string
): Record<string, unknown> {
    return {
        id: streamId,
        name: streamName,
        filters: [
            {
                id: generateUUID(),
                type: "equals",
                field: "categoriesRo.id",
                value: categoryId,
                position: 0,
            },
        ],
    };
}

/** "Similar Products" cross-selling entry for a product */
function crossSellingPayload(productId: string, streamId: string): Record<string, unknown> {
    return {
        id: generateUUID(),
        productId,
        name: CROSS_SELLING_NAME,
        type: "productStream",
        productStreamId: streamId,
        position: 1,
        active: true,
        limit: 10,
        sortBy: "name",
        sortDirection: "ASC",
    };
}

/** Unique stream IDs referenced by the cross-selling entries */
function referencedStreamIds(crossSellings: CrossSellingEntry[]): string[] {
    const streamIds = crossSellings.flatMap((cs) =>
        cs.productStreamId ? [cs.productStreamId] : []
    );
    return [...new Set(streamIds)];
}

class CrossSellingProcessorImpl implements PostProcessor {
    readonly name = "cross-selling";
    readonly description = "Create product cross-selling relationships via category streams";
    readonly dependsOn: string[] = [];

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { blueprint, options } = context;
        const productsByCategory = groupProductsByCategory(blueprint.products);

        if (productsByCategory.size === 0) {
            logger.info("    No products found in blueprint", { cli: true });
            return this.processResult(0, 0, []);
        }

        if (options.dryRun) {
            logger.info(
                `    [DRY RUN] Would create ${productsByCategory.size} product streams and cross-selling for ${blueprint.products.length} products`,
                { cli: true }
            );
            return this.processResult(blueprint.products.length, 0, []);
        }

        if (!context.api) {
            return this.processResult(0, 0, ["API helpers not available"]);
        }

        // Check for existing streams and cross-selling entries
        const existing: ExistingCrossSelling = {
            streams: await this.findExistingStreams(context),
            productsWithCrossSelling: await this.findProductsWithCrossSelling(context),
        };

        const outcomes: CategoryOutcome[] = [];
        for (const [categoryId, productIds] of productsByCategory) {
            outcomes.push(await this.processCategory(context, categoryId, productIds, existing));
        }

        const processed = outcomes.reduce((sum, o) => sum + o.processed, 0);
        const skipped = outcomes.reduce((sum, o) => sum + o.skipped, 0);
        const errors = outcomes.flatMap((o) => (o.error ? [o.error] : []));

        logger.info(
            `    Created ${productsByCategory.size} streams, cross-selling for ${processed} products`,
            { cli: true }
        );

        return this.processResult(processed, skipped, errors);
    }

    private processResult(
        processed: number,
        skipped: number,
        errors: string[]
    ): PostProcessorResult {
        return { name: this.name, processed, skipped, errors, durationMs: 0 };
    }

    /** Create the category stream (if needed) and cross-selling for products without one */
    private async processCategory(
        context: PostProcessorContext,
        categoryId: string,
        productIds: string[],
        existing: ExistingCrossSelling
    ): Promise<CategoryOutcome> {
        if (productIds.length < 2) {
            return { processed: 0, skipped: productIds.length };
        }

        try {
            const streamId = await this.ensureCategoryStream(context, categoryId, existing.streams);

            // Only create cross-selling for products that don't already have one
            const newProductIds = productIds.filter(
                (id) => !existing.productsWithCrossSelling.has(id)
            );
            if (newProductIds.length === 0) {
                return { processed: 0, skipped: productIds.length };
            }

            await context.api.syncEntities({
                [`create-cross-selling-${categoryId}`]: {
                    entity: "product_cross_selling",
                    action: "upsert",
                    payload: newProductIds.map((id) => crossSellingPayload(id, streamId)),
                },
            });

            return {
                processed: newProductIds.length,
                skipped: productIds.length - newProductIds.length,
            };
        } catch (error) {
            return {
                processed: 0,
                skipped: 0,
                error: `Failed for category ${categoryId}: ${errorMessage(error)}`,
            };
        }
    }

    /** Reuse the existing stream of the category or create a new one. Returns its ID */
    private async ensureCategoryStream(
        context: PostProcessorContext,
        categoryId: string,
        existingStreams: Map<string, string>
    ): Promise<string> {
        const streamName = `${STREAM_PREFIX}-${categoryId}`;
        const existingId = existingStreams.get(streamName);
        if (existingId) return existingId;

        const streamId = generateUUID();
        await context.api.syncEntities({
            [`create-stream-${categoryId}`]: {
                entity: "product_stream",
                action: "upsert",
                payload: [categoryStreamPayload(streamId, streamName, categoryId)],
            },
        });
        return streamId;
    }

    async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        if (context.options.dryRun) {
            logger.info("    [DRY RUN] Would delete cross-selling entries and product streams", {
                cli: true,
            });
            return this.cleanupResult(0, []);
        }

        if (!context.api) {
            return this.cleanupResult(0, ["API helpers not available - cannot perform cleanup"]);
        }

        // Counted as we go, so a failing stream delete still reports the deleted entries
        const progress = { deleted: 0 };
        try {
            await this.deleteSalesChannelCrossSelling(context, progress);
        } catch (error) {
            return this.cleanupResult(progress.deleted, [
                `Cross-selling cleanup failed: ${errorMessage(error)}`,
            ]);
        }

        return this.cleanupResult(progress.deleted, []);
    }

    private cleanupResult(deleted: number, errors: string[]): PostProcessorCleanupResult {
        return { name: this.name, deleted, errors, durationMs: 0 };
    }

    /** Delete the cross-selling entries of the SalesChannel's products, then their streams */
    private async deleteSalesChannelCrossSelling(
        context: PostProcessorContext,
        progress: { deleted: number }
    ): Promise<void> {
        const productIds = await getAllSalesChannelProductIds(context);
        if (productIds.length === 0) {
            logger.info("    No products found in SalesChannel", { cli: true });
            return;
        }

        const crossSellings = await searchAllByEqualsAny<CrossSellingEntry>(
            context,
            "product-cross-selling",
            "productId",
            productIds,
            { includes: { product_cross_selling: ["id", "productStreamId"] } }
        );
        if (crossSellings.length === 0) {
            logger.info("    No cross-selling entries found", { cli: true });
            return;
        }

        // Delete cross-selling entries first (they reference streams)
        const crossSellingIds = crossSellings.map((cs) => cs.id);
        await context.api.deleteEntities("product_cross_selling", crossSellingIds);
        progress.deleted += crossSellingIds.length;
        logger.info(`    Deleted ${crossSellingIds.length} cross-selling entries`, { cli: true });

        const streamIds = referencedStreamIds(crossSellings);
        if (streamIds.length === 0) return;

        await context.api.deleteEntities("product_stream", streamIds);
        progress.deleted += streamIds.length;
        logger.info(`    Deleted ${streamIds.length} product streams`, { cli: true });
    }

    /** Find existing product streams created by this processor (name -> id) */
    private async findExistingStreams(context: PostProcessorContext): Promise<Map<string, string>> {
        try {
            const streams = await context.api.searchEntities<{ id: string; name: string }>(
                "product-stream",
                [{ type: "prefix", field: "name", value: STREAM_PREFIX }],
                { includes: { product_stream: ["id", "name"] }, limit: 500 }
            );
            return new Map(streams.map((s) => [s.name, s.id]));
        } catch {
            return new Map();
        }
    }

    /** Find products that already have cross-selling entries */
    private async findProductsWithCrossSelling(
        context: PostProcessorContext
    ): Promise<Set<string>> {
        try {
            const crossSellings = await searchAllByEqualsAny<{ productId: string }>(
                context,
                "product-cross-selling",
                "productId",
                context.blueprint.products.map((p) => p.id),
                { includes: { product_cross_selling: ["id", "productId"] } }
            );

            return new Set(crossSellings.map((cs) => cs.productId));
        } catch {
            return new Set();
        }
    }
}

/** Cross-selling processor singleton */
export const CrossSellingProcessor = new CrossSellingProcessorImpl();
