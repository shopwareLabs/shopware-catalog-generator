/**
 * Review Processor - Generates and creates product reviews
 *
 * 1. Reads reviewCount from product metadata
 * 2. Generates reviews via AI (if text provider available)
 * 3. Creates reviews in Shopware
 *
 * Review distribution:
 * - 0 reviews: ~17% of products
 * - 1-2 reviews: ~28% of products
 * - 3-5 reviews: ~33% of products
 * - 8-10 reviews: ~22% of products
 */

import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

import { getReviewContent, REVIEW_TEMPLATES, REVIEWER_NAMES } from "../fixtures/index.js";
import { apiPost, generateUUID, logger } from "../utils/index.js";

/**
 * Review Processor implementation
 */
class ReviewProcessorImpl implements PostProcessor {
    readonly name = "reviews";
    readonly description = "Generate product reviews";
    readonly dependsOn: string[] = []; // No dependencies

    /** Cache of products that already have reviews */
    private productsWithReviews: Set<string> = new Set();

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { blueprint, cache, options } = context;

        let processed = 0;
        let skipped = 0;
        const errors: string[] = [];
        let totalReviews = 0;

        // Reset cache for each run
        this.productsWithReviews = new Set();

        for (const product of blueprint.products) {
            try {
                const metadata = cache.loadProductMetadata(context.salesChannelName, product.id);

                const reviewCount = metadata?.reviewCount || 0;

                if (reviewCount === 0) {
                    skipped++;
                    continue;
                }

                // Check if product already has reviews in Shopware
                const hasExistingReviews = await this.productHasReviews(context, product.id);
                if (hasExistingReviews) {
                    skipped++;
                    continue;
                }

                if (options.dryRun) {
                    console.log(
                        `    [DRY RUN] Would generate ${reviewCount} reviews for ${product.name}`
                    );
                    totalReviews += reviewCount;
                    processed++;
                    continue;
                }

                // Generate reviews
                const reviews = this.generateReviews(product.name, reviewCount);
                totalReviews += reviews.length;

                // Create reviews in Shopware
                const reviewPayload = reviews.map((review) => ({
                    id: generateUUID(),
                    productId: product.id,
                    salesChannelId: context.salesChannelId,
                    title: review.title,
                    content: review.content,
                    points: review.rating,
                    status: true, // Approved
                    externalUser: review.user,
                    externalEmail: review.email,
                }));

                if (reviewPayload.length > 0) {
                    try {
                        if (context.api) {
                            // Use new API helpers
                            await context.api.syncEntities({
                                createReviews: {
                                    entity: "product_review",
                                    action: "upsert",
                                    payload: reviewPayload,
                                },
                            });
                        } else {
                            // Fallback to legacy method
                            const response = await apiPost(context, "_action/sync", {
                                createReviews: {
                                    entity: "product_review",
                                    action: "upsert",
                                    payload: reviewPayload,
                                },
                            });

                            if (!response.ok) {
                                logger.apiError("_action/sync (reviews)", response.status, {
                                    productId: product.id,
                                    reviewCount: reviewPayload.length,
                                });
                                errors.push(
                                    `Failed to create reviews for ${product.name}: API returned ${response.status}`
                                );
                            }
                        }
                    } catch (error) {
                        errors.push(
                            `Failed to create reviews for ${product.name}: ${error instanceof Error ? error.message : String(error)}`
                        );
                    }
                }

                processed++;
            } catch (error) {
                errors.push(
                    `Failed to process reviews for ${product.name}: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }

        console.log(`    Generated ${totalReviews} reviews for ${processed} products`);

        return {
            name: this.name,
            processed,
            skipped,
            errors,
            durationMs: 0,
        };
    }

    /**
     * Cleanup reviews for products in the SalesChannel
     */
    async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        const errors: string[] = [];
        let deleted = 0;

        if (context.options.dryRun) {
            console.log(`    [DRY RUN] Would delete reviews for products in SalesChannel`);
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        if (!context.api) {
            errors.push("API helpers not available - cannot perform cleanup");
            return { name: this.name, deleted: 0, errors, durationMs: 0 };
        }

        try {
            // Step 1: Get all products in this SalesChannel
            const products = await context.api.searchEntities<{ id: string }>(
                "product",
                [
                    {
                        type: "equals",
                        field: "visibilities.salesChannelId",
                        value: context.salesChannelId,
                    },
                ],
                { limit: 500 }
            );

            if (products.length === 0) {
                console.log(`    No products found in SalesChannel`);
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            const productIds = products.map((p) => p.id);
            console.log(`    Found ${productIds.length} products in SalesChannel`);

            // Step 2: Find all reviews for these products
            // Use equalsAny filter (cast needed as type is not fully exported)
            const reviews = await context.api.searchEntities<{ id: string }>(
                "product-review",
                [{ type: "equalsAny" as "equals", field: "productId", value: productIds }],
                { limit: 500 }
            );

            if (reviews.length === 0) {
                console.log(`    No reviews found for products`);
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            console.log(`    Found ${reviews.length} reviews to delete`);

            // Step 3: Delete reviews
            const reviewIds = reviews.map((r) => r.id);
            await context.api.deleteEntities("product_review", reviewIds);

            deleted = reviewIds.length;
            console.log(`    ✓ Deleted ${deleted} reviews`);
        } catch (error) {
            errors.push(
                `Review cleanup failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        return { name: this.name, deleted, errors, durationMs: 0 };
    }

    /**
     * Generate reviews for a product
     */
    private generateReviews(
        productName: string,
        count: number
    ): Array<{
        user: string;
        email: string;
        title: string;
        content: string;
        rating: number;
    }> {
        const reviews: Array<{
            user: string;
            email: string;
            title: string;
            content: string;
            rating: number;
        }> = [];

        for (let i = 0; i < count; i++) {
            // Generate random rating (weighted toward positive)
            // Distribution: 5 stars (40%), 4 stars (30%), 3 stars (15%), 2 stars (10%), 1 star (5%)
            const ratingRoll = Math.random();
            let rating: number;
            if (ratingRoll < 0.4) rating = 5;
            else if (ratingRoll < 0.7) rating = 4;
            else if (ratingRoll < 0.85) rating = 3;
            else if (ratingRoll < 0.95) rating = 2;
            else rating = 1;

            // Generate random reviewer
            const firstName = this.randomPick(REVIEWER_NAMES.firstNames);
            const lastName = this.randomPick(REVIEWER_NAMES.lastNames);
            const user = `${firstName} ${lastName}`;
            const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`;

            // Generate title based on rating
            let title: string;
            if (rating >= 4) {
                title = this.randomPick(REVIEW_TEMPLATES.positiveTitles);
            } else if (rating === 3) {
                title = this.randomPick(REVIEW_TEMPLATES.neutralTitles);
            } else {
                title = this.randomPick(REVIEW_TEMPLATES.negativeTitles);
            }

            // Generate content using fixture helper
            const productType = productName.split(" - ")[0] || productName;
            const content = getReviewContent(rating, productType);

            reviews.push({ user, email, title, content, rating });
        }

        return reviews;
    }

    private randomPick<T>(arr: readonly T[]): T {
        const index = Math.floor(Math.random() * arr.length);
        return arr[index] as T;
    }

    /**
     * Check if a product already has reviews in Shopware
     */
    private async productHasReviews(
        context: PostProcessorContext,
        productId: string
    ): Promise<boolean> {
        // Use cached result if available
        if (this.productsWithReviews.has(productId)) {
            return true;
        }

        try {
            interface ReviewCountResponse {
                total?: number;
            }

            const response = await apiPost(context, "search/product-review", {
                filter: [{ type: "equals", field: "productId", value: productId }],
                limit: 1,
                includes: { product_review: ["id"] },
            });

            if (response.ok) {
                const data = (await response.json()) as ReviewCountResponse;
                if (data.total && data.total > 0) {
                    this.productsWithReviews.add(productId);
                    return true;
                }
            }
        } catch {
            // On error, assume no reviews (will try to create)
        }

        return false;
    }
}

/** Review processor singleton */
export const ReviewProcessor = new ReviewProcessorImpl();
