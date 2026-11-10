import { describe, expect, spyOn, test } from "bun:test";

import type {
    CmsBlockConfig,
    CmsPageFixture,
    CmsSlotConfig,
} from "../../../../src/fixtures/index.js";
import type { PostProcessorContext } from "../../../../src/post-processors/index.js";

import { CommerceProcessor } from "../../../../src/post-processors/cms/commerce-processor.js";
import { logger } from "../../../../src/utils/index.js";
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

// =============================================================================
// Characterization tests (product data population and product lookup)
// =============================================================================

interface ProductWithMedia {
    id: string;
    coverMediaId: string | null;
    mediaIds: string[];
}

interface CommerceInternals {
    populateProductData(fixture: CmsPageFixture, products: ProductWithMedia[]): CmsPageFixture;
    getProductsWithMedia(context: PostProcessorContext): Promise<ProductWithMedia[]>;
}

const internals = CommerceProcessor as unknown as CommerceInternals;

function populate(fixture: CmsPageFixture, products: ProductWithMedia[]): CmsPageFixture {
    return internals.populateProductData.call(CommerceProcessor, fixture, products);
}

function product(id: string, mediaIds: string[] = []): ProductWithMedia {
    return { id, coverMediaId: mediaIds[0] ?? null, mediaIds };
}

function cslot(type: string, config: CmsSlotConfig["config"]): CmsSlotConfig {
    return { type, slot: type, config };
}

function cblock(type: string, position: number, slots: CmsSlotConfig[] = []): CmsBlockConfig {
    return { type, position, sectionPosition: "main", slots };
}

const empty = { source: "static" as const, value: null };

const COMMERCE_FIXTURE: CmsPageFixture = {
    name: "Commerce Elements",
    type: "landingpage",
    sections: [
        {
            type: "default",
            sizingMode: "boxed",
            mobileBehavior: "wrap",
            blocks: [
                cblock("product-three-column", 0, [
                    cslot("text", { content: { source: "static", value: "x" } }),
                    cslot("product-box", { product: empty }),
                    cslot("product-box", { product: empty }),
                    cslot("product-box", {}),
                ]),
                cblock("product-slider", 1, [
                    cslot("product-slider", { products: { source: "static", value: [] } }),
                    cslot("product-slider", {}),
                ]),
                cblock("text-teaser", 5),
                cblock("text-teaser", 4),
                cblock("text", 5),
            ],
        },
        {
            type: "default",
            sizingMode: "boxed",
            mobileBehavior: "wrap",
            blocks: [
                cblock("gallery-buybox", 6, [
                    cslot("image-gallery", { sliderItems: { source: "static", value: [] } }),
                    cslot("image-gallery", {}),
                    cslot("buy-box", { product: empty }),
                    cslot("buy-box", {}),
                ]),
            ],
        },
    ],
};

function configs(fixture: CmsPageFixture): Array<CmsSlotConfig["config"]> {
    return fixture.sections.flatMap((s) => s.blocks.flatMap((b) => b.slots.map((x) => x.config)));
}

function blockKeys(fixture: CmsPageFixture): string[] {
    return fixture.sections.flatMap((s) => s.blocks.map((b) => `${b.type}@${b.position}`));
}

const TEN = Array.from({ length: 10 }, (_, i) => product(`p${i}`, i === 0 ? ["m0", "m1"] : []));

describe("CommerceProcessor (characterization)", () => {
    describe("populateProductData", () => {
        test("fills product boxes by slot index, falling back to the first product", () => {
            const result = populate(COMMERCE_FIXTURE, [product("p1", ["m"]), product("p2")]);

            const slots = configs(result);
            expect(slots[0]).toEqual({ content: { source: "static", value: "x" } });
            expect(slots[1]).toEqual({ product: { source: "static", value: "p2" } });
            expect(slots[2]).toEqual({ product: { source: "static", value: "p1" } });
            expect(slots[3]).toEqual({});
        });

        test("fills sliders with at most 8 products and the buy box with the first", () => {
            const slots = configs(populate(COMMERCE_FIXTURE, TEN));

            expect(slots[4]).toEqual({
                products: { source: "static", value: TEN.slice(0, 8).map((p) => p.id) },
            });
            expect(slots[5]).toEqual({});
            expect(slots[6]).toEqual({
                sliderItems: {
                    source: "static",
                    value: [
                        { mediaId: "m0", url: null, newTab: false },
                        { mediaId: "m1", url: null, newTab: false },
                    ],
                },
            });
            expect(slots[7]).toEqual({});
            expect(slots[8]).toEqual({ product: { source: "static", value: "p0" } });
            expect(slots[9]).toEqual({});
        });

        test("keeps every block when the first product has media", () => {
            const result = populate(COMMERCE_FIXTURE, TEN);

            expect(blockKeys(result)).toEqual(blockKeys(COMMERCE_FIXTURE));
        });

        test("removes the gallery-buybox and its intro when the first product has no media", () => {
            const result = populate(COMMERCE_FIXTURE, [product("p1"), product("p2", ["m"])]);

            expect(blockKeys(result)).toEqual([
                "product-three-column@0",
                "product-slider@1",
                "text-teaser@4",
                "text@5",
            ]);
        });

        test("sets null products and empty sliders without products", () => {
            const result = populate(COMMERCE_FIXTURE, []);

            const slots = configs(result);
            expect(slots[1]).toEqual({ product: { source: "static", value: null } });
            expect(slots[2]).toEqual({ product: { source: "static", value: null } });
            expect(slots[4]).toEqual({ products: { source: "static", value: [] } });
            expect(blockKeys(result)).not.toContain("gallery-buybox@6");
        });

        test("does not change the input fixture", () => {
            populate(COMMERCE_FIXTURE, []);

            expect(configs(COMMERCE_FIXTURE)[1]).toEqual({ product: empty });
            expect(blockKeys(COMMERCE_FIXTURE)).toContain("gallery-buybox@6");
        });
    });

    describe("getProductsWithMedia", () => {
        test("searches the SalesChannel's products with cover and media", async () => {
            const { context, mockApi } = createTestContext();

            await internals.getProductsWithMedia.call(CommerceProcessor, context);

            expect(mockApi.getCallsByEndpoint("search/product")[0]?.body).toEqual({
                filter: [{ type: "equals", field: "visibilities.salesChannelId", value: "sc-123" }],
                associations: { cover: { associations: { media: {} } }, media: {} },
                limit: 10,
            });
        });

        test("puts the cover first and adds unique gallery media", async () => {
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/product", {
                data: [
                    {
                        id: "p1",
                        cover: { mediaId: "c1", media: { id: "ignored" } },
                        media: [{ mediaId: "c1" }, { id: "g1" }, { mediaId: "g2", id: "x" }, {}],
                    },
                    { id: "p2", cover: { media: { id: "c2" } } },
                    { id: "p3", media: [{ id: "g3" }, { id: "g3" }] },
                    { id: "p4" },
                ],
            });
            const { context } = createTestContext({ mockApi });

            const products = await internals.getProductsWithMedia.call(CommerceProcessor, context);

            expect(products).toEqual([
                { id: "p1", coverMediaId: "c1", mediaIds: ["c1", "g1", "g2"] },
                { id: "p2", coverMediaId: "c2", mediaIds: ["c2"] },
                { id: "p3", coverMediaId: null, mediaIds: ["g3"] },
                { id: "p4", coverMediaId: null, mediaIds: [] },
            ]);
        });

        test("returns no products for a response without data", async () => {
            const { context } = createTestContext();

            const products = await internals.getProductsWithMedia.call(CommerceProcessor, context);

            expect(products).toEqual([]);
        });

        test("returns no products when the search fails", async () => {
            const mockApi = createMockApiHelpers();
            mockApi.mockPostFailure("search/product", new Error("down"));
            const { context } = createTestContext({ mockApi });

            const products = await internals.getProductsWithMedia.call(CommerceProcessor, context);

            expect(products).toEqual([]);
        });
    });

    describe("process logs", () => {
        test("logs the product count for a new layout and the reuse of an existing one", async () => {
            const info = spyOn(logger, "info");
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/product", { data: [{ id: "p1" }, { id: "p2" }] });
            const { context } = createTestContext({ mockApi });
            await CommerceProcessor.process(context);

            const reuseApi = createMockApiHelpers();
            reuseApi.mockPostResponse("search/cms-page", { data: [{ id: "cms-existing" }] });
            const { context: reuseContext } = createTestContext({ mockApi: reuseApi });
            await CommerceProcessor.process(reuseContext);

            const messages = info.mock.calls.map((call) => call[0]);
            info.mockRestore();
            expect(messages).toContain(
                '    ✓ Created CMS layout "Commerce Elements" with 2 products'
            );
            expect(messages).toContain('    ⊘ CMS layout "Commerce Elements" already exists');
        });

        test("dry run logs the fixture name", async () => {
            const info = spyOn(logger, "info");
            const { context } = createTestContext({ dryRun: true });

            await CommerceProcessor.process(context);

            const messages = info.mock.calls.map((call) => call[0]);
            info.mockRestore();
            expect(messages).toEqual([
                '    [DRY RUN] Would create CMS layout "Commerce Elements"',
                '    [DRY RUN] Would create Landing Page "Commerce Elements"',
            ]);
        });

        test("ignores hydrated text from the CMS blueprint", async () => {
            const { context, mockApi } = createTestContext();
            const loadCmsBlueprint = spyOn(context.cache, "loadCmsBlueprint");

            await CommerceProcessor.process(context);

            expect(loadCmsBlueprint).not.toHaveBeenCalled();
            expect(mockApi.getCallsByEndpoint("_action/sync").length).toBeGreaterThan(0);
        });
    });
});
