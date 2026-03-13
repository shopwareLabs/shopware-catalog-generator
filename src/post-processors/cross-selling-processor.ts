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

class CrossSellingProcessorImpl implements PostProcessor {
    readonly name = "cross-selling";
    readonly description = "Create product cross-selling relationships via category streams";
    readonly dependsOn: string[] = [];

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { blueprint, options } = context;
        const errors: string[] = [];
        let processed = 0;
        let skipped = 0;

        // Group products by their primary category
        const productsByCategory = new Map<string, string[]>();
        for (const product of blueprint.products) {
            const catId = product.primaryCategoryId;
            const existing = productsByCategory.get(catId) ?? [];
            existing.push(product.id);
            productsByCategory.set(catId, existing);
        }

        if (productsByCategory.size === 0) {
            logger.info("    No products found in blueprint", { cli: true });
            return { name: this.name, processed: 0, skipped: 0, errors: [], durationMs: 0 };
        }

        if (options.dryRun) {
            const totalProducts = blueprint.products.length;
            const categoryCount = productsByCategory.size;
            logger.info(
                `    [DRY RUN] Would create ${categoryCount} product streams and cross-selling for ${totalProducts} products`,
                { cli: true }
            );
            return {
                name: this.name,
                processed: totalProducts,
                skipped: 0,
                errors: [],
                durationMs: 0,
            };
        }

        if (!context.api) {
            errors.push("API helpers not available");
            return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
        }

        // Check for existing streams and cross-selling entries
        const existingStreams = await this.findExistingStreams(context);
        const productsWithCrossSelling = await this.findProductsWithCrossSelling(context);

        for (const [categoryId, productIds] of productsByCategory) {
            if (productIds.length < 2) {
                skipped += productIds.length;
                continue;
            }

            try {
                const streamName = `${STREAM_PREFIX}-${categoryId}`;
                let streamId = existingStreams.get(streamName);

                // Reuse existing stream or create a new one
                if (!streamId) {
                    streamId = generateUUID();
                    const filterId = generateUUID();

                    await context.api.syncEntities({
                        [`create-stream-${categoryId}`]: {
                            entity: "product_stream",
                            action: "upsert",
                            payload: [
                                {
                                    id: streamId,
                                    name: streamName,
                                    filters: [
                                        {
                                            id: filterId,
                                            type: "equals",
                                            field: "categoriesRo.id",
                                            value: categoryId,
                                            position: 0,
                                        },
                                    ],
                                },
                            ],
                        },
                    });
                }

                // Only create cross-selling for products that don't already have one
                const newProductIds = productIds.filter((id) => !productsWithCrossSelling.has(id));

                if (newProductIds.length === 0) {
                    skipped += productIds.length;
                    continue;
                }

                const crossSellingPayload = newProductIds.map((productId) => ({
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
                }));

                await context.api.syncEntities({
                    [`create-cross-selling-${categoryId}`]: {
                        entity: "product_cross_selling",
                        action: "upsert",
                        payload: crossSellingPayload,
                    },
                });

                processed += newProductIds.length;
                skipped += productIds.length - newProductIds.length;
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                errors.push(`Failed for category ${categoryId}: ${msg}`);
            }
        }

        logger.info(
            `    Created ${productsByCategory.size} streams, cross-selling for ${processed} products`,
            { cli: true }
        );

        return { name: this.name, processed, skipped, errors, durationMs: 0 };
    }

    async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        const errors: string[] = [];
        let deleted = 0;

        if (context.options.dryRun) {
            logger.info("    [DRY RUN] Would delete cross-selling entries and product streams", {
                cli: true,
            });
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        if (!context.api) {
            errors.push("API helpers not available - cannot perform cleanup");
            return { name: this.name, deleted: 0, errors, durationMs: 0 };
        }

        try {
            const productIds = await getAllSalesChannelProductIds(context);

            if (productIds.length === 0) {
                logger.info("    No products found in SalesChannel", { cli: true });
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            // Find cross-selling entries for these products
            const crossSellings = await searchAllByEqualsAny<{
                id: string;
                productStreamId?: string;
            }>(context, "product-cross-selling", "productId", productIds, {
                includes: { product_cross_selling: ["id", "productStreamId"] },
            });

            if (crossSellings.length === 0) {
                logger.info("    No cross-selling entries found", { cli: true });
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            // Collect stream IDs for cleanup
            const streamIds = new Set<string>();
            for (const cs of crossSellings) {
                if (cs.productStreamId) {
                    streamIds.add(cs.productStreamId);
                }
            }

            // Delete cross-selling entries first (they reference streams)
            const crossSellingIds = crossSellings.map((cs) => cs.id);
            await context.api.deleteEntities("product_cross_selling", crossSellingIds);
            deleted += crossSellingIds.length;
            logger.info(`    Deleted ${crossSellingIds.length} cross-selling entries`, {
                cli: true,
            });

            // Delete orphaned product streams
            if (streamIds.size > 0) {
                await context.api.deleteEntities("product_stream", Array.from(streamIds));
                deleted += streamIds.size;
                logger.info(`    Deleted ${streamIds.size} product streams`, { cli: true });
            }
        } catch (error) {
            errors.push(
                `Cross-selling cleanup failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        return { name: this.name, deleted, errors, durationMs: 0 };
    }

    /** Find existing product streams created by this processor (name -> id) */
    private async findExistingStreams(context: PostProcessorContext): Promise<Map<string, string>> {
        if (!context.api) return new Map();

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
        if (!context.api) return new Set();

        try {
            const productIds = context.blueprint.products.map((p) => p.id);
            if (productIds.length === 0) return new Set();

            const crossSellings = await searchAllByEqualsAny<{ productId: string }>(
                context,
                "product-cross-selling",
                "productId",
                productIds,
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
