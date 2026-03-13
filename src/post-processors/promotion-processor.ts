/**
 * Promotion Processor - Creates demo promotions with discount codes
 *
 * Creates promotions from fixtures with:
 * - Fixed discount codes (WELCOME10, SUMMER20, SAVE15, FREESHIP)
 * - Percentage and absolute discount types
 * - Cart and delivery scopes
 * - SalesChannel association
 *
 * Promotions are idempotent -- existing promotions (matched by name) are skipped.
 */

import type { PromotionDiscountPayload } from "../types/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

import { PROMOTIONS } from "../fixtures/promotions.js";
import { generateUUID, logger } from "../utils/index.js";

const PROMOTION_PREFIX = "demo-promo";

class PromotionProcessorImpl implements PostProcessor {
    readonly name = "promotions";
    readonly description = "Create demo promotions with discount codes";
    readonly dependsOn: string[] = [];

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { salesChannelId, options } = context;
        const errors: string[] = [];
        let processed = 0;
        let skipped = 0;

        if (options.dryRun) {
            logger.info(
                `    [DRY RUN] Would create ${PROMOTIONS.length} promotions with discount codes`,
                { cli: true }
            );
            return {
                name: this.name,
                processed: PROMOTIONS.length,
                skipped: 0,
                errors: [],
                durationMs: 0,
            };
        }

        if (!context.api) {
            errors.push("API helpers not available");
            return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
        }

        const existingByCode = await this.findExistingPromotionsByCode(context);

        for (const promo of PROMOTIONS) {
            const existingId = existingByCode.get(promo.code);

            if (existingId) {
                // Promotion code already exists — associate it with this SalesChannel
                try {
                    await this.addSalesChannelToPromotion(context, existingId, salesChannelId);
                    logger.info(
                        `    ⊘ Promotion "${promo.name}" already exists — linked to SalesChannel`,
                        { cli: true }
                    );
                    skipped++;
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    errors.push(`Failed to link promotion "${promo.name}" to SalesChannel: ${msg}`);
                }
                continue;
            }

            try {
                await this.createPromotion(context, promo, salesChannelId);
                logger.info(`    ✓ Created promotion "${promo.name}" (code: ${promo.code})`, {
                    cli: true,
                });
                processed++;
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                errors.push(`Failed to create promotion "${promo.name}": ${msg}`);
            }
        }

        return { name: this.name, processed, skipped, errors, durationMs: 0 };
    }

    async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        const errors: string[] = [];
        let deleted = 0;

        if (context.options.dryRun) {
            logger.info("    [DRY RUN] Would delete demo promotions", { cli: true });
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        if (!context.api) {
            errors.push("API helpers not available - cannot perform cleanup");
            return { name: this.name, deleted: 0, errors, durationMs: 0 };
        }

        try {
            const promotionNames = PROMOTIONS.map((p) => p.name);
            const promotions = await context.api.searchEntities<{ id: string; name: string }>(
                "promotion",
                [{ type: "equalsAny", field: "name", value: promotionNames.join("|") }],
                { includes: { promotion: ["id", "name"] }, limit: 50 }
            );

            if (promotions.length === 0) {
                logger.info("    No demo promotions found", { cli: true });
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            const promotionIds = promotions.map((p) => p.id);
            await context.api.deleteEntities("promotion", promotionIds);
            deleted = promotionIds.length;
            logger.info(`    Deleted ${deleted} promotions`, { cli: true });
        } catch (error) {
            errors.push(
                `Promotion cleanup failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        return { name: this.name, deleted, errors, durationMs: 0 };
    }

    private async createPromotion(
        context: PostProcessorContext,
        promo: (typeof PROMOTIONS)[number],
        salesChannelId: string
    ): Promise<void> {
        const promotionId = generateUUID();
        const discountId = generateUUID();
        const salesChannelAssocId = generateUUID();

        const now = new Date();
        const validUntil = new Date(now);
        validUntil.setFullYear(validUntil.getFullYear() + 1);

        await context.api!.syncEntities({
            [`${PROMOTION_PREFIX}-${promo.code}`]: {
                entity: "promotion",
                action: "upsert",
                payload: [
                    {
                        id: promotionId,
                        name: promo.name,
                        active: true,
                        validFrom: now.toISOString(),
                        validUntil: validUntil.toISOString(),
                        useCodes: true,
                        useIndividualCodes: false,
                        code: promo.code,
                        maxRedemptionsGlobal: null,
                        maxRedemptionsPerCustomer: null,
                        exclusive: false,
                        preventCombination: false,
                        salesChannels: [
                            {
                                id: salesChannelAssocId,
                                promotionId,
                                salesChannelId,
                                priority: 1,
                            },
                        ],
                        discounts: [this.buildDiscountPayload(discountId, promo)],
                    },
                ],
            },
        });
    }

    private buildDiscountPayload(
        discountId: string,
        promo: (typeof PROMOTIONS)[number]
    ): PromotionDiscountPayload {
        return {
            id: discountId,
            scope: promo.scope,
            type: promo.discountType,
            value: promo.discountValue,
            considerAdvancedRules: false,
            maxValue: promo.maxValue,
        };
    }

    /** Returns a map of promotion code → promotion ID for all known promo codes. */
    private async findExistingPromotionsByCode(
        context: PostProcessorContext
    ): Promise<Map<string, string>> {
        if (!context.api) return new Map();

        try {
            const codes = PROMOTIONS.map((p) => p.code);
            const promotions = await context.api.searchEntities<{ id: string; code: string }>(
                "promotion",
                [{ type: "equalsAny", field: "code", value: codes }],
                { includes: { promotion: ["id", "code"] }, limit: 50 }
            );
            return new Map(promotions.map((p) => [p.code, p.id]));
        } catch {
            return new Map();
        }
    }

    /** Add a SalesChannel association to an existing promotion (idempotent). */
    private async addSalesChannelToPromotion(
        context: PostProcessorContext,
        promotionId: string,
        salesChannelId: string
    ): Promise<void> {
        await context.api!.syncEntities({
            [`${PROMOTION_PREFIX}-sc-link`]: {
                entity: "promotion_sales_channel",
                action: "upsert",
                payload: [
                    {
                        id: this.deriveAssociationId(promotionId, salesChannelId),
                        promotionId,
                        salesChannelId,
                        priority: 1,
                    },
                ],
            },
        });
    }

    /**
     * Derives a stable 32-char hex ID for a promotion_sales_channel row from the two
     * parent IDs. Using XOR ensures the result is always a valid hex UUID and is
     * unique to each (promotionId, salesChannelId) pair, making the upsert truly
     * idempotent — repeated calls hit the same primary key instead of inserting
     * duplicate rows.
     */
    private deriveAssociationId(promotionId: string, salesChannelId: string): string {
        const a = promotionId.replace(/-/g, "").padEnd(32, "0");
        const b = salesChannelId.replace(/-/g, "").padEnd(32, "0");
        return a
            .split("")
            .map((c, i) => (parseInt(c, 16) ^ parseInt(b[i]!, 16)).toString(16))
            .join("");
    }
}

/** Promotion processor singleton */
export const PromotionProcessor = new PromotionProcessorImpl();
