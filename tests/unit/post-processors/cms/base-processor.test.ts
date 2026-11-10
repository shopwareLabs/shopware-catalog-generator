import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import type { CmsPageFixture } from "../../../../src/fixtures/index.js";
import type { PostProcessorContext } from "../../../../src/post-processors/index.js";
import type { CmsBlueprintPage } from "../../../../src/types/index.js";
import type { MockApiHelpers } from "../../../mocks/index.js";

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

// =============================================================================
// Characterization tests (shared page flow used by all CMS processors)
// =============================================================================

const RICH_FIXTURE: CmsPageFixture = {
    name: "Rich Page",
    type: "landingpage",
    sections: [
        {
            type: "default",
            sizingMode: "boxed",
            mobileBehavior: "wrap",
            blocks: [
                {
                    type: "text-hero",
                    position: 0,
                    sectionPosition: "main",
                    slots: [
                        {
                            type: "text",
                            slot: "a",
                            config: { content: { source: "static", value: "A" } },
                        },
                        {
                            type: "image",
                            slot: "img",
                            config: { media: { source: "static", value: null } },
                        },
                        { type: "text", slot: "no-content", config: {} },
                        {
                            type: "text",
                            slot: "b",
                            config: { content: { source: "static", value: "B" } },
                        },
                        {
                            type: "text",
                            slot: "c",
                            config: { content: { source: "static", value: "C" } },
                        },
                    ],
                },
                {
                    type: "text",
                    position: 1,
                    sectionPosition: "main",
                    slots: [
                        {
                            type: "text",
                            slot: "d",
                            config: { content: { source: "static", value: "D" } },
                        },
                    ],
                },
            ],
        },
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
                            slot: "e",
                            config: { content: { source: "static", value: "E" } },
                        },
                    ],
                },
            ],
        },
    ],
};

class RichCmsProcessor extends BaseCmsProcessor {
    readonly name = "rich-cms";
    readonly description = "Rich CMS processor";
    readonly pageFixture: CmsPageFixture = RICH_FIXTURE;

    applyText(fixture: CmsPageFixture, page: CmsBlueprintPage | null): CmsPageFixture {
        return this.applyHydratedText(fixture, page);
    }

    landingPageWithSalesChannels(
        context: PostProcessorContext,
        id: string
    ): Promise<{ id: string; salesChannelIds: string[] } | null> {
        return this.getLandingPageWithSalesChannels(context, id);
    }
}

function textValues(fixture: CmsPageFixture): unknown[][] {
    return fixture.sections.flatMap((section) =>
        section.blocks.map((block) => block.slots.map((slot) => slot.config.content?.value))
    );
}

function syncPayload(mockApi: MockApiHelpers, key: string): Record<string, unknown> | undefined {
    const body = mockApi
        .getCallsByEndpoint("_action/sync")
        .map((c) => c.body as Record<string, { payload: Array<Record<string, unknown>> }>)
        .find((b) => b[key]);
    return body?.[key]?.payload[0];
}

function storedLandingPages(): Record<string, string> {
    const file = path.join("/tmp/mock-cache/test-store", "cms-landing-pages.json");
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, string>;
}

function hydratedPage(sections: CmsBlueprintPage["sections"]): CmsBlueprintPage {
    return { name: "Rich Page", processor: "rich-cms", sections };
}

describe("BaseCmsProcessor (characterization)", () => {
    describe("applyHydratedText", () => {
        test("returns the fixture itself without a hydrated page", () => {
            const processor = new RichCmsProcessor();
            expect(processor.applyText(RICH_FIXTURE, null)).toBe(RICH_FIXTURE);
        });

        test("fills text slots with content in order and keeps fixture text for empty slots", () => {
            const processor = new RichCmsProcessor();
            const hydrated = hydratedPage([
                {
                    blocks: [
                        {
                            type: "text-hero",
                            position: 0,
                            slots: [
                                { type: "text", slot: "a", textContent: "A2" },
                                { type: "text", slot: "b", textContent: "" },
                                { type: "text", slot: "c", textContent: "C2" },
                            ],
                        },
                    ],
                },
                {
                    blocks: [
                        {
                            type: "text",
                            position: 0,
                            slots: [{ type: "text", slot: "e", textContent: "E2" }],
                        },
                    ],
                },
                {
                    blocks: [
                        {
                            type: "text",
                            position: 0,
                            slots: [{ type: "text", slot: "x", textContent: "X" }],
                        },
                    ],
                },
            ]);

            const result = processor.applyText(RICH_FIXTURE, hydrated);

            expect(textValues(result)).toEqual([
                ["A2", undefined, undefined, "B", "C2"],
                ["D"],
                ["E2"],
            ]);
            expect(result.sections[0]?.blocks[0]?.slots[0]?.config.content).toEqual({
                source: "static",
                value: "A2",
            });
            expect(result.sections[0]?.blocks[0]?.slots[1]?.config).toEqual({
                media: { source: "static", value: null },
            });
            expect(result.sections[0]?.blocks[0]?.slots[2]?.config).toEqual({});
            expect(textValues(RICH_FIXTURE)).toEqual([
                ["A", undefined, undefined, "B", "C"],
                ["D"],
                ["E"],
            ]);
        });

        test("ignores missing hydrated slots", () => {
            const processor = new RichCmsProcessor();
            const hydrated = hydratedPage([
                { blocks: [{ type: "text-hero", position: 0, slots: [] }] },
            ]);

            const result = processor.applyText(RICH_FIXTURE, hydrated);

            expect(result).not.toBe(RICH_FIXTURE);
            expect(textValues(result)).toEqual(textValues(RICH_FIXTURE));
        });
    });

    describe("getLandingPageWithSalesChannels", () => {
        test("searches the landing page with its SalesChannels", async () => {
            const processor = new RichCmsProcessor();
            const { context, mockApi } = createTestContext();

            await processor.landingPageWithSalesChannels(context, "lp-1");

            const search = mockApi.getCallsByEndpoint("search/landing-page")[0];
            expect(search?.body).toEqual({ ids: ["lp-1"], associations: { salesChannels: {} } });
        });

        test("merges unique SalesChannel IDs from all response shapes in order", async () => {
            const processor = new RichCmsProcessor();
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/landing-page", {
                data: [
                    {
                        id: "lp-1",
                        relationships: { salesChannels: { data: [{ id: "sc-a" }, { id: "" }] } },
                        attributes: { salesChannels: [{ id: "sc-b" }, { id: "sc-a" }] },
                        salesChannels: [{ id: "sc-c" }, { id: "sc-b" }, { id: "" }],
                    },
                    { id: "lp-2" },
                ],
            });
            const { context } = createTestContext({ mockApi });

            const result = await processor.landingPageWithSalesChannels(context, "lp-1");

            expect(result).toEqual({ id: "lp-1", salesChannelIds: ["sc-a", "sc-b", "sc-c"] });
        });

        test("accepts a single object as data and ignores non-array sources", async () => {
            const processor = new RichCmsProcessor();
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/landing-page", {
                data: {
                    id: "lp-1",
                    relationships: { salesChannels: { data: { id: "sc-x" } } },
                    attributes: { salesChannels: { id: "sc-y" } },
                    salesChannels: { id: "sc-z" },
                },
            });
            const { context } = createTestContext({ mockApi });

            const result = await processor.landingPageWithSalesChannels(context, "lp-1");

            expect(result).toEqual({ id: "lp-1", salesChannelIds: [] });
        });

        test("deduplicates attribute and entity SalesChannels without relationships", async () => {
            const processor = new RichCmsProcessor();
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/landing-page", {
                data: [
                    {
                        id: "lp-1",
                        attributes: { salesChannels: [{ id: "sc-b" }, { id: "sc-b" }] },
                        salesChannels: [{ id: "sc-c" }, { id: "sc-c" }],
                    },
                ],
            });
            const { context } = createTestContext({ mockApi });

            const result = await processor.landingPageWithSalesChannels(context, "lp-1");

            expect(result).toEqual({ id: "lp-1", salesChannelIds: ["sc-b", "sc-c"] });
        });

        test("returns null when the landing page is not found", async () => {
            const processor = new RichCmsProcessor();
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/landing-page", { data: [] });
            const { context } = createTestContext({ mockApi });

            expect(await processor.landingPageWithSalesChannels(context, "lp-1")).toBeNull();
        });

        test("returns null when the search fails", async () => {
            const processor = new RichCmsProcessor();
            const mockApi = createMockApiHelpers();
            mockApi.mockPostFailure("search/landing-page", new Error("down"));
            const { context } = createTestContext({ mockApi });

            expect(await processor.landingPageWithSalesChannels(context, "lp-1")).toBeNull();
        });
    });

    describe("process", () => {
        test("dry run reports one processed page without API calls", async () => {
            const processor = new RichCmsProcessor();
            const { context, mockApi } = createTestContext({ dryRun: true });

            const result = await processor.process(context);

            expect(result).toEqual({
                name: "rich-cms",
                processed: 1,
                skipped: 0,
                errors: [],
                durationMs: 0,
            });
            expect(mockApi.getCalls()).toHaveLength(0);
        });

        test("creates the layout and a landing page that uses it, then stores the ID", async () => {
            const processor = new RichCmsProcessor();
            const { context, mockApi } = createTestContext();

            const result = await processor.process(context);

            expect(result).toEqual({
                name: "rich-cms",
                processed: 1,
                skipped: 0,
                errors: [],
                durationMs: 0,
            });
            const nameFilter = {
                filter: [{ type: "equals", field: "name", value: "Rich Page [test-store]" }],
                limit: 1,
            };
            expect(mockApi.getCallsByEndpoint("search/cms-page")[0]?.body).toEqual(nameFilter);
            expect(mockApi.getCallsByEndpoint("search/landing-page")[0]?.body).toEqual(nameFilter);

            const page = syncPayload(mockApi, "createCmsPage");
            expect(page?.name).toBe("Rich Page [test-store]");
            expect(page?.type).toBe("landingpage");
            const landingPage = syncPayload(mockApi, "createLandingPage");
            expect(landingPage).toMatchObject({
                name: "Rich Page [test-store]",
                url: "rich-page",
                active: true,
                cmsPageId: page?.id,
                salesChannels: [{ id: "sc-123" }],
            });
            expect(storedLandingPages()["rich-cms"]).toBe(String(landingPage?.id));
        });

        test("uses hydrated text from the cached CMS blueprint", async () => {
            const processor = new RichCmsProcessor();
            const { context, mockApi, mockCache } = createTestContext();
            mockCache.cmsBlueprint = {
                pages: [
                    hydratedPage([
                        {
                            blocks: [
                                {
                                    type: "text-hero",
                                    position: 0,
                                    slots: [{ type: "text", slot: "a", textContent: "AI" }],
                                },
                            ],
                        },
                    ]),
                ],
            } as unknown as typeof mockCache.cmsBlueprint;

            await processor.process(context);

            const page = syncPayload(mockApi, "createCmsPage") as {
                sections: Array<{
                    blocks: Array<{ slots: Array<{ config: Record<string, unknown> }> }>;
                }>;
            };
            expect(page.sections[0]?.blocks[0]?.slots[0]?.config.content).toEqual({
                source: "static",
                value: "AI",
            });
        });

        test("reuses existing layout and landing page and adds the SalesChannel", async () => {
            const processor = new RichCmsProcessor();
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/cms-page", { data: [{ id: "cms-existing" }] });
            mockApi.mockPostResponse("search/landing-page", {
                data: [{ id: "lp-existing", salesChannels: [{ id: "other-sc" }] }],
            });
            const { context } = createTestContext({ mockApi });

            const result = await processor.process(context);

            expect(result.errors).toEqual([]);
            expect(result.processed).toBe(1);
            expect(syncPayload(mockApi, "createCmsPage")).toBeUndefined();
            expect(syncPayload(mockApi, "createLandingPage")).toBeUndefined();
            expect(syncPayload(mockApi, "updateLandingPage")).toEqual({
                id: "lp-existing",
                salesChannels: [{ id: "sc-123" }],
            });
            expect(storedLandingPages()["rich-cms"]).toBe("lp-existing");
        });

        test("links a new landing page to an existing layout", async () => {
            const processor = new RichCmsProcessor();
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/cms-page", { data: [{ id: "cms-existing" }] });
            const { context } = createTestContext({ mockApi });

            await processor.process(context);

            expect(syncPayload(mockApi, "createLandingPage")?.cmsPageId).toBe("cms-existing");
        });

        test("reports a failing association but still stores the landing page", async () => {
            const processor = new RichCmsProcessor();
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/cms-page", { data: [{ id: "cms-existing" }] });
            mockApi.mockPostResponse("search/landing-page", {
                data: [{ id: "lp-assoc-fail", salesChannels: [] }],
            });
            mockApi.mockPostFailure("_action/sync", new Error("sync down"));
            const { context } = createTestContext({ mockApi });

            const result = await processor.process(context);

            expect(result.processed).toBe(0);
            expect(result.errors).toEqual(["Failed to add SalesChannel to existing Landing Page"]);
            expect(storedLandingPages()["rich-cms"]).toBe("lp-assoc-fail");
        });

        test("reports thrown errors as failed CMS processing", async () => {
            const processor = new RichCmsProcessor();
            const mockApi = createMockApiHelpers();
            mockApi.mockPostFailure("search/cms-page", new Error("search down"));
            const { context } = createTestContext({ mockApi });

            const result = await processor.process(context);

            expect(result).toEqual({
                name: "rich-cms",
                processed: 0,
                skipped: 0,
                errors: ["CMS processing failed: search down"],
                durationMs: 0,
            });
            expect(mockApi.getCallsByEndpoint("search/landing-page")).toHaveLength(0);
        });

        test("stringifies non-Error failures", async () => {
            const processor = new RichCmsProcessor();
            const mockApi = createMockApiHelpers();
            mockApi.mockPostFailure("search/cms-page", "plain failure" as unknown as Error);
            const { context } = createTestContext({ mockApi });

            const result = await processor.process(context);

            expect(result.errors).toEqual(["CMS processing failed: plain failure"]);
        });
    });

    describe("cleanup", () => {
        function apiWithPages(): MockApiHelpers {
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/landing-page", { data: [{ id: "lp-1" }] });
            mockApi.mockPostResponse("search/cms-page", { data: [{ id: "cms-1" }] });
            return mockApi;
        }

        test("deletes the landing page, then the layout", async () => {
            const processor = new RichCmsProcessor();
            const mockApi = apiWithPages();
            const { context } = createTestContext({ mockApi });

            const result = await processor.cleanup(context);

            expect(result).toEqual({ name: "rich-cms", deleted: 2, errors: [], durationMs: 0 });
            expect(mockApi.getCallsByMethod("delete").map((c) => c.endpoint)).toEqual([
                "landing-page/lp-1",
                "cms-page/cms-1",
            ]);
            const nameFilter = {
                filter: [{ type: "equals", field: "name", value: "Rich Page [test-store]" }],
                limit: 1,
            };
            expect(mockApi.getCallsByEndpoint("search/landing-page")[0]?.body).toEqual(nameFilter);
            expect(mockApi.getCallsByEndpoint("search/cms-page")[0]?.body).toEqual(nameFilter);
        });

        test("deletes only the layout when no landing page exists", async () => {
            const processor = new RichCmsProcessor();
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/cms-page", { data: [{ id: "cms-1" }] });
            const { context } = createTestContext({ mockApi });

            const result = await processor.cleanup(context);

            expect(result.deleted).toBe(1);
            expect(result.errors).toEqual([]);
            expect(mockApi.getCallsByMethod("delete").map((c) => c.endpoint)).toEqual([
                "cms-page/cms-1",
            ]);
        });

        test("reports failed deletes with the scoped names", async () => {
            const processor = new RichCmsProcessor();
            const mockApi = apiWithPages();
            mockApi.deleteEntity = async () => false;
            const { context } = createTestContext({ mockApi });

            const result = await processor.cleanup(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toEqual([
                'Failed to delete landing page "Rich Page [test-store]"',
                'Failed to delete CMS page "Rich Page [test-store]"',
            ]);
        });

        test("treats a throwing delete as failed", async () => {
            const processor = new RichCmsProcessor();
            const mockApi = apiWithPages();
            mockApi.deleteEntity = async () => {
                throw new Error("boom");
            };
            const { context } = createTestContext({ mockApi });

            const result = await processor.cleanup(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(2);
        });

        test("reports a failing landing page lookup and keeps going", async () => {
            const processor = new RichCmsProcessor();
            const mockApi = apiWithPages();
            mockApi.mockPostFailure("search/landing-page", new Error("lp down"));
            const { context } = createTestContext({ mockApi });

            const result = await processor.cleanup(context);

            expect(result.deleted).toBe(1);
            expect(result.errors).toEqual(["Landing page lookup failed: lp down"]);
        });

        test("reports a failing layout lookup", async () => {
            const processor = new RichCmsProcessor();
            const mockApi = apiWithPages();
            mockApi.mockPostFailure("search/cms-page", "plain failure" as unknown as Error);
            const { context } = createTestContext({ mockApi });

            const result = await processor.cleanup(context);

            expect(result.deleted).toBe(1);
            expect(result.errors).toEqual(["CMS page lookup failed: plain failure"]);
        });
    });
});
