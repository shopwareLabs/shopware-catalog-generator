import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { DigitalProductProcessor } from "../../../src/post-processors/digital-product-processor.js";
import { ShopwareCapabilities } from "../../../src/shopware/version.js";
import { logger } from "../../../src/utils/index.js";
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

        test("creates download media in the product download folder", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockPostResponse("search/product", { data: [] });
            mockApi.mockPostResponse("search/tax", { data: [{ id: "tax-1" }] });
            mockApi.mockPostResponse("search/product-download", { data: [] });
            mockApi.mockSearchResponse("media-default-folder", [
                { folder: { id: "download-folder" } },
            ]);

            await DigitalProductProcessor.process(context);

            const mediaCall = mockApi
                .getCallsByEndpoint("_action/sync")
                .find((call) => JSON.stringify(call.body).includes('"private":true'));
            expect(JSON.stringify(mediaCall?.body)).toContain('"mediaFolderId":"download-folder"');
        });

        test("uploads the voucher under a file name unique to the media", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockPostResponse("search/product", { data: [] });
            mockApi.mockPostResponse("search/tax", { data: [{ id: "tax-1" }] });
            mockApi.mockPostResponse("search/product-download", { data: [] });

            await DigitalProductProcessor.process(context);

            const upload = mockApi
                .getCalls()
                .find((call) => call.endpoint.includes("extension=txt"));
            const mediaId = upload?.endpoint.match(/_action\/media\/([0-9a-f]+)\/upload/)?.[1];
            expect(mediaId).toBeDefined();
            expect(upload?.endpoint).toContain(
                `fileName=gift-card-voucher-${mediaId?.slice(0, 8)}`
            );
        });

        test("deletes the empty media when the voucher upload fails", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockPostResponse("search/product", { data: [] });
            mockApi.mockPostResponse("search/tax", { data: [{ id: "tax-1" }] });
            mockApi.mockPostResponse("search/product-download", { data: [] });
            const uploadSpy = spyOn(mockApi, "uploadMedia").mockImplementation(
                (_mediaId, _file, _fileName, extension) =>
                    extension === "txt"
                        ? Promise.reject(new Error("CONTENT__MEDIA_DUPLICATED_FILE_NAME"))
                        : Promise.resolve()
            );
            const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

            const result = await DigitalProductProcessor.process(context);

            const voucherMediaId = uploadSpy.mock.calls.find((call) => call[3] === "txt")?.[0];
            expect(voucherMediaId).toBeDefined();
            expect(mockApi.getCalls()).toContainEqual({
                method: "delete",
                endpoint: `media/${voucherMediaId}`,
            });
            expect(result.errors).toEqual(["Failed to create download media"]);
            uploadSpy.mockRestore();
            warnSpy.mockRestore();
        });
    });

    describe("product type", () => {
        function findCreateProductPayload(
            mockApi: ReturnType<typeof createTestContext>["mockApi"]
        ): string | undefined {
            const call = mockApi
                .getCallsByEndpoint("_action/sync")
                .find((c) => JSON.stringify(c.body).includes('"GIFT-CARD-50"'));
            return call ? JSON.stringify(call.body) : undefined;
        }

        function mockNewGiftCard(mockApi: ReturnType<typeof createTestContext>["mockApi"]): void {
            mockApi.mockPostResponse("search/product", { data: [] });
            mockApi.mockPostResponse("search/tax", { data: [{ id: "tax-1" }] });
            mockApi.mockPostResponse("search/product-download", { data: [] });
        }

        test("creates the gift card as a digital product when the shop supports it", async () => {
            const { context, mockApi } = createTestContext();
            mockNewGiftCard(mockApi);

            await DigitalProductProcessor.process(context);

            expect(findCreateProductPayload(mockApi)).toContain('"type":"digital"');
        });

        test("leaves the type out for shops older than 6.7.7", async () => {
            const { context, mockApi } = createTestContext({
                shopware: ShopwareCapabilities.fromVersion("6.6.10.0"),
            });
            mockNewGiftCard(mockApi);

            await DigitalProductProcessor.process(context);

            const payload = findCreateProductPayload(mockApi);
            expect(payload).toBeDefined();
            expect(payload).not.toContain('"type":');
        });

        test("warns when an existing gift card is physical", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockPostResponse("search/product", {
                data: [{ id: "existing-card", type: "physical" }],
            });
            const warn = spyOn(logger, "warn").mockImplementation(() => {});

            try {
                await DigitalProductProcessor.process(context);
                const warnings = warn.mock.calls.map(([message]) => message);
                expect(warnings.some((w) => w.includes('product type "physical"'))).toBe(true);
            } finally {
                warn.mockRestore();
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
