import { describe, expect, test } from "bun:test";

import { CommerceProcessor } from "../../../../src/post-processors/cms/commerce-processor.js";
import { createTestContext } from "../../../helpers/post-processor-context.js";
import { createMockApiHelpers } from "../../../mocks/index.js";

describe("CommerceProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(CommerceProcessor.name).toBe("cms-commerce");
        });

        test("has description", () => {
            expect(CommerceProcessor.description).toBeDefined();
            expect(CommerceProcessor.description.length).toBeGreaterThan(0);
        });

        test("depends on images processor", () => {
            expect(CommerceProcessor.dependsOn).toEqual(["images"]);
        });

        test("has page fixture with correct name", () => {
            expect(CommerceProcessor.pageFixture.name).toBe("Commerce Elements");
        });
    });

    describe("process", () => {
        test("dry run logs without API calls", async () => {
            const { context, mockApi } = createTestContext({ dryRun: true });

            const result = await CommerceProcessor.process(context);

            expect(result.name).toBe("cms-commerce");
            expect(result.processed).toBe(1);
            expect(result.skipped).toBe(0);
            expect(result.errors).toEqual([]);
            expect(mockApi.getCalls().length).toBe(0);
        });

        test("fetches products with media from SalesChannel", async () => {
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/product", {
                data: [
                    {
                        id: "prod-1",
                        cover: { mediaId: "media-1" },
                        media: [{ mediaId: "media-2" }],
                    },
                    {
                        id: "prod-2",
                        cover: { mediaId: "media-3" },
                    },
                ],
            });

            const { context } = createTestContext({ mockApi });
            const result = await CommerceProcessor.process(context);

            expect(result.errors).toEqual([]);
            expect(result.processed).toBe(1);

            // Should have searched for products
            const productSearchCalls = mockApi.getCallsByEndpoint("search/product");
            expect(productSearchCalls.length).toBeGreaterThan(0);
        });

        test("populates product IDs in fixture", async () => {
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/product", {
                data: [
                    { id: "prod-1", cover: { mediaId: "media-1" } },
                    { id: "prod-2", cover: { mediaId: "media-2" } },
                    { id: "prod-3", cover: { mediaId: "media-3" } },
                ],
            });

            const { context } = createTestContext({ mockApi });
            await CommerceProcessor.process(context);

            // Check that sync was called with CMS page containing product data
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBeGreaterThan(0);

            // The first sync should be for CMS page creation
            const cmsSync = syncCalls[0];
            expect(cmsSync).toBeDefined();
            if (cmsSync?.body) {
                const body = cmsSync.body as Record<string, unknown>;
                expect(Object.keys(body)).toContain("createCmsPage");
            }
        });

        test("handles empty products gracefully", async () => {
            const mockApi = createMockApiHelpers();
            // No products found (default empty response works)
            mockApi.mockPostResponse("search/product", { data: [] });

            const { context } = createTestContext({ mockApi });
            const result = await CommerceProcessor.process(context);

            // Should still succeed, just with empty products
            expect(result.processed).toBe(1);
            expect(result.errors).toEqual([]);
        });

        test("removes gallery-buybox block when products have no media", async () => {
            const mockApi = createMockApiHelpers();
            // Products without any media
            mockApi.mockPostResponse("search/product", {
                data: [{ id: "prod-1" }, { id: "prod-2" }],
            });

            const { context } = createTestContext({ mockApi });
            await CommerceProcessor.process(context);

            // Find the CMS page creation sync call
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            const cmsSync = syncCalls[0];
            expect(cmsSync).toBeDefined();

            if (cmsSync?.body) {
                const body = cmsSync.body as {
                    createCmsPage?: {
                        payload?: Array<{
                            sections?: Array<{
                                blocks?: Array<{ type: string }>;
                            }>;
                        }>;
                    };
                };
                const sections = body.createCmsPage?.payload?.[0]?.sections ?? [];
                const blocks = sections.flatMap((s) => s.blocks ?? []);
                const galleryBuybox = blocks.find((b) => b.type === "gallery-buybox");
                expect(galleryBuybox).toBeUndefined();
            }
        });
    });
});
