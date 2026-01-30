import { describe, expect, mock, test } from "bun:test";

import { VIDEO_ELEMENTS_PAGE } from "../../../src/fixtures/index.js";
import { CmsProcessor } from "../../../src/post-processors/cms-processor.js";
import type { PostProcessorContext } from "../../../src/post-processors/index.js";
import type { HydratedBlueprint } from "../../../src/types/index.js";
import { createMockApiHelpers, type MockApiHelpers } from "../../mocks/index.js";

// Helper to create a minimal mock blueprint
function createMockBlueprint(): HydratedBlueprint {
    return {
        version: "1.0",
        salesChannel: { name: "test-store", description: "Test store" },
        categories: [],
        products: [],
        propertyGroups: [],
        createdAt: new Date().toISOString(),
        hydratedAt: new Date().toISOString(),
    };
}

// Helper to create mock cache
function createMockCache() {
    return {
        loadManufacturers: mock(() => null),
        saveManufacturers: mock(() => {}),
        loadProductMetadata: mock(() => null),
    };
}

// Helper to create mock context
function createMockContext(
    options: { dryRun?: boolean; mockApi?: MockApiHelpers } = {}
): PostProcessorContext {
    return {
        salesChannelId: "sc-123",
        salesChannelName: "test-store",
        blueprint: createMockBlueprint(),
        cache: createMockCache() as unknown as PostProcessorContext["cache"],
        shopwareUrl: "https://test.shopware.com",
        getAccessToken: async () => "test-token",
        api: options.mockApi as unknown as PostProcessorContext["api"],
        options: {
            batchSize: 5,
            dryRun: options.dryRun || false,
        },
    };
}

describe("CmsProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(CmsProcessor.name).toBe("cms");
        });

        test("has description", () => {
            expect(CmsProcessor.description).toBeDefined();
            expect(CmsProcessor.description.length).toBeGreaterThan(0);
        });

        test("has no dependencies", () => {
            expect(CmsProcessor.dependsOn).toEqual([]);
        });
    });

    describe("VIDEO_ELEMENTS_PAGE fixture", () => {
        test("has correct page name", () => {
            expect(VIDEO_ELEMENTS_PAGE.name).toBe("Video Elements");
        });

        test("has landingpage type", () => {
            expect(VIDEO_ELEMENTS_PAGE.type).toBe("landingpage");
        });

        test("has one section", () => {
            expect(VIDEO_ELEMENTS_PAGE.sections).toHaveLength(1);
        });

        test("section has correct type and sizing", () => {
            const section = VIDEO_ELEMENTS_PAGE.sections[0];
            expect(section?.type).toBe("default");
            expect(section?.sizingMode).toBe("boxed");
        });

        test("has 4 blocks", () => {
            const blocks = VIDEO_ELEMENTS_PAGE.sections[0]?.blocks;
            expect(blocks).toHaveLength(4);
        });

        test("blocks have correct types in order", () => {
            const blocks = VIDEO_ELEMENTS_PAGE.sections[0]?.blocks || [];
            expect(blocks[0]?.type).toBe("text-hero");
            expect(blocks[1]?.type).toBe("youtube-video");
            expect(blocks[2]?.type).toBe("text-teaser");
            expect(blocks[3]?.type).toBe("vimeo-video");
        });

        test("youtube block has correct video ID", () => {
            const youtubeBlock = VIDEO_ELEMENTS_PAGE.sections[0]?.blocks[1];
            const slot = youtubeBlock?.slots[0];
            expect(slot?.config.videoID).toEqual({ source: "static", value: "15Xe_fJyUgU" });
        });

        test("vimeo block has correct video ID", () => {
            const vimeoBlock = VIDEO_ELEMENTS_PAGE.sections[0]?.blocks[3];
            const slot = vimeoBlock?.slots[0];
            expect(slot?.config.videoID).toEqual({ source: "static", value: "347119375" });
        });
    });

    describe("process - dry run mode", () => {
        test("logs actions without making API calls", async () => {
            const context = createMockContext({ dryRun: true });

            const result = await CmsProcessor.process(context);

            expect(result.name).toBe("cms");
            expect(result.processed).toBe(1);
            expect(result.errors).toHaveLength(0);
        });
    });

    describe("process - API calls", () => {
        test("checks for existing CMS category", async () => {
            const mockApi = createMockApiHelpers();

            // Mock all search endpoints to return existing entities
            mockApi.mockPostResponse("search/sales-channel", {
                data: [{ id: "sc-123", navigationCategoryId: "root-cat-id" }],
            });
            mockApi.mockPostResponse("search/category", {
                data: [{ id: "cms-cat-id" }],
            });
            mockApi.mockPostResponse("search/cms-page", {
                data: [{ id: "cms-page-id" }],
            });
            mockApi.mockPostResponse("search/landing-page", {
                data: [{ id: "landing-page-id" }],
            });
            mockApi.mockSyncSuccess();

            const context = createMockContext({ dryRun: false, mockApi });
            const result = await CmsProcessor.process(context);

            // Should have called search APIs
            const apiCalls = mockApi.getCalls();
            expect(apiCalls.some((c) => c.endpoint.includes("search/sales-channel"))).toBe(true);
            expect(apiCalls.some((c) => c.endpoint.includes("search/category"))).toBe(true);
            expect(apiCalls.some((c) => c.endpoint.includes("search/cms-page"))).toBe(true);
            expect(apiCalls.some((c) => c.endpoint.includes("search/landing-page"))).toBe(true);

            // Should succeed with no errors
            expect(result.errors).toHaveLength(0);
            expect(result.processed).toBe(1);
        });

        test("creates CMS page when it doesn't exist", async () => {
            const mockApi = createMockApiHelpers();

            // Mock sales channel with root category
            mockApi.mockPostResponse("search/sales-channel", {
                data: [{ id: "sc-123", navigationCategoryId: "root-cat-id" }],
            });
            // Mock category search - returns existing category (covers all category queries)
            // The CMS processor will find "CMS" category exists, then create "Video Elements"
            mockApi.mockPostResponse("search/category", {
                data: [{ id: "cms-cat-id" }],
            });
            // No CMS page exists
            mockApi.mockPostResponse("search/cms-page", { data: [] });
            // No landing page exists
            mockApi.mockPostResponse("search/landing-page", { data: [] });
            // Sync succeeds
            mockApi.setDefaultPostResponse({ success: true });
            mockApi.mockSyncSuccess();

            const context = createMockContext({ dryRun: false, mockApi });
            await CmsProcessor.process(context);

            // Should have sync calls for creating CMS page, landing page
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBeGreaterThan(0);

            // Check CMS page was created
            const cmsPageCall = syncCalls.find((c) => {
                const body = c.body as Record<string, unknown>;
                return body.createCmsPage !== undefined;
            });
            expect(cmsPageCall).toBeDefined();

            // Check Landing Page was created
            const landingPageCall = syncCalls.find((c) => {
                const body = c.body as Record<string, unknown>;
                return body.createLandingPage !== undefined;
            });
            expect(landingPageCall).toBeDefined();
        });

        test("skips creation when all entities exist", async () => {
            const mockApi = createMockApiHelpers();

            // Mock all entities as existing
            mockApi.mockPostResponse("search/sales-channel", {
                data: [{ id: "sc-123", navigationCategoryId: "root-cat-id" }],
            });
            mockApi.mockPostResponse("search/category", {
                data: [{ id: "cat-id" }],
            });
            mockApi.mockPostResponse("search/cms-page", {
                data: [{ id: "page-id" }],
            });
            // Landing page must include salesChannels with the current SalesChannel ID
            // to skip the "add SalesChannel to landing page" step
            // Use array format (as returned by search API) with salesChannels association
            mockApi.mockPostResponse("search/landing-page", {
                data: [
                    {
                        id: "landing-page-id",
                        salesChannels: [{ id: "sc-123" }], // Same as context.salesChannelId
                    },
                ],
            });

            const context = createMockContext({ dryRun: false, mockApi });
            const result = await CmsProcessor.process(context);

            // Should not have any sync calls (everything already exists, SalesChannel already associated)
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls).toHaveLength(0);
            expect(result.processed).toBe(1);
            expect(result.errors).toHaveLength(0);
        });

        test("returns error when root category not found", async () => {
            const mockApi = createMockApiHelpers();

            // Mock sales channel without navigationCategoryId
            mockApi.mockPostResponse("search/sales-channel", {
                data: [{ id: "sc-123" }], // No navigationCategoryId
            });
            mockApi.mockPostResponse("search/category", { data: [] });

            const context = createMockContext({ dryRun: false, mockApi });
            const result = await CmsProcessor.process(context);

            expect(result.processed).toBe(0);
            expect(result.errors).toContain("Could not find root category for navigation");
        });

        test("adds SalesChannel to existing landing page when not associated", async () => {
            const mockApi = createMockApiHelpers();

            // Mock all entities as existing
            mockApi.mockPostResponse("search/sales-channel", {
                data: [{ id: "sc-123", navigationCategoryId: "root-cat-id" }],
            });
            mockApi.mockPostResponse("search/category", {
                data: [{ id: "cat-id" }],
            });
            mockApi.mockPostResponse("search/cms-page", {
                data: [{ id: "page-id" }],
            });
            // Landing page exists but with DIFFERENT SalesChannel - not the current one
            mockApi.mockPostResponse("search/landing-page", {
                data: [
                    {
                        id: "landing-page-id",
                        salesChannels: [{ id: "other-sc-456" }], // Different from sc-123
                    },
                ],
            });
            mockApi.mockSyncSuccess();

            const context = createMockContext({ dryRun: false, mockApi });
            const result = await CmsProcessor.process(context);

            // Should have one sync call to add the SalesChannel
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls).toHaveLength(1);

            // Check it's the updateLandingPage operation
            const updateCall = syncCalls.find((c) => {
                const body = c.body as Record<string, unknown>;
                return body.updateLandingPage !== undefined;
            });
            expect(updateCall).toBeDefined();

            expect(result.processed).toBe(1);
            expect(result.errors).toHaveLength(0);
        });
    });

    describe("cleanup", () => {
        // Extract cleanup method with type guard to avoid non-null assertions
        // Bind to preserve 'this' context
        const cleanupMethod = CmsProcessor.cleanup;
        if (!cleanupMethod) {
            throw new Error("CmsProcessor.cleanup is not defined");
        }
        const cleanup = cleanupMethod.bind(CmsProcessor);

        test("has cleanup method", () => {
            expect(CmsProcessor.cleanup).toBeDefined();
            expect(typeof CmsProcessor.cleanup).toBe("function");
        });

        test("dry run mode logs without making API calls", async () => {
            const context = createMockContext({ dryRun: true });
            const result = await cleanup(context);

            expect(result.name).toBe("cms");
            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("deletes all CMS entities in correct order", async () => {
            const mockApi = createMockApiHelpers();

            // Mock sales channel with navigation category
            mockApi.mockPostResponse("search/sales-channel", {
                data: [
                    {
                        id: "sc-123",
                        attributes: { navigationCategoryId: "root-cat-id" },
                    },
                ],
            });

            // Mock category searches - return existing categories
            // Note: Both CMS and Video Elements will be found
            mockApi.mockPostResponse("search/category", {
                data: [{ id: "cms-cat-id" }],
            });

            // Mock landing page and CMS page as existing
            mockApi.mockPostResponse("search/landing-page", {
                data: [{ id: "lp-id" }],
            });
            mockApi.mockPostResponse("search/cms-page", {
                data: [{ id: "cms-page-id" }],
            });

            const context = createMockContext({ dryRun: false, mockApi });
            const result = await cleanup(context);

            expect(result.name).toBe("cms");
            // Categories found (using same mock response), landing page, CMS page
            expect(result.deleted).toBeGreaterThan(0);
            expect(result.errors).toHaveLength(0);

            // Check delete calls were made
            const deleteCalls = mockApi.getCallsByMethod("delete");
            expect(deleteCalls.length).toBeGreaterThan(0);
        });

        test("handles missing entities gracefully", async () => {
            const mockApi = createMockApiHelpers();

            // Mock sales channel with navigation category
            mockApi.mockPostResponse("search/sales-channel", {
                data: [
                    {
                        id: "sc-123",
                        attributes: { navigationCategoryId: "root-cat-id" },
                    },
                ],
            });

            // All searches return empty - entities don't exist
            mockApi.mockPostResponse("search/category", { data: [] });
            mockApi.mockPostResponse("search/landing-page", { data: [] });
            mockApi.mockPostResponse("search/cms-page", { data: [] });

            const context = createMockContext({ dryRun: false, mockApi });
            const result = await cleanup(context);

            expect(result.name).toBe("cms");
            expect(result.deleted).toBe(0); // Nothing to delete
            expect(result.errors).toHaveLength(0);
        });

        test("removes SalesChannel association when multiple SalesChannels exist", async () => {
            const mockApi = createMockApiHelpers();

            // Mock sales channel with navigation category
            mockApi.mockPostResponse("search/sales-channel", {
                data: [
                    {
                        id: "sc-123",
                        attributes: { navigationCategoryId: "root-cat-id" },
                    },
                ],
            });

            // Mock categories as existing
            mockApi.mockPostResponse("search/category", {
                data: [{ id: "cms-cat-id" }],
            });

            // Landing page has MULTIPLE SalesChannels - should only remove our SC
            mockApi.mockPostResponse("search/landing-page", {
                data: [
                    {
                        id: "lp-id",
                        salesChannels: [
                            { id: "sc-123" }, // Our SalesChannel
                            { id: "other-sc-456" }, // Another SalesChannel
                        ],
                    },
                ],
            });
            mockApi.mockPostResponse("search/cms-page", {
                data: [{ id: "cms-page-id" }],
            });
            mockApi.mockSyncSuccess();

            const context = createMockContext({ dryRun: false, mockApi });
            const result = await cleanup(context);

            expect(result.name).toBe("cms");
            // Should delete categories and remove SC from landing page, but NOT delete landing page
            expect(result.deleted).toBeGreaterThan(0);
            expect(result.errors).toHaveLength(0);

            // Should have sync call to remove SalesChannel from landing page
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            const removeScCall = syncCalls.find((c) => {
                const body = c.body as Record<string, unknown>;
                return body.removeSalesChannelAssociation !== undefined;
            });
            expect(removeScCall).toBeDefined();

            // Should NOT have deleted the landing page itself (still has other SalesChannel)
            const deleteCalls = mockApi.getCallsByMethod("delete");
            const lpDeleteCall = deleteCalls.find((c) => c.endpoint.includes("landing-page"));
            expect(lpDeleteCall).toBeUndefined();
        });

        test("deletes landing page when last SalesChannel is removed", async () => {
            const mockApi = createMockApiHelpers();

            // Mock sales channel with navigation category
            mockApi.mockPostResponse("search/sales-channel", {
                data: [
                    {
                        id: "sc-123",
                        attributes: { navigationCategoryId: "root-cat-id" },
                    },
                ],
            });

            // Mock categories as existing
            mockApi.mockPostResponse("search/category", {
                data: [{ id: "cms-cat-id" }],
            });

            // Landing page has ONLY our SalesChannel - should delete it entirely
            mockApi.mockPostResponse("search/landing-page", {
                data: [
                    {
                        id: "lp-id",
                        salesChannels: [{ id: "sc-123" }], // Only our SalesChannel
                    },
                ],
            });
            mockApi.mockPostResponse("search/cms-page", {
                data: [{ id: "cms-page-id" }],
            });
            mockApi.mockSyncSuccess();

            const context = createMockContext({ dryRun: false, mockApi });
            const result = await cleanup(context);

            expect(result.name).toBe("cms");
            // Should delete everything including landing page and CMS page
            expect(result.deleted).toBeGreaterThan(0);
            expect(result.errors).toHaveLength(0);

            // Should have deleted the landing page
            const deleteCalls = mockApi.getCallsByMethod("delete");
            const lpDeleteCall = deleteCalls.find((c) => c.endpoint.includes("landing-page"));
            expect(lpDeleteCall).toBeDefined();

            // Should have deleted the CMS page too
            const cmsDeleteCall = deleteCalls.find((c) => c.endpoint.includes("cms-page"));
            expect(cmsDeleteCall).toBeDefined();
        });
    });
});
