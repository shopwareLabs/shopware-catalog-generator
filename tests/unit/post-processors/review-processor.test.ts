import { describe, expect, mock, test } from "bun:test";

import type { ProductMetadata } from "../../../src/types/index.js";

import { buildProductReviews } from "../../../src/fixtures/review-data.js";
import {
    buildReviewPayload,
    hasForeignReviews,
    ReviewProcessor,
} from "../../../src/post-processors/review-processor.js";
import { deterministicUUID } from "../../../src/utils/uuid.js";
import { createTestBlueprint, createTestProduct } from "../../helpers/blueprint-factory.js";
import { createTestContext } from "../../helpers/post-processor-context.js";
import {
    createTranslationFile,
    DE,
    EN,
    source,
    translation,
} from "../../helpers/translation-factory.js";

describe("ReviewProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(ReviewProcessor.name).toBe("reviews");
        });

        test("has description", () => {
            expect(ReviewProcessor.description).toBeDefined();
            expect(ReviewProcessor.description.length).toBeGreaterThan(0);
        });

        test("has no dependencies", () => {
            expect(ReviewProcessor.dependsOn).toEqual([]);
        });
    });

    describe("process", () => {
        test("skips products with zero reviews", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: { reviewCount: 0 },
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        metadata: { reviewCount: 0 },
                    }),
                ],
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { reviewCount: 0 }],
                ["p2", { reviewCount: 0 }],
            ]);

            const { context } = createTestContext({ blueprint, metadataMap });
            const result = await ReviewProcessor.process(context);

            expect(result.skipped).toBe(2);
            expect(result.processed).toBe(0);
        });

        test("processes products with reviews in dry run mode", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: { reviewCount: 3 },
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        metadata: { reviewCount: 5 },
                    }),
                    createTestProduct({
                        id: "p3",
                        name: "Product 3",
                        metadata: { reviewCount: 0 },
                    }),
                ],
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { reviewCount: 3 }],
                ["p2", { reviewCount: 5 }],
                ["p3", { reviewCount: 0 }],
            ]);

            const { context } = createTestContext({ blueprint, metadataMap, dryRun: true });
            const result = await ReviewProcessor.process(context);

            expect(result.processed).toBe(2); // p1 and p2
            expect(result.skipped).toBe(1); // p3
            expect(result.errors).toHaveLength(0);
        });

        test("handles missing product metadata", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: { reviewCount: 3 },
                    }),
                ],
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>();

            const { context } = createTestContext({ blueprint, metadataMap });
            const result = await ReviewProcessor.process(context);

            expect(result.skipped).toBe(1);
            expect(result.processed).toBe(0);
        });

        test("skips products that already have reviews in Shopware", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: { reviewCount: 3 },
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        metadata: { reviewCount: 5 },
                    }),
                ],
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { reviewCount: 3 }],
                ["p2", { reviewCount: 5 }],
            ]);

            const { context, mockApi } = createTestContext({
                blueprint,
                metadataMap,
                dryRun: false,
            });

            mockApi.mockPostResponse("search/product-review", {
                total: 3,
                data: [{ id: "r1" }],
            });

            mockApi.setDefaultPostResponse({ success: true });
            mockApi.mockSyncSuccess();
            const result = await ReviewProcessor.process(context);

            // With MockApiHelpers returning same response for all calls,
            // both products appear to have reviews (total: 3), so both are skipped
            expect(result.skipped).toBe(2); // Both skipped due to mock returning existing reviews
            expect(result.processed).toBe(0);
        });

        test("creates reviews when product has no existing reviews", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: { reviewCount: 3 },
                    }),
                ],
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { reviewCount: 3 }],
            ]);

            const { context, mockApi } = createTestContext({ blueprint, metadataMap });

            mockApi.mockPostResponse("search/product-review", {
                total: 0,
                data: [],
            });

            mockApi.mockSyncSuccess();
            const result = await ReviewProcessor.process(context);

            expect(result.processed).toBe(1);
            expect(result.skipped).toBe(0);
            expect(result.errors).toHaveLength(0);

            // Verify sync was called with reviews
            expect(mockApi.syncEntitiesMock).toHaveBeenCalled();
        });

        test("handles API error when creating reviews", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: { reviewCount: 2 },
                    }),
                ],
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { reviewCount: 2 }],
            ]);

            const { context, mockApi } = createTestContext({ blueprint, metadataMap });

            mockApi.mockPostResponse("search/product-review", {
                total: 0,
                data: [],
            });

            mockApi.syncEntities = mock(async () => {
                throw new Error("API error");
            });
            const result = await ReviewProcessor.process(context);

            expect(result.processed).toBe(1);
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain("Failed to create reviews");
        });

        test("handles various review counts", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: { reviewCount: 1 },
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        metadata: { reviewCount: 5 },
                    }),
                    createTestProduct({
                        id: "p3",
                        name: "Product 3",
                        metadata: { reviewCount: 10 },
                    }),
                ],
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { reviewCount: 1 }],
                ["p2", { reviewCount: 5 }],
                ["p3", { reviewCount: 10 }],
            ]);

            const { context, mockApi } = createTestContext({ blueprint, metadataMap });
            mockApi.mockPostResponse("search/product-review", { total: 0, data: [] });
            mockApi.mockSyncSuccess();
            const result = await ReviewProcessor.process(context);

            expect(result.processed).toBe(3);
            expect(result.skipped).toBe(0);
        });
    });

    describe("cleanup", () => {
        test("returns early in dry run mode", async () => {
            const blueprint = createTestBlueprint({ products: [] });
            const metadataMap = new Map<string, Partial<ProductMetadata>>();

            const { context } = createTestContext({
                blueprint,
                metadataMap,
                dryRun: true,
            });

            const result = await ReviewProcessor.cleanup!(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("returns 0 deleted when no products found", async () => {
            const blueprint = createTestBlueprint({ products: [] });
            const metadataMap = new Map<string, Partial<ProductMetadata>>();

            const { context, mockApi } = createTestContext({ blueprint, metadataMap });
            mockApi.mockSearchResponse("product", []);
            const result = await ReviewProcessor.cleanup!(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("returns 0 deleted when no reviews found", async () => {
            const blueprint = createTestBlueprint({ products: [] });
            const metadataMap = new Map<string, Partial<ProductMetadata>>();

            const { context, mockApi } = createTestContext({ blueprint, metadataMap });
            mockApi.mockSearchResponse("product", [{ id: "p1" }, { id: "p2" }]);
            mockApi.mockSearchResponse("product-review", []);
            const result = await ReviewProcessor.cleanup(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("deletes reviews successfully", async () => {
            const blueprint = createTestBlueprint({ products: [] });
            const metadataMap = new Map<string, Partial<ProductMetadata>>();

            const { context, mockApi } = createTestContext({ blueprint, metadataMap });
            mockApi.mockSearchResponse("product", [{ id: "p1" }, { id: "p2" }]);
            mockApi.mockSearchResponse("product-review", [
                { id: "r1" },
                { id: "r2" },
                { id: "r3" },
            ]);

            mockApi.deleteEntities = mock(async () => {});
            const result = await ReviewProcessor.cleanup!(context);

            expect(result.deleted).toBe(3);
            expect(result.errors).toHaveLength(0);
            expect(mockApi.deleteEntities).toHaveBeenCalledWith("product_review", [
                "r1",
                "r2",
                "r3",
            ]);
        });

        test("handles cleanup error", async () => {
            const blueprint = createTestBlueprint({ products: [] });
            const metadataMap = new Map<string, Partial<ProductMetadata>>();

            const { context, mockApi } = createTestContext({ blueprint, metadataMap });
            mockApi.searchEntities = mock(async () => {
                throw new Error("Search failed");
            });
            const result = await ReviewProcessor.cleanup!(context);

            expect(result.deleted).toBe(0);
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain("Review cleanup failed");
        });
    });
});

describe("buildReviewPayload", () => {
    const product = { id: "p1", name: "Desk Lamp" };
    const english = buildProductReviews("p1", "Desk Lamp", 4);
    const germanFile = createTranslationFile({
        reviews: {
            p1: {
                reviews: english.map((_, i) => ({ title: `Titel ${i}`, content: `Inhalt ${i}` })),
                sourceHash: "h",
            },
        },
    });

    test("spreads reviews across languages, translated where a file exists", () => {
        const payload = buildReviewPayload(product, 4, "sc-1", [
            source(EN),
            translation(DE, germanFile),
        ]);
        expect(payload.map((r) => r.languageId)).toEqual([EN.id, DE.id, EN.id, DE.id]);
        expect(payload[0]?.title).toBe(english[0]?.title);
        expect(payload[1]).toMatchObject({ title: "Titel 1", content: "Inhalt 1" });
        expect(payload[3]).toMatchObject({ title: "Titel 3", content: "Inhalt 3" });
    });

    test("uses stable IDs so re-runs upsert the same rows", () => {
        const first = buildReviewPayload(product, 2, "sc-1", [source(EN)]);
        const second = buildReviewPayload(product, 2, "sc-1", [source(EN)]);
        expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id));
        expect(first[0]?.id).toBe(deterministicUUID("review:p1:0"));
    });

    test("without languages, no languageId is set and texts stay English", () => {
        const [review] = buildReviewPayload(product, 1, "sc-1", []);
        expect(review).not.toHaveProperty("languageId");
        expect(review?.title).toBe(english[0]?.title);
    });

    test("falls back to English when a translated review is missing", () => {
        const partial = createTranslationFile({
            reviews: {
                p1: { reviews: [{ title: "Nur eins", content: "Inhalt" }], sourceHash: "h" },
            },
        });
        const payload = buildReviewPayload(product, 2, "sc-1", [translation(DE, partial)]);
        expect(payload[0]?.title).toBe("Nur eins");
        expect(payload[1]?.title).toBe(english[1]?.title);
    });
});

describe("hasForeignReviews", () => {
    const payload = [{ id: "a" }, { id: "b" }];

    test("no existing reviews", () => {
        expect(hasForeignReviews([], payload)).toBe(false);
    });

    test("only our own stable IDs", () => {
        expect(hasForeignReviews(["b", "a"], payload)).toBe(false);
    });

    test("any review with another ID (older run, manual review)", () => {
        expect(hasForeignReviews(["a", "legacy"], payload)).toBe(true);
    });
});

describe("ReviewProcessor re-run", () => {
    test("upserts reviews it created before, so language and text follow the translations", async () => {
        const blueprint = createTestBlueprint({
            products: [createTestProduct({ id: "p1", metadata: { reviewCount: 2 } })],
        });
        const metadataMap = new Map<string, Partial<ProductMetadata>>([["p1", { reviewCount: 2 }]]);
        const { context, mockApi } = createTestContext({ blueprint, metadataMap, dryRun: false });
        mockApi.mockPostResponse("search/product-review", {
            total: 2,
            data: [
                { id: deterministicUUID("review:p1:0") },
                { id: deterministicUUID("review:p1:1") },
            ],
        });
        mockApi.mockSyncSuccess();

        const result = await ReviewProcessor.process(context);

        expect(result.processed).toBe(1);
        expect(result.skipped).toBe(0);
        expect(mockApi.syncEntitiesMock).toHaveBeenCalled();
    });
});
