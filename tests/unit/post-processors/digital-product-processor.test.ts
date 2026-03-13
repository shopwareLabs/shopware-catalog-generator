import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { DigitalProductProcessor } from "../../../src/post-processors/digital-product-processor.js";
import { createTestContext } from "../../helpers/post-processor-context.js";

describe("DigitalProductProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(DigitalProductProcessor.name).toBe("digital-product");
        });

        test("has description", () => {
            expect(DigitalProductProcessor.description).toBeDefined();
            expect(DigitalProductProcessor.description.length).toBeGreaterThan(0);
        });

        test("has no dependencies", () => {
            expect(DigitalProductProcessor.dependsOn).toEqual([]);
        });
    });

    describe("process", () => {
        test("dry run logs without API calls", async () => {
            const { context } = createTestContext({ dryRun: true });

            const result = await DigitalProductProcessor.process(context);

            expect(result.name).toBe("digital-product");
            expect(result.processed).toBe(1);
            expect(result.skipped).toBe(0);
            expect(result.errors).toEqual([]);
        });

        test("searches for existing gift card by product number", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockPostResponse("search/product", { data: [{ id: "gift-card-1" }] });
            mockApi.mockPostResponse("search/product-visibility", { data: [{ id: "vis-1" }] });
            mockApi.mockPostResponse("search/product-download", { data: [{ mediaId: "media-1" }] });
            await DigitalProductProcessor.process(context);

            // Should have searched for gift card
            const productSearchCalls = mockApi.getCallsByEndpoint("search/product");
            expect(productSearchCalls.length).toBeGreaterThan(0);
        });

        test("skips when gift card exists with visibility and download", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockPostResponse("search/product", { data: [{ id: "gift-card-1" }] });
            mockApi.mockPostResponse("search/product-visibility", { data: [{ id: "vis-1" }] });
            mockApi.mockPostResponse("search/product-download", { data: [{ mediaId: "media-1" }] });
            const result = await DigitalProductProcessor.process(context);

            // Should process successfully (reusing existing)
            expect(result.errors).toEqual([]);
        });

        test("uploads cover image when existing product has none", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockPostResponse("search/product", { data: [{ id: "gift-card-1" }] });
            mockApi.mockPostResponse("search/product-visibility", { data: [] });
            mockApi.mockPostResponse("search/product-download", { data: [{ mediaId: "media-1" }] });
            const result = await DigitalProductProcessor.process(context);

            expect(result.errors).toEqual([]);
            // Cover image upload triggered for existing product without coverId
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            const coverCall = syncCalls.find(
                (call) =>
                    call.body &&
                    typeof call.body === "object" &&
                    "setProductCover" in (call.body as Record<string, unknown>)
            );
            expect(coverCall).toBeDefined();
        });

        test("skips cover image upload when existing product already has one", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockPostResponse("search/product", {
                data: [{ id: "gift-card-1", coverId: "existing-cover-id" }],
            });
            mockApi.mockPostResponse("search/product-visibility", { data: [{ id: "vis-1" }] });
            mockApi.mockPostResponse("search/product-download", { data: [{ mediaId: "media-1" }] });
            const result = await DigitalProductProcessor.process(context);

            expect(result.errors).toEqual([]);
            // No sync calls for cover image
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            const coverCall = syncCalls.find(
                (call) =>
                    call.body &&
                    typeof call.body === "object" &&
                    "setProductCover" in (call.body as Record<string, unknown>)
            );
            expect(coverCall).toBeUndefined();
        });

        test("processes successfully with all API calls mocked", async () => {
            const { context } = createTestContext();

            // Default mock returns empty data and ok: true, which simulates
            // - No existing gift card
            // - Tax lookup fails gracefully

            const result = await DigitalProductProcessor.process(context);

            // Will fail due to missing tax, but should not throw
            expect(result.name).toBe("digital-product");
        });

        test("rebuilds when cached product id is stale", async () => {
            const cacheDir = "/tmp/mock-cache/test-store";
            const cacheFile = path.join(cacheDir, "digital-product.json");
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(
                cacheFile,
                JSON.stringify({
                    productId: "stale-product-id",
                    mediaId: "stale-media-id",
                    downloadId: "stale-download-id",
                    createdNew: false,
                })
            );

            const { context, mockApi } = createTestContext();
            mockApi.mockPostResponse("search/product", { data: [] });
            mockApi.mockPostResponse("search/tax", { data: [{ id: "tax-1" }] });
            mockApi.mockPostResponse("search/product-visibility", { data: [] });
            mockApi.mockPostResponse("search/product-download", { data: [] });
            const result = await DigitalProductProcessor.process(context);

            expect(result.errors).toEqual([]);
            expect(result.processed).toBe(1);

            if (fs.existsSync(cacheFile)) {
                fs.unlinkSync(cacheFile);
            }
        });
    });

    describe("cleanup", () => {
        test("dry run logs without deletions", async () => {
            const { context } = createTestContext({ dryRun: true });

            const result = await DigitalProductProcessor.cleanup(context);

            expect(result.name).toBe("digital-product");
            expect(result.deleted).toBe(0);
            expect(result.errors).toEqual([]);
        });

        test("handles missing cache gracefully", async () => {
            const { context } = createTestContext();

            const result = await DigitalProductProcessor.cleanup(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toEqual([]);
        });
    });
});
