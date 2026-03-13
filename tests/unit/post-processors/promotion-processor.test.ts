import { describe, expect, test } from "bun:test";

import { PROMOTIONS } from "../../../src/fixtures/promotions.js";
import { PromotionProcessor } from "../../../src/post-processors/promotion-processor.js";
import { createTestContext } from "../../helpers/post-processor-context.js";

describe("PromotionProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(PromotionProcessor.name).toBe("promotions");
        });

        test("has description", () => {
            expect(PromotionProcessor.description).toBeDefined();
            expect(PromotionProcessor.description.length).toBeGreaterThan(0);
        });

        test("has no dependencies", () => {
            expect(PromotionProcessor.dependsOn).toEqual([]);
        });
    });

    describe("process", () => {
        test("dry run reports what would be created", async () => {
            const { context } = createTestContext({ dryRun: true });
            const result = await PromotionProcessor.process(context);

            expect(result.name).toBe("promotions");
            expect(result.processed).toBe(PROMOTIONS.length);
            expect(result.errors).toEqual([]);
        });

        test("creates all promotions", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponse("promotion", []);

            const result = await PromotionProcessor.process(context);

            expect(result.processed).toBe(PROMOTIONS.length);
            expect(result.skipped).toBe(0);
            expect(result.errors).toEqual([]);

            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBe(PROMOTIONS.length);
        });

        test("creates promotion with correct payload structure", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponse("promotion", []);

            await PromotionProcessor.process(context);

            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            const firstCall = syncCalls[0];
            expect(firstCall).toBeDefined();

            const body = firstCall?.body as Record<
                string,
                { entity: string; payload: Array<Record<string, unknown>> }
            >;
            const operationKey = Object.keys(body)[0] ?? "";
            const operation = body[operationKey];
            expect(operation).toBeDefined();
            expect(operation?.entity).toBe("promotion");

            const payload = operation?.payload[0];
            expect(payload).toBeDefined();
            if (!payload) return;

            expect(payload.name).toBe("Welcome Discount");
            expect(payload.active).toBe(true);
            expect(payload.useCodes).toBe(true);
            expect(payload.code).toBe("WELCOME10");
            expect(payload.validFrom).toBeDefined();
            expect(payload.validUntil).toBeDefined();

            const salesChannels = payload.salesChannels as Array<Record<string, unknown>>;
            expect(salesChannels).toHaveLength(1);
            expect(salesChannels[0]?.salesChannelId).toBe("sc-123");

            const discounts = payload.discounts as Array<Record<string, unknown>>;
            expect(discounts).toHaveLength(1);
            expect(discounts[0]?.type).toBe("percentage");
            expect(discounts[0]?.value).toBe(10);
            expect(discounts[0]?.scope).toBe("cart");
        });

        test("creates percentage discount with maxValue", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponse("promotion", []);

            await PromotionProcessor.process(context);

            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            // Summer Sale is the second promotion (index 1)
            const summerSaleCall = syncCalls[1];
            const body = summerSaleCall?.body as Record<
                string,
                { payload: Array<Record<string, unknown>> }
            >;
            const operationKey = Object.keys(body)[0] ?? "";
            const payload = body[operationKey]?.payload[0];
            if (!payload) return;

            const discounts = payload.discounts as Array<Record<string, unknown>>;
            expect(discounts[0]?.value).toBe(20);
            expect(discounts[0]?.maxValue).toBe(50);
        });

        test("creates delivery scope discount for free shipping", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponse("promotion", []);

            await PromotionProcessor.process(context);

            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            // FREESHIP is the last promotion
            const freeShipCall = syncCalls[PROMOTIONS.length - 1];
            const body = freeShipCall?.body as Record<
                string,
                { payload: Array<Record<string, unknown>> }
            >;
            const operationKey = Object.keys(body)[0] ?? "";
            const payload = body[operationKey]?.payload[0];
            if (!payload) return;

            expect(payload.code).toBe("FREESHIP");
            const discounts = payload.discounts as Array<Record<string, unknown>>;
            expect(discounts[0]?.scope).toBe("delivery");
            expect(discounts[0]?.type).toBe("percentage");
            expect(discounts[0]?.value).toBe(100);
        });

        test("skips existing promotions and links them to SalesChannel", async () => {
            const { context, mockApi } = createTestContext();
            // Mock by code (new lookup strategy)
            mockApi.mockSearchResponse("promotion", [
                { id: "existing-1", code: "WELCOME10" },
                { id: "existing-2", code: "SUMMER20" },
            ]);

            const result = await PromotionProcessor.process(context);

            expect(result.processed).toBe(2);
            expect(result.skipped).toBe(2);
            expect(result.errors).toEqual([]);

            // 2 new promotions created + 2 SalesChannel link syncs for existing ones
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBe(4);
        });

        test("is fully idempotent when all promotions exist", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponse(
                "promotion",
                PROMOTIONS.map((p, i) => ({ id: `existing-${i}`, code: p.code }))
            );

            const result = await PromotionProcessor.process(context);

            expect(result.processed).toBe(0);
            expect(result.skipped).toBe(PROMOTIONS.length);

            // Only SalesChannel link syncs, no promotion creation syncs
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBe(PROMOTIONS.length);
        });

        test("uses a deterministic association ID for existing promotions (no random UUIDs)", async () => {
            // Run the processor twice with the same existing promotions and verify the
            // association ID in the upsert payload is identical both times. A random ID
            // would create duplicate rows on every run; a deterministic one enables true upsert.
            const runAndCollectIds = async (): Promise<string[]> => {
                const { context, mockApi } = createTestContext();
                mockApi.mockSearchResponse("promotion", [{ id: "promo-abc", code: "WELCOME10" }]);
                await PromotionProcessor.process(context);

                const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
                const ids: string[] = [];
                for (const call of syncCalls) {
                    const body = call.body as Record<
                        string,
                        { entity: string; payload: Array<{ id?: string }> }
                    >;
                    for (const op of Object.values(body)) {
                        if (op.entity === "promotion_sales_channel") {
                            for (const row of op.payload) {
                                if (row.id) ids.push(row.id);
                            }
                        }
                    }
                }
                return ids;
            };

            const [firstRun, secondRun] = await Promise.all([runAndCollectIds(), runAndCollectIds()]);
            expect(firstRun.length).toBeGreaterThan(0);
            expect(firstRun).toEqual(secondRun);
        });

        test("handles API error gracefully", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponse("promotion", []);
            mockApi.mockSyncFailure(new Error("API error"));

            const result = await PromotionProcessor.process(context);

            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain("API error");
        });

        test("sets validUntil one year from now", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponse("promotion", []);

            await PromotionProcessor.process(context);

            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            const body = syncCalls[0]?.body as Record<
                string,
                { payload: Array<Record<string, unknown>> }
            >;
            const operationKey = Object.keys(body)[0] ?? "";
            const payload = body[operationKey]?.payload[0];
            if (!payload) return;

            const validFrom = new Date(payload.validFrom as string);
            const validUntil = new Date(payload.validUntil as string);
            const diffMs = validUntil.getTime() - validFrom.getTime();
            const diffDays = diffMs / (1000 * 60 * 60 * 24);

            expect(diffDays).toBeGreaterThanOrEqual(364);
            expect(diffDays).toBeLessThanOrEqual(366);
        });
    });

    describe("cleanup", () => {
        test("returns early in dry run mode", async () => {
            const { context } = createTestContext({ dryRun: true });
            const result = await PromotionProcessor.cleanup!(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toEqual([]);
        });

        test("deletes existing promotions", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponse("promotion", [
                { id: "promo-1", name: "Welcome Discount" },
                { id: "promo-2", name: "Summer Sale" },
            ]);

            const result = await PromotionProcessor.cleanup!(context);

            expect(result.deleted).toBe(2);
            expect(result.errors).toEqual([]);

            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            const deleteCall = syncCalls.find((c) => {
                const body = c.body as Record<string, { action: string }>;
                return Object.values(body).some((op) => op.action === "delete");
            });
            expect(deleteCall).toBeDefined();
        });

        test("handles no promotions found", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponse("promotion", []);

            const result = await PromotionProcessor.cleanup!(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toEqual([]);
        });

        test("handles cleanup error", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponse("promotion", [{ id: "promo-1", name: "Welcome Discount" }]);
            mockApi.mockSyncFailure(new Error("Delete failed"));

            const result = await PromotionProcessor.cleanup!(context);

            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain("Delete failed");
        });
    });
});

describe("Promotion Fixtures", () => {
    test("all promotions have required fields", () => {
        for (const promo of PROMOTIONS) {
            expect(promo.name).toBeDefined();
            expect(promo.code).toBeDefined();
            expect(promo.code.length).toBeGreaterThan(0);
            expect(["percentage", "absolute"]).toContain(promo.discountType);
            expect(promo.discountValue).toBeGreaterThanOrEqual(0);
            expect(["cart", "delivery"]).toContain(promo.scope);
        }
    });

    test("all promotion codes are unique", () => {
        const codes = PROMOTIONS.map((p) => p.code);
        expect(new Set(codes).size).toBe(codes.length);
    });

    test("all promotion names are unique", () => {
        const names = PROMOTIONS.map((p) => p.name);
        expect(new Set(names).size).toBe(names.length);
    });
});
