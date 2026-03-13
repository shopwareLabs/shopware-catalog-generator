import { describe, expect, test } from "bun:test";

import { TestingProcessor } from "../../../../src/post-processors/cms/testing-processor.js";
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

        test("depends on all CMS element processors and digital-product", () => {
            expect(TestingProcessor.dependsOn).toContain("cms-text");
            expect(TestingProcessor.dependsOn).toContain("cms-images");
            expect(TestingProcessor.dependsOn).toContain("cms-video");
            expect(TestingProcessor.dependsOn).toContain("cms-text-images");
            expect(TestingProcessor.dependsOn).toContain("cms-commerce");
            expect(TestingProcessor.dependsOn).toContain("cms-form");
            expect(TestingProcessor.dependsOn).toContain("digital-product");
            expect(TestingProcessor.dependsOn.length).toBe(7);
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
