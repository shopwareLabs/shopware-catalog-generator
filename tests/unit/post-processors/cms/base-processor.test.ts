import { describe, expect, test } from "bun:test";

import type { CmsPageFixture } from "../../../../src/fixtures/index.js";
import type { PostProcessorContext } from "../../../../src/post-processors/index.js";

import { BaseCmsProcessor } from "../../../../src/post-processors/cms/base-processor.js";
import { createTestContext } from "../../../helpers/post-processor-context.js";
import { createMockApiHelpers } from "../../../mocks/index.js";

// Concrete implementation for testing the abstract base class
class TestCmsProcessor extends BaseCmsProcessor {
    readonly name = "test-cms";
    readonly description = "Test CMS processor";
    readonly pageFixture: CmsPageFixture = {
        name: "Test Page",
        type: "landingpage",
        sections: [
            {
                type: "default",
                sizingMode: "boxed",
                mobileBehavior: "wrap",
                blocks: [
                    {
                        type: "text",
                        position: 0,
                        sectionPosition: "main",
                        slots: [
                            {
                                type: "text",
                                slot: "content",
                                config: {
                                    content: { source: "static", value: "Test content" },
                                },
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

describe("BaseCmsProcessor", () => {
    describe("metadata", () => {
        test("abstract properties are defined", () => {
            const processor = new TestCmsProcessor();
            expect(processor.name).toBe("test-cms");
            expect(processor.description).toBe("Test CMS processor");
            expect(processor.pageFixture.name).toBe("Test Page");
            expect(processor.dependsOn).toEqual([]);
        });
    });

    describe("process", () => {
        test("dry run logs without API calls", async () => {
            const processor = new TestCmsProcessor();
            const { context, mockApi } = createTestContext({ dryRun: true });

            const result = await processor.process(context);

            expect(result.name).toBe("test-cms");
            expect(result.processed).toBe(1);
            expect(result.skipped).toBe(0);
            expect(result.errors).toEqual([]);
            expect(mockApi.getCalls().length).toBe(0);
        });

        test("creates CMS page when not exists", async () => {
            const processor = new TestCmsProcessor();
            const { context, mockApi } = createTestContext();

            // Default empty responses → cms-page not found → creates it
            const result = await processor.process(context);

            expect(result.errors).toEqual([]);
            expect(result.processed).toBe(1);

            // Should have called sync for CMS page creation
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBeGreaterThan(0);
        });

        test("skips CMS page creation when exists", async () => {
            const processor = new TestCmsProcessor();
            const mockApi = createMockApiHelpers();
            // CMS page already exists
            mockApi.mockPostResponse("search/cms-page", { data: [{ id: "existing-cms-page-id" }] });

            const { context } = createTestContext({ mockApi });

            const result = await processor.process(context);

            expect(result.errors).toEqual([]);
            expect(result.processed).toBe(1);

            // Should only sync for landing page, not CMS page
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBe(1);
        });

        test("creates landing page when not exists", async () => {
            const processor = new TestCmsProcessor();
            const mockApi = createMockApiHelpers();
            // CMS page exists; landing page not found
            mockApi.mockPostResponse("search/cms-page", { data: [{ id: "cms-page-id" }] });

            const { context } = createTestContext({ mockApi });

            const result = await processor.process(context);

            expect(result.errors).toEqual([]);
            expect(result.processed).toBe(1);

            // Should have created landing page via sync
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBe(1);

            const syncBody = syncCalls[0]?.body as Record<string, unknown>;
            expect(syncBody).toBeDefined();
            expect(Object.keys(syncBody)).toContain("createLandingPage");
        });
    });

    describe("ensureSalesChannelAssociated", () => {
        test("returns early when no landing page data", async () => {
            const processor = new TestCmsProcessor();
            const { context, mockApi } = createTestContext();
            const errors: string[] = [];

            // Default empty response → getLandingPageWithSalesChannels returns null
            await (
                processor as unknown as {
                    ensureSalesChannelAssociated: (
                        context: PostProcessorContext,
                        landingPageId: string,
                        pageName: string,
                        errors: string[]
                    ) => Promise<void>;
                }
            ).ensureSalesChannelAssociated(context, "lp-123", "Test Page", errors);

            expect(errors).toEqual([]);
            // Should not have synced anything
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBe(0);
        });

        test("returns early when already associated", async () => {
            const processor = new TestCmsProcessor();
            const mockApi = createMockApiHelpers();
            // Landing page already has this sales channel
            mockApi.mockPostResponse("search/landing-page", {
                data: [
                    {
                        id: "lp-123",
                        relationships: {
                            salesChannels: {
                                data: [{ id: "sc-123" }],
                            },
                        },
                    },
                ],
            });

            const { context } = createTestContext({ mockApi });
            const errors: string[] = [];

            await (
                processor as unknown as {
                    ensureSalesChannelAssociated: (
                        context: PostProcessorContext,
                        landingPageId: string,
                        pageName: string,
                        errors: string[]
                    ) => Promise<void>;
                }
            ).ensureSalesChannelAssociated(context, "lp-123", "Test Page", errors);

            expect(errors).toEqual([]);
            // Should not have synced anything
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBe(0);
        });

        test("adds association when not present", async () => {
            const processor = new TestCmsProcessor();
            const mockApi = createMockApiHelpers();
            // Landing page exists but has different sales channel
            mockApi.mockPostResponse("search/landing-page", {
                data: [
                    {
                        id: "lp-123",
                        relationships: {
                            salesChannels: {
                                data: [{ id: "other-sc" }],
                            },
                        },
                    },
                ],
            });

            const { context } = createTestContext({ mockApi });
            const errors: string[] = [];

            await (
                processor as unknown as {
                    ensureSalesChannelAssociated: (
                        context: PostProcessorContext,
                        landingPageId: string,
                        pageName: string,
                        errors: string[]
                    ) => Promise<void>;
                }
            ).ensureSalesChannelAssociated(context, "lp-123", "Test Page", errors);

            expect(errors).toEqual([]);
            // Should have synced the association update
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBeGreaterThan(0);
        });

        test("records error on failure", async () => {
            const processor = new TestCmsProcessor();
            const mockApi = createMockApiHelpers();
            // Landing page exists but has different sales channel
            mockApi.mockPostResponse("search/landing-page", {
                data: [
                    {
                        id: "lp-123",
                        relationships: {
                            salesChannels: {
                                data: [{ id: "other-sc" }],
                            },
                        },
                    },
                ],
            });
            mockApi.mockPostFailure("_action/sync", new Error("Server error"));

            const { context } = createTestContext({ mockApi });
            const errors: string[] = [];

            await (
                processor as unknown as {
                    ensureSalesChannelAssociated: (
                        context: PostProcessorContext,
                        landingPageId: string,
                        pageName: string,
                        errors: string[]
                    ) => Promise<void>;
                }
            ).ensureSalesChannelAssociated(context, "lp-123", "Test Page", errors);

            expect(errors).toContain("Failed to add SalesChannel to existing Landing Page");
        });
    });

    describe("cleanup", () => {
        test("dry run logs without deletions", async () => {
            const processor = new TestCmsProcessor();
            const { context, mockApi } = createTestContext({ dryRun: true });

            const result = await processor.cleanup(context);

            expect(result.name).toBe("test-cms");
            expect(result.deleted).toBe(0);
            expect(result.errors).toEqual([]);
            expect(mockApi.getCalls().length).toBe(0);
        });

        test("skips when landing page not found", async () => {
            const processor = new TestCmsProcessor();
            const { context, mockApi } = createTestContext();

            // Default empty responses → no landing page found → no deletions
            const result = await processor.cleanup(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toEqual([]);
            // Should only search, not delete
            const deleteCalls = mockApi.getCallsByMethod("delete");
            expect(deleteCalls.length).toBe(0);
        });
    });
});
