/**
 * Review Processor - Creates product reviews from cached content (no AI)
 *
 * 1. Reads reviewCount from product metadata
 * 2. Builds the English reviews deterministically (`buildProductReviews`)
 * 3. Spreads them across the SalesChannel languages: review i is written in
 *    language i % n, using the translated title/content when a translation exists
 *
 * `product_review` has one `languageId` and no translations, so every review belongs to
 * exactly one language. Review IDs are derived from (product, index), so re-runs upsert
 * the same rows.
 */

import type { GeneratedReview } from "../fixtures/index.js";
import type { LanguageContent } from "../shopware/index.js";
import type { BlueprintProduct } from "../types/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

import { buildProductReviews } from "../fixtures/index.js";
import { getAllSalesChannelProductIds, searchAllByEqualsAny } from "../shopware/api-helpers.js";
import {
    getShopLanguages,
    loadAllTranslations,
    planReviewLanguages,
} from "../shopware/languages.js";
import { apiPost, deterministicUUID, logger } from "../utils/index.js";

interface ReviewPayload {
    id: string;
    [field: string]: unknown;
}

/** Title and content of review `index` in the given language (English fallback) */
function localizedReview(
    productId: string,
    index: number,
    review: GeneratedReview,
    language: LanguageContent | undefined
): { title: string; content: string } {
    if (!language || language.content.kind === "source") return review;
    const translated = language.content.file.reviews[productId]?.reviews[index];
    return translated ?? review;
}

/** Shopware review rows for one product */
export function buildReviewPayload(
    product: Pick<BlueprintProduct, "id" | "name">,
    reviewCount: number,
    salesChannelId: string,
    languages: LanguageContent[]
): ReviewPayload[] {
    return buildProductReviews(product.id, product.name, reviewCount).map((review, i) => {
        const language = languages[i % Math.max(languages.length, 1)];
        const { title, content } = localizedReview(product.id, i, review, language);
        return {
            id: deterministicUUID(`review:${product.id}:${i}`),
            productId: product.id,
            salesChannelId,
            ...(language && { languageId: language.language.id }),
            title,
            content,
            points: review.rating,
            status: true,
            externalUser: review.user,
            externalEmail: review.email,
        };
    });
}

/**
 * Review languages for this SalesChannel. Empty when they cannot be read, then reviews
 * are written without `languageId` (Shopware uses the context language).
 */
async function resolveReviewLanguages(context: PostProcessorContext): Promise<LanguageContent[]> {
    try {
        const languages = await getShopLanguages(context.api, context.salesChannelId);
        const translations = loadAllTranslations(context.cache, context.salesChannelName);
        return planReviewLanguages(languages, translations);
    } catch (error) {
        logger.warn("Could not read SalesChannel languages for reviews", { data: error });
        return [];
    }
}

/**
 * True when the product has reviews this generator did not create with stable IDs
 * (older runs used random IDs). Those are kept, so the product is skipped.
 * Our own reviews are upserted again, which updates their language and text.
 */
export function hasForeignReviews(existingIds: string[], payload: Array<{ id: string }>): boolean {
    const ours = new Set(payload.map((r) => r.id));
    return existingIds.some((id) => !ours.has(id));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Review Processor implementation
 */
class ReviewProcessorImpl implements PostProcessor {
    readonly name = "reviews";
    readonly description = "Generate product reviews";
    readonly dependsOn: string[] = []; // No dependencies

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { blueprint, cache, options } = context;

        let processed = 0;
        let skipped = 0;
        const errors: string[] = [];
        let totalReviews = 0;
        let legacyProducts = 0;

        const languages = options.dryRun ? [] : await resolveReviewLanguages(context);
        if (languages.length > 1) {
            const locales = languages.map((l) => l.language.locale).join(", ");
            logger.info(`    Reviews spread across ${locales}`, { cli: true });
        }

        for (const product of blueprint.products) {
            try {
                const metadata = cache.loadProductMetadata(context.salesChannelName, product.id);
                const reviewCount = metadata?.reviewCount || 0;

                if (reviewCount === 0) {
                    skipped++;
                    continue;
                }

                if (options.dryRun) {
                    logger.info(
                        `    [DRY RUN] Would generate ${reviewCount} reviews for ${product.name}`,
                        { cli: true }
                    );
                    totalReviews += reviewCount;
                    processed++;
                    continue;
                }

                const payload = buildReviewPayload(
                    product,
                    reviewCount,
                    context.salesChannelId,
                    languages
                );
                const existingIds = await this.existingReviewIds(context, product.id);
                if (hasForeignReviews(existingIds, payload)) {
                    legacyProducts++;
                    skipped++;
                    continue;
                }
                totalReviews += payload.length;

                const error = await this.createReviews(context, payload);
                if (error) errors.push(`Failed to create reviews for ${product.name}: ${error}`);

                processed++;
            } catch (error) {
                errors.push(
                    `Failed to process reviews for ${product.name}: ${errorMessage(error)}`
                );
            }
        }

        logger.info(`    Wrote ${totalReviews} reviews for ${processed} products`, {
            cli: true,
        });
        if (legacyProducts > 0) {
            logger.warn(
                `    ⚠ ${legacyProducts} products keep reviews from an older run (English only). ` +
                    `Replace them: bun run cleanup -- --salesChannel="${context.salesChannelName}" --processors=reviews`,
                { cli: true }
            );
        }

        return {
            name: this.name,
            processed,
            skipped,
            errors,
            durationMs: 0,
        };
    }

    /** Upsert review rows, returns an error message on failure */
    private async createReviews(
        context: PostProcessorContext,
        payload: ReviewPayload[]
    ): Promise<string | null> {
        const operations = {
            createReviews: { entity: "product_review", action: "upsert" as const, payload },
        };
        try {
            if (context.api) {
                await context.api.syncEntities(operations);
                return null;
            }
            const response = await apiPost(context, "_action/sync", operations);
            if (response.ok) return null;
            logger.apiError("_action/sync (reviews)", response.status, {
                reviewCount: payload.length,
            });
            return `API returned ${response.status}`;
        } catch (error) {
            return errorMessage(error);
        }
    }

    /**
     * Cleanup reviews for products in the SalesChannel
     */
    async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        const errors: string[] = [];
        let deleted = 0;

        if (context.options.dryRun) {
            logger.info(`    [DRY RUN] Would delete reviews for products in SalesChannel`, {
                cli: true,
            });
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        if (!context.api) {
            errors.push("API helpers not available - cannot perform cleanup");
            return { name: this.name, deleted: 0, errors, durationMs: 0 };
        }

        try {
            // Step 1: Get all products in this SalesChannel
            const productIds = await getAllSalesChannelProductIds(context);

            if (productIds.length === 0) {
                logger.info(`    No products found in SalesChannel`, { cli: true });
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            logger.info(`    Found ${productIds.length} products in SalesChannel`, { cli: true });

            // Step 2: Find all reviews for these products
            const reviews = await searchAllByEqualsAny<{ id: string }>(
                context,
                "product-review",
                "productId",
                productIds,
                { includes: { product_review: ["id"] } }
            );
            const reviewIds = reviews.map((review) => review.id);

            if (reviewIds.length === 0) {
                logger.info(`    No reviews found for products`, { cli: true });
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            logger.info(`    Found ${reviewIds.length} reviews to delete`, { cli: true });

            // Step 3: Delete reviews
            await context.api.deleteEntities("product_review", reviewIds);

            deleted = reviewIds.length;
        } catch (error) {
            errors.push(
                `Review cleanup failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        return { name: this.name, deleted, errors, durationMs: 0 };
    }

    /** IDs of the reviews this product already has in Shopware */
    private async existingReviewIds(
        context: PostProcessorContext,
        productId: string
    ): Promise<string[]> {
        try {
            const response = await apiPost(context, "search/product-review", {
                filter: [{ type: "equals", field: "productId", value: productId }],
                limit: 500,
                includes: { product_review: ["id"] },
            });
            if (!response.ok) return [];
            const data = (await response.json()) as { data?: Array<{ id?: string }> };
            return (data.data ?? []).map((r) => r.id).filter((id): id is string => Boolean(id));
        } catch {
            // On error, assume no reviews (upsert by stable ID cannot duplicate ours)
            return [];
        }
    }
}

/** Review processor singleton */
export const ReviewProcessor = new ReviewProcessorImpl();
