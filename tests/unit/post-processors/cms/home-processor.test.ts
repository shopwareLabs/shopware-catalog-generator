/**
 * Tests for HomeProcessor (cms-home)
 *
 * Tests metadata, fixture structure, dry run behavior,
 * and the buildHeroText() / buildReferenceText() template functions.
 */
import { describe, expect, mock, test } from "bun:test";

import type { PostProcessorContext } from "../../../../src/post-processors/index.js";

import { HOME_LISTING_PAGE } from "../../../../src/fixtures/index.js";
import {
    buildHeroText,
    buildReferenceText,
    HomeProcessor,
} from "../../../../src/post-processors/cms/home-processor.js";
import {
    createTestBlueprint,
    createTestCategory,
    createTestProduct,
} from "../../../helpers/blueprint-factory.js";
import { createTestContext } from "../../../helpers/post-processor-context.js";
import { createMockApiHelpers } from "../../../mocks/index.js";

const musicBlueprint = createTestBlueprint({
    salesChannel: {
        name: "music",
        description: "Musical instruments and accessories for musicians of all levels",
    },
    categories: [
        createTestCategory({
            id: "cat-1",
            name: "Instruments",
            description: "All instruments",
            level: 1,
            children: [
                createTestCategory({
                    id: "cat-1-1",
                    name: "Guitars",
                    description: "All guitars",
                    parentId: "cat-1",
                    level: 2,
                }),
                createTestCategory({
                    id: "cat-1-2",
                    name: "Drums",
                    description: "All drums",
                    parentId: "cat-1",
                    level: 2,
                }),
            ],
        }),
        createTestCategory({
            id: "cat-2",
            name: "Accessories",
            description: "Music accessories",
            level: 1,
        }),
    ],
    products: Array.from({ length: 20 }, (_, i) =>
        createTestProduct({
            id: `prod-${i}`,
            name: `Product ${i}`,
            description: `Description ${i}`,
            primaryCategoryId: "cat-1-1",
            categoryIds: ["cat-1-1"],
        })
    ),
});

function createContextWithFetch(options: { dryRun?: boolean } = {}): {
    context: PostProcessorContext;
    fetchCalls: Array<{ url: string; method: string }>;
} {
    const fetchCalls: Array<{ url: string; method: string }> = [];

    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method || "GET";
        fetchCalls.push({ url, method });

        return {
            ok: true,
            status: 200,
            json: async () => ({ data: [] }),
            text: async () => "{}",
        } as Response;
    }) as unknown as typeof fetch;

    const { context } = createTestContext({
        dryRun: options.dryRun,
        salesChannelName: "music",
        blueprint: musicBlueprint,
    });

    return { context, fetchCalls };
}

function createApiContext(): {
    context: PostProcessorContext;
    mockApi: ReturnType<typeof createMockApiHelpers>;
} {
    const mockApi = createMockApiHelpers();
    mockApi.mockPostResponse("search/sales-channel", {
        data: [{ id: "sc-123", navigationCategoryId: "root-cat" }],
    });
    mockApi.mockPostResponse("search/cms-page", { data: [] });
    mockApi.mockPostResponse("_action/sync", { success: true });

    const { context } = createTestContext({
        mockApi,
        salesChannelName: "music",
        blueprint: musicBlueprint,
    });

    return { context, mockApi };
}

describe("HomeProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(HomeProcessor.name).toBe("cms-home");
        });

        test("has description", () => {
            expect(HomeProcessor.description).toBeDefined();
            expect(HomeProcessor.description.length).toBeGreaterThan(0);
        });

        test("depends on customers, promotions, and cross-selling", () => {
            expect(HomeProcessor.dependsOn).toContain("customers");
            expect(HomeProcessor.dependsOn).toContain("promotions");
            expect(HomeProcessor.dependsOn).toContain("cross-selling");
        });

        test("has page fixture with correct name and type", () => {
            expect(HomeProcessor.pageFixture.name).toBe("Home Listing");
            expect(HomeProcessor.pageFixture.type).toBe("product_list");
        });
    });

    describe("fixture structure", () => {
        test("has three sections", () => {
            expect(HOME_LISTING_PAGE.sections).toHaveLength(3);
        });

        test("first section is default with text-teaser-section block", () => {
            const section = HOME_LISTING_PAGE.sections[0];
            expect(section?.type).toBe("default");
            expect(section?.blocks).toHaveLength(1);
            expect(section?.blocks[0]?.type).toBe("text-teaser-section");
        });

        test("teaser block has image and text slots", () => {
            const slots = HOME_LISTING_PAGE.sections[0]?.blocks[0]?.slots ?? [];
            expect(slots).toHaveLength(2);
            expect(slots[0]?.type).toBe("image");
            expect(slots[0]?.slot).toBe("left");
            expect(slots[1]?.type).toBe("text");
            expect(slots[1]?.slot).toBe("right");
        });

        test("second section is default with full-width text block", () => {
            const section = HOME_LISTING_PAGE.sections[1];
            expect(section?.type).toBe("default");
            expect(section?.blocks).toHaveLength(1);
            expect(section?.blocks[0]?.type).toBe("text");
            expect(section?.blocks[0]?.slots[0]?.type).toBe("text");
            expect(section?.blocks[0]?.slots[0]?.slot).toBe("content");
        });

        test("third section is sidebar with product-listing and sidebar-filter", () => {
            const section = HOME_LISTING_PAGE.sections[2];
            expect(section?.type).toBe("sidebar");
            expect(section?.blocks).toHaveLength(2);
            expect(section?.blocks[0]?.type).toBe("product-listing");
            expect(section?.blocks[0]?.sectionPosition).toBe("main");
            expect(section?.blocks[1]?.type).toBe("sidebar-filter");
            expect(section?.blocks[1]?.sectionPosition).toBe("sidebar");
        });

        test("product-listing slot has all standard filters", () => {
            const slot = HOME_LISTING_PAGE.sections[2]?.blocks[0]?.slots[0];
            const filters = slot?.config.filters as { source: string; value: string } | undefined;
            expect(filters?.value).toContain("manufacturer-filter");
            expect(filters?.value).toContain("property-filter");
            expect(filters?.value).toContain("price-filter");
        });
    });

    describe("process - dry run", () => {
        test("logs actions without making API calls", async () => {
            const { context, fetchCalls } = createContextWithFetch({ dryRun: true });

            const result = await HomeProcessor.process(context);

            expect(result.name).toBe("cms-home");
            expect(result.processed).toBe(1);
            expect(result.errors).toEqual([]);
            expect(fetchCalls.length).toBe(0);
        });
    });

    describe("cleanup - dry run", () => {
        test("logs actions without making API calls", async () => {
            const { context, fetchCalls } = createContextWithFetch({ dryRun: true });

            const result = await HomeProcessor.cleanup(context);

            expect(result.name).toBe("cms-home");
            expect(result.deleted).toBe(0);
            expect(result.errors).toEqual([]);
            expect(fetchCalls.length).toBe(0);
        });
    });

    describe("process - non dry run", () => {
        test("returns error when root category is missing", async () => {
            const { context, mockApi } = createApiContext();
            mockApi.mockPostResponse("search/sales-channel", { data: [] });

            const result = await HomeProcessor.process(context);
            expect(result.processed).toBe(0);
            expect(result.errors.some((e) => e.includes("root category"))).toBe(true);
        });

        test("creates/assigns homepage when root category exists", async () => {
            const { context, mockApi } = createApiContext();

            const result = await HomeProcessor.process(context);

            expect(result.processed).toBe(1);
            expect(result.errors).toEqual([]);
            expect(mockApi.getCallsByEndpoint("_action/sync").length).toBeGreaterThan(0);
        });
    });

    describe("cleanup - non dry run", () => {
        test("removes category assignment and deletes cms page when found", async () => {
            const { context, mockApi } = createApiContext();
            mockApi.mockPostResponse("search/cms-page", { data: [{ id: "cms-1" }] });

            const result = await HomeProcessor.cleanup(context);

            expect(result.errors).toEqual([]);
            expect(result.deleted).toBe(1);
            expect(mockApi.deleteEntityMock).toHaveBeenCalled();
        });
    });
});

describe("buildHeroText", () => {
    test("includes capitalized store name in headline", () => {
        const html = buildHeroText("music", "A music store", 90, 15);
        expect(html).toContain("Welcome to the Music Demo-Store!");
    });

    test("includes store description in blockquote", () => {
        const description = "Musical instruments and accessories";
        const html = buildHeroText("music", description, 90, 15);
        expect(html).toContain(`<blockquote>${description}</blockquote>`);
    });

    test("includes product count", () => {
        const html = buildHeroText("music", "desc", 42, 15);
        expect(html).toContain("42 Products");
    });

    test("includes category count", () => {
        const html = buildHeroText("music", "desc", 90, 7);
        expect(html).toContain("7 Categories");
    });

    test("includes GitHub links", () => {
        const html = buildHeroText("test", "desc", 10, 5);
        expect(html).toContain("shopware-catalog-generator");
        expect(html).toContain("shopware-catalog-templates");
    });

    test("includes supported features list", () => {
        const html = buildHeroText("test", "desc", 10, 5);
        expect(html).toContain("Simple Products");
        expect(html).toContain("Variant Products");
        expect(html).toContain("Digital Product");
        expect(html).toContain("CMS-Pages");
    });

    test("includes Cross-Selling when includeCrossSelling is true", () => {
        const html = buildHeroText("test", "desc", 10, 5, {
            includeCredentials: false,
            includePromotions: false,
            includeCrossSelling: true,
        });
        expect(html).toContain("Cross-Selling");
    });

    test("omits Cross-Selling when includeCrossSelling is false", () => {
        const html = buildHeroText("test", "desc", 10, 5, {
            includeCredentials: false,
            includePromotions: false,
            includeCrossSelling: false,
        });
        expect(html).not.toContain("Cross-Selling");
        expect(html).toContain("Properties and Images");
    });

    test("omits customer accounts when includeCredentials is false", () => {
        const html = buildHeroText("test", "desc", 10, 5, {
            includeCredentials: false,
            includePromotions: true,
            includeCrossSelling: false,
        });
        expect(html).not.toContain("Demo Customer Accounts");
        expect(html).toContain("Promotion Codes");
    });

    test("omits promotions when includePromotions is false", () => {
        const html = buildHeroText("test", "desc", 10, 5, {
            includeCredentials: true,
            includePromotions: false,
            includeCrossSelling: false,
        });
        expect(html).toContain("Demo Customer Accounts");
        expect(html).not.toContain("Promotion Codes");
    });
});

describe("buildReferenceText", () => {
    test("includes credentials table", () => {
        const html = buildReferenceText("music");
        expect(html).toContain("Demo Accounts");
        expect(html).toContain("customer@example.com");
        expect(html).toContain("shopware");
    });

    test("includes promotion codes table", () => {
        const html = buildReferenceText("music");
        expect(html).toContain("Promotion Codes");
        expect(html).toContain("WELCOME10");
        expect(html).toContain("FREESHIP");
    });

    test("uses table layout for side-by-side tables", () => {
        const html = buildReferenceText("music");
        expect(html).toContain("vertical-align: top");
    });

    test("includes bold lowercase store name in closing", () => {
        const html = buildReferenceText("Music");
        expect(html).toContain("<b>music</b> demo-store");
    });
});
