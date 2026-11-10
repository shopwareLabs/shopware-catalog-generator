import { describe, expect, spyOn, test } from "bun:test";

import type { PostProcessorContext } from "../../../../src/post-processors/index.js";

import { TestingProcessor } from "../../../../src/post-processors/cms/testing-processor.js";
import { ShopwareCapabilities } from "../../../../src/shopware/version.js";
import { logger } from "../../../../src/utils/index.js";
import { createTestContext } from "../../../helpers/post-processor-context.js";
import { createMockApiHelpers } from "../../../mocks/index.js";

describe("TestingProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(TestingProcessor.name).toBe("cms-testing");
        });

        test("has description", () => {
            expect(TestingProcessor.description).toBeDefined();
            expect(TestingProcessor.description.length).toBeGreaterThan(0);
        });

        test("depends on all CMS element processors and the demo products", () => {
            expect(TestingProcessor.dependsOn).toContain("cms-text");
            expect(TestingProcessor.dependsOn).toContain("cms-images");
            expect(TestingProcessor.dependsOn).toContain("cms-video");
            expect(TestingProcessor.dependsOn).toContain("cms-text-images");
            expect(TestingProcessor.dependsOn).toContain("cms-commerce");
            expect(TestingProcessor.dependsOn).toContain("cms-form");
            expect(TestingProcessor.dependsOn).toContain("digital-product");
            expect(TestingProcessor.dependsOn).toContain("media-product");
            expect(TestingProcessor.dependsOn.length).toBe(8);
        });

        test("has page fixture with correct name", () => {
            expect(TestingProcessor.pageFixture.name).toBe("Testing Overview");
        });
    });

    describe("process", () => {
        test("dry run logs without API calls", async () => {
            const { context, mockApi } = createTestContext({ dryRun: true });

            const result = await TestingProcessor.process(context);

            expect(result.name).toBe("cms-testing");
            expect(result.processed).toBe(1);
            expect(result.skipped).toBe(0);
            expect(result.errors).toEqual([]);
            expect(mockApi.getCalls().length).toBe(0);
        });

        test("fails gracefully when no root category", async () => {
            const mockApi = createMockApiHelpers();
            // Sales channel without navigation category
            mockApi.mockPostResponse("search/sales-channel", {
                data: [{ id: "sc-123" }],
            });

            const { context } = createTestContext({ mockApi });
            const result = await TestingProcessor.process(context);

            expect(result.processed).toBe(0);
            expect(result.errors).toContain("Could not find root category for navigation");
        });

        test("creates Testing category hierarchy", async () => {
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/sales-channel", {
                data: [{ id: "sc-123", navigationCategoryId: "root-cat-id" }],
            });
            // All other searches return empty (nothing found, all created fresh)

            const { context } = createTestContext({ mockApi });
            await TestingProcessor.process(context);

            // Should have synced multiple times (CMS, landing page, categories)
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBeGreaterThan(0);

            // Should have created categories
            const categorySyncs = syncCalls.filter((c) => {
                const body = c.body as Record<string, unknown> | undefined;
                return body && Object.keys(body).some((k) => k.includes("Category"));
            });
            expect(categorySyncs.length).toBeGreaterThan(0);
        });

        test("creates Cookie settings category with correct properties", async () => {
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/sales-channel", {
                data: [{ id: "sc-123", navigationCategoryId: "root-cat-id" }],
            });

            const { context } = createTestContext({ mockApi });
            await TestingProcessor.process(context);

            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            const syncBodies = syncCalls
                .map((c) => c.body as Record<string, unknown> | undefined)
                .filter(Boolean);

            let cookieCategoryPayload: Record<string, unknown> | undefined;
            for (const body of syncBodies) {
                if (!body) continue;
                for (const op of Object.values(body)) {
                    const categoryOp = op as {
                        entity?: string;
                        payload?: Array<Record<string, unknown>>;
                    };
                    if (categoryOp?.entity === "category" && Array.isArray(categoryOp.payload)) {
                        const cookieCat = categoryOp.payload.find(
                            (p: Record<string, unknown>) => p.name === "Cookie settings"
                        );
                        if (cookieCat) {
                            cookieCategoryPayload = cookieCat;
                            break;
                        }
                    }
                }
                if (cookieCategoryPayload) break;
            }

            expect(cookieCategoryPayload).toBeDefined();
            expect(cookieCategoryPayload?.type).toBe("link");
            expect(cookieCategoryPayload?.linkType).toBe("external");
            expect(cookieCategoryPayload?.externalLink).toBe("/cookie/offcanvas");
            expect(cookieCategoryPayload?.linkNewTab).toBe(false);
        });

        test("reports errors when CMS landing pages are missing", async () => {
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/sales-channel", {
                data: [{ id: "sc-123", navigationCategoryId: "root-cat-id" }],
            });

            const { context } = createTestContext({ mockApi });
            const result = await TestingProcessor.process(context);

            // No landing pages in cache => missing CMS sub-categories
            const missingErrors = result.errors.filter(
                (e) =>
                    e.includes("Missing landing page") || e.includes("Missing CMS sub-categories")
            );
            expect(missingErrors.length).toBeGreaterThan(0);
            expect(result.processed).toBe(0);
        });

        test("expects a Media Product link on shops with a 3D gallery", async () => {
            const missing = await missingProductCategories("6.7.16.0");
            expect(missing).toContain("Media Product");
            expect(missing).toContain("Digital Product");
        });

        test("does not expect a Media Product link on shops without a 3D gallery", async () => {
            const missing = await missingProductCategories("6.5.8.0");
            expect(missing).not.toContain("Media Product");
            expect(missing).toContain("Digital Product");
        });
    });

    describe("cleanup", () => {
        test("dry run logs without deletions", async () => {
            const { context, mockApi } = createTestContext({ dryRun: true });

            const result = await TestingProcessor.cleanup(context);

            expect(result.name).toBe("cms-testing");
            expect(result.deleted).toBe(0);
            expect(result.errors).toEqual([]);
            expect(mockApi.getCalls().length).toBe(0);
        });

        test("deletes categories in reverse order", async () => {
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/sales-channel", {
                data: [{ id: "sc-123", navigationCategoryId: "root-cat-id" }],
            });
            // Testing category exists
            mockApi.mockPostResponse("search/category", { data: [{ id: "testing-cat-id" }] });

            const { context } = createTestContext({ mockApi });
            await TestingProcessor.cleanup(context);

            // Should have made delete calls for categories
            const deleteCalls = mockApi.getCallsByMethod("delete");
            expect(deleteCalls.length).toBeGreaterThan(0);
        });

        test("cleanup includes the Cookie settings category", async () => {
            const categoryByFilter: Record<string, { id: string; name: string }> = {
                Testing: { id: "testing-cat-id", name: "Testing" },
                CMS: { id: "cms-cat-id", name: "CMS" },
                Products: { id: "products-cat-id", name: "Products" },
                "Cookie settings": { id: "cookie-settings-id", name: "Cookie settings" },
            };

            const mockApi = createMockApiHelpers();

            const originalPost = mockApi.post.bind(mockApi);
            mockApi.post = async <T = unknown>(endpoint: string, body?: unknown): Promise<T> => {
                if (endpoint === "search/category") {
                    const b = body as { filter?: Array<{ value?: string }> };
                    const nameFilter = b.filter?.find(
                        (f: { value?: string }) => f.value && categoryByFilter[f.value]
                    );
                    const cat = nameFilter
                        ? categoryByFilter[nameFilter.value as string]
                        : undefined;
                    if (cat) {
                        return { data: [{ id: cat.id, name: cat.name }] } as T;
                    }
                    return { data: [] } as T;
                }
                if (endpoint === "search/sales-channel") {
                    return { data: [{ id: "sc-123", navigationCategoryId: "root-cat-id" }] } as T;
                }
                return originalPost(endpoint, body);
            };

            const { context } = createTestContext({ mockApi });
            const result = await TestingProcessor.cleanup(context);

            expect(result.deleted).toBeGreaterThan(0);
            expect(result.errors).toEqual([]);
        });
    });
});

/** Runs the processor against an empty shop and returns the reported missing product links */
async function missingProductCategories(version: string): Promise<string> {
    const mockApi = createMockApiHelpers();
    mockApi.mockPostResponse("search/sales-channel", {
        data: [{ id: "sc-123", navigationCategoryId: "root-cat-id" }],
    });

    const { context } = createTestContext({
        mockApi,
        shopware: ShopwareCapabilities.fromVersion(version),
    });
    const result = await TestingProcessor.process(context);

    return result.errors.find((e) => e.startsWith("Missing Product sub-categories")) ?? "";
}

// =============================================================================
// Characterization tests (step flow of process and cleanup)
// =============================================================================

type StepCall = [string, ...unknown[]];

interface StepStubs {
    root?: string | null;
    testingLandingPage?: string | null;
    lastRootChild?: string | null;
    categories?: Record<string, string | null>;
    cmsLandingPage?: string | null;
    navigation?: string | null;
    stepError?: string;
    throwIn?: string;
    thrown?: unknown;
}

/** Processor whose steps are stubbed and record their calls */
function withSteps(stubs: StepStubs, calls: StepCall[]): typeof TestingProcessor {
    const step =
        <T>(name: string, value: T) =>
        async (_context: PostProcessorContext, ...args: unknown[]): Promise<T> => {
            calls.push([name, ...args]);
            if (stubs.throwIn === name) throw stubs.thrown;
            if (stubs.stepError === name) (args.at(-1) as string[]).push(`${name} failed`);
            return value;
        };
    const processor = Object.create(TestingProcessor) as typeof TestingProcessor;
    Object.assign(processor, {
        getRootCategoryId: step("root", "root" in stubs ? stubs.root : "root-id"),
        createTestingLandingPage: async (_c: PostProcessorContext, errors: string[]) => {
            calls.push(["testingLandingPage"]);
            if (stubs.throwIn === "testingLandingPage") throw stubs.thrown;
            if (stubs.stepError === "testingLandingPage") errors.push("testingLandingPage failed");
            return "testingLandingPage" in stubs ? stubs.testingLandingPage : "lp-testing";
        },
        getLastRootChildId: step(
            "lastRootChild",
            "lastRootChild" in stubs ? stubs.lastRootChild : "last-child"
        ),
        ensureCategory: async (
            _c: PostProcessorContext,
            name: string,
            parentId: string,
            landingPageId: string,
            errors: string[],
            afterId: string | undefined
        ) => {
            calls.push(["ensureCategory", name, parentId, landingPageId, afterId]);
            if (stubs.stepError === `ensure-${name}`) errors.push(`${name} failed`);
            const ids = stubs.categories ?? {};
            return name in ids ? ids[name] : `${name.toLowerCase()}-id`;
        },
        createCmsShowcaseLandingPage: async (_c: PostProcessorContext, errors: string[]) => {
            calls.push(["cmsLandingPage"]);
            if (stubs.stepError === "cmsLandingPage") errors.push("cmsLandingPage failed");
            return "cmsLandingPage" in stubs ? stubs.cmsLandingPage : "lp-cms";
        },
        createCmsElementCategories: step("cmsElements", undefined),
        ensureNavigationCategory: step(
            "navigation",
            "navigation" in stubs ? stubs.navigation : "products-id"
        ),
        createProductCategories: step("productCategories", undefined),
        ensureCookieSettingsCategory: step("cookieSettings", undefined),
        validateHierarchy: step("validate", undefined),
    });
    return processor;
}

function stepNames(calls: StepCall[]): string[] {
    return calls.map((call) => call[0]);
}

const FULL_STEPS = [
    "root",
    "testingLandingPage",
    "lastRootChild",
    "ensureCategory",
    "cmsLandingPage",
    "ensureCategory",
    "cmsElements",
    "navigation",
    "productCategories",
    "cookieSettings",
    "validate",
];

describe("TestingProcessor (characterization)", () => {
    describe("process", () => {
        test("dry run logs every planned section", async () => {
            const info = spyOn(logger, "info");
            const { context } = createTestContext({ dryRun: true });

            const result = await TestingProcessor.process(context);

            const messages = info.mock.calls.map((call) => call[0]);
            info.mockRestore();
            expect(result).toEqual({
                name: "cms-testing",
                processed: 1,
                skipped: 0,
                errors: [],
                durationMs: 0,
            });
            expect(messages).toEqual([
                "    [DRY RUN] Would create Testing category hierarchy",
                "    [DRY RUN] Would create CMS sub-section with 6 pages",
                "    [DRY RUN] Would create Products sub-section with 4 links",
                "    [DRY RUN] Would create Cookie settings external link category",
            ]);
        });

        test("runs every step in order with the ids of the previous steps", async () => {
            const calls: StepCall[] = [];
            const { context } = createTestContext();

            const result = await withSteps({}, calls).process(context);

            expect(result).toEqual({
                name: "cms-testing",
                processed: 1,
                skipped: 0,
                errors: [],
                durationMs: 0,
            });
            expect(stepNames(calls)).toEqual(FULL_STEPS);
            expect(calls[2]).toEqual(["lastRootChild", "root-id"]);
            expect(calls[3]).toEqual([
                "ensureCategory",
                "Testing",
                "root-id",
                "lp-testing",
                "last-child",
            ]);
            expect(calls[5]).toEqual(["ensureCategory", "CMS", "testing-id", "lp-cms", undefined]);
            expect(calls[6]).toEqual(["cmsElements", "cms-id", []]);
            expect(calls[7]).toEqual(["navigation", "Products", "testing-id", [], "cms-id"]);
            expect(calls[8]).toEqual(["productCategories", "products-id", []]);
            expect(calls[9]).toEqual(["cookieSettings", "testing-id", "products-id", []]);
            expect(calls[10]).toEqual(["validate", "cms-id", "products-id", []]);
        });

        test("places Testing without a sibling when the root has no children", async () => {
            const calls: StepCall[] = [];
            const { context } = createTestContext();

            await withSteps({ lastRootChild: null }, calls).process(context);

            expect(calls[3]).toEqual([
                "ensureCategory",
                "Testing",
                "root-id",
                "lp-testing",
                undefined,
            ]);
        });

        test("stops without a root category", async () => {
            const calls: StepCall[] = [];
            const { context } = createTestContext();

            const result = await withSteps({ root: null }, calls).process(context);

            expect(result).toEqual({
                name: "cms-testing",
                processed: 0,
                skipped: 0,
                errors: ["Could not find root category for navigation"],
                durationMs: 0,
            });
            expect(stepNames(calls)).toEqual(["root"]);
        });

        const stops: Array<[string, StepStubs, number]> = [
            ["the Testing landing page", { testingLandingPage: null }, 2],
            ["the Testing category", { categories: { Testing: null } }, 4],
            ["the CMS landing page", { cmsLandingPage: null }, 5],
            ["the CMS category", { categories: { CMS: null } }, 6],
            ["the Products category", { navigation: null }, 8],
        ];
        for (const [label, stubs, stepCount] of stops) {
            test(`stops when ${label} cannot be created`, async () => {
                const calls: StepCall[] = [];
                const { context } = createTestContext();

                const result = await withSteps(stubs, calls).process(context);

                expect(result).toEqual({
                    name: "cms-testing",
                    processed: 0,
                    skipped: 0,
                    errors: [],
                    durationMs: 0,
                });
                expect(stepNames(calls)).toEqual(FULL_STEPS.slice(0, stepCount));
            });
        }

        test("keeps the errors of a stopping step", async () => {
            const calls: StepCall[] = [];
            const { context } = createTestContext();

            const result = await withSteps(
                { testingLandingPage: null, stepError: "testingLandingPage" },
                calls
            ).process(context);

            expect(result.errors).toEqual(["testingLandingPage failed"]);
            expect(result.processed).toBe(0);
        });

        test("continues after a step error but reports it", async () => {
            const calls: StepCall[] = [];
            const { context } = createTestContext();

            const result = await withSteps({ stepError: "cmsElements" }, calls).process(context);

            expect(stepNames(calls)).toEqual(FULL_STEPS);
            expect(result.processed).toBe(0);
            expect(result.errors).toEqual(["cmsElements failed"]);
        });

        test("reports a thrown error with its message", async () => {
            const calls: StepCall[] = [];
            const { context } = createTestContext();

            const result = await withSteps(
                {
                    throwIn: "cmsElements",
                    thrown: new Error("boom"),
                    stepError: "testingLandingPage",
                },
                calls
            ).process(context);

            expect(stepNames(calls)).toEqual(FULL_STEPS.slice(0, 7));
            expect(result).toEqual({
                name: "cms-testing",
                processed: 0,
                skipped: 0,
                errors: ["testingLandingPage failed", "Testing processor failed: boom"],
                durationMs: 0,
            });
        });

        test("reports a thrown non-error value as text", async () => {
            const { context } = createTestContext();

            const result = await withSteps({ throwIn: "root", thrown: "offline" }, []).process(
                context
            );

            expect(result.errors).toEqual(["Testing processor failed: offline"]);
        });
    });

    describe("cleanup", () => {
        type DeleteCall = [string, string, string];

        interface CleanupStubs {
            root?: string | null;
            children?: Record<string, string>;
            deleteResult?: number;
            throwOnRoot?: unknown;
        }

        function withCleanupSteps(
            stubs: CleanupStubs,
            deletes: DeleteCall[],
            landingPages: string[]
        ): { processor: typeof TestingProcessor; context: PostProcessorContext } {
            const children = stubs.children ?? {};
            const mockApi = createMockApiHelpers();
            const originalPost = mockApi.post.bind(mockApi);
            mockApi.post = async <T = unknown>(endpoint: string, body?: unknown): Promise<T> => {
                if (endpoint !== "search/category") return originalPost(endpoint, body);
                const filter = (body as { filter: Array<{ value: string }> }).filter;
                const key = `${filter[1]?.value}/${filter[0]?.value}`;
                const id = children[key];
                return { data: id ? [{ id }] : [] } as T;
            };
            const { context } = createTestContext({ mockApi });

            const processor = Object.create(TestingProcessor) as typeof TestingProcessor;
            Object.assign(processor, {
                getRootCategoryId: async () => {
                    if (stubs.throwOnRoot !== undefined) throw stubs.throwOnRoot;
                    return "root" in stubs ? stubs.root : "root-id";
                },
                deleteCategoryById: async (_c: PostProcessorContext, id: string, name: string) => {
                    deletes.push(["byId", id, name]);
                    return stubs.deleteResult ?? 1;
                },
                deleteSubCategory: async (
                    _c: PostProcessorContext,
                    name: string,
                    parent: string
                ) => {
                    deletes.push(["sub", name, parent]);
                    return stubs.deleteResult ?? 1;
                },
                cleanupLandingPage: async (
                    _c: PostProcessorContext,
                    name: string,
                    errors: string[]
                ) => {
                    landingPages.push(name);
                    errors.push(`lp ${name}`);
                },
            });
            return { processor, context };
        }

        const FULL_TREE = {
            "root-id/Testing": "testing-id",
            "testing-id/CMS": "cms-id",
            "testing-id/Products": "products-id",
            "testing-id/Cookie settings": "cookie-id",
        };

        test("dry run logs the planned deletion", async () => {
            const info = spyOn(logger, "info");
            const { context } = createTestContext({ dryRun: true });

            await TestingProcessor.cleanup(context);

            const messages = info.mock.calls.map((call) => call[0]);
            info.mockRestore();
            expect(messages).toEqual(['    [DRY RUN] Would delete "Testing" category hierarchy']);
        });

        test("deletes children before their parents and then the landing pages", async () => {
            const deletes: DeleteCall[] = [];
            const landingPages: string[] = [];
            const { processor, context } = withCleanupSteps(
                { children: FULL_TREE },
                deletes,
                landingPages
            );

            const result = await processor.cleanup(context);

            expect(deletes).toEqual([
                ["byId", "cookie-id", "Cookie settings"],
                ["sub", "Form", "cms-id"],
                ["sub", "Commerce", "cms-id"],
                ["sub", "Text & Images", "cms-id"],
                ["sub", "Video", "cms-id"],
                ["sub", "Images", "cms-id"],
                ["sub", "Text", "cms-id"],
                ["byId", "cms-id", "CMS"],
                ["sub", "Media Product", "products-id"],
                ["sub", "Digital Product", "products-id"],
                ["sub", "Variant Product", "products-id"],
                ["sub", "Simple Product", "products-id"],
                ["byId", "products-id", "Products"],
                ["byId", "testing-id", "Testing"],
            ]);
            expect(landingPages).toEqual(["Testing Overview", "CMS Element Showcase"]);
            expect(result).toEqual({
                name: "cms-testing",
                deleted: 14,
                errors: ["lp Testing Overview", "lp CMS Element Showcase"],
                durationMs: 0,
            });
        });

        test("counts only the categories that were deleted", async () => {
            const { processor, context } = withCleanupSteps(
                { children: FULL_TREE, deleteResult: 0 },
                [],
                []
            );

            const result = await processor.cleanup(context);

            expect(result.deleted).toBe(0);
        });

        test("deletes only Testing when it has no sub-sections", async () => {
            const deletes: DeleteCall[] = [];
            const landingPages: string[] = [];
            const { processor, context } = withCleanupSteps(
                { children: { "root-id/Testing": "testing-id" } },
                deletes,
                landingPages
            );

            const result = await processor.cleanup(context);

            expect(deletes).toEqual([["byId", "testing-id", "Testing"]]);
            expect(landingPages.length).toBe(2);
            expect(result.deleted).toBe(1);
        });

        test("skips when the Testing category does not exist", async () => {
            const info = spyOn(logger, "info");
            const deletes: DeleteCall[] = [];
            const landingPages: string[] = [];
            const { processor, context } = withCleanupSteps({}, deletes, landingPages);

            const result = await processor.cleanup(context);

            const messages = info.mock.calls.map((call) => call[0]);
            info.mockRestore();
            expect(result).toEqual({ name: "cms-testing", deleted: 0, errors: [], durationMs: 0 });
            expect(messages).toContain('    ⊘ "Testing" category not found');
            expect(deletes).toEqual([]);
            expect(landingPages).toEqual([]);
        });

        test("fails without a root category", async () => {
            const deletes: DeleteCall[] = [];
            const { processor, context } = withCleanupSteps(
                { root: null, children: FULL_TREE },
                deletes,
                []
            );

            const result = await processor.cleanup(context);

            expect(result).toEqual({
                name: "cms-testing",
                deleted: 0,
                errors: ["Could not find root category"],
                durationMs: 0,
            });
            expect(deletes).toEqual([]);
        });

        test("reports a thrown error with its message", async () => {
            const { processor, context } = withCleanupSteps(
                { throwOnRoot: new Error("gone") },
                [],
                []
            );

            const result = await processor.cleanup(context);

            expect(result).toEqual({
                name: "cms-testing",
                deleted: 0,
                errors: ["Cleanup failed: gone"],
                durationMs: 0,
            });
        });

        test("reports a thrown non-error value as text", async () => {
            const { processor, context } = withCleanupSteps({ throwOnRoot: "nope" }, [], []);

            const result = await processor.cleanup(context);

            expect(result.errors).toEqual(["Cleanup failed: nope"]);
        });
    });
});
