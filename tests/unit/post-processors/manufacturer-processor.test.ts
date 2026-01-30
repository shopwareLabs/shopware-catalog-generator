import { describe, expect, mock, test } from "bun:test";

import type { PostProcessorContext } from "../../../src/post-processors/index.js";
// Mock the ManufacturerProcessor by importing the module
// We need to test the exported singleton
import { ManufacturerProcessor } from "../../../src/post-processors/manufacturer-processor.js";
import type { HydratedBlueprint } from "../../../src/types/index.js";
import { createMockApiHelpers, type MockApiHelpers } from "../../mocks/index.js";

// Helper to create a minimal mock blueprint
function createMockBlueprint(
    products: Array<{
        id: string;
        name: string;
        manufacturerName?: string;
    }>
): HydratedBlueprint {
    return {
        version: "1.0",
        salesChannel: { name: "test-store", description: "Test store" },
        categories: [],
        products: products.map((p) => ({
            id: p.id,
            name: p.name,
            description: "Test description",
            price: 29.99,
            stock: 10,
            primaryCategoryId: "cat1",
            categoryIds: ["cat1"],
            metadata: {
                imageCount: 1 as const,
                imageDescriptions: [],
                isVariant: false,
                properties: [],
                manufacturerName: p.manufacturerName,
                reviewCount: 0 as const,
                hasSalesPrice: false,
            },
        })),
        propertyGroups: [],
        createdAt: new Date().toISOString(),
        hydratedAt: new Date().toISOString(),
    };
}

// Helper to create mock cache
function createMockCache() {
    const manufacturers: Array<{ id: string; name: string }> = [];
    return {
        loadManufacturers: mock(() => (manufacturers.length > 0 ? manufacturers : null)),
        saveManufacturers: mock(
            (_salesChannelName: string, mfgs: Array<{ id: string; name: string }>) => {
                manufacturers.push(...mfgs);
            }
        ),
        loadProductMetadata: mock(() => null),
    };
}

// Helper to create mock context
function createMockContext(
    blueprint: HydratedBlueprint,
    options: { dryRun?: boolean; mockApi?: MockApiHelpers } = {}
): PostProcessorContext {
    return {
        salesChannelId: "sc-123",
        salesChannelName: "test-store",
        blueprint,
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

describe("ManufacturerProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(ManufacturerProcessor.name).toBe("manufacturers");
        });

        test("has description", () => {
            expect(ManufacturerProcessor.description).toBeDefined();
            expect(ManufacturerProcessor.description.length).toBeGreaterThan(0);
        });

        test("has no dependencies", () => {
            expect(ManufacturerProcessor.dependsOn).toEqual([]);
        });
    });

    describe("process", () => {
        test("returns error when no manufacturers in products", async () => {
            const blueprint = createMockBlueprint([
                { id: "p1", name: "Product 1" },
                { id: "p2", name: "Product 2" },
            ]);
            const context = createMockContext(blueprint);

            const result = await ManufacturerProcessor.process(context);

            expect(result.name).toBe("manufacturers");
            expect(result.processed).toBe(0);
            expect(result.errors).toContain("No manufacturer names found in products");
        });

        test("collects unique manufacturer names from products", async () => {
            const blueprint = createMockBlueprint([
                { id: "p1", name: "Product 1", manufacturerName: "Acme Corp" },
                { id: "p2", name: "Product 2", manufacturerName: "Acme Corp" },
                { id: "p3", name: "Product 3", manufacturerName: "Best Inc" },
            ]);
            const context = createMockContext(blueprint, { dryRun: true });

            const result = await ManufacturerProcessor.process(context);

            // In dry run mode, it should report 2 unique manufacturers
            expect(result.processed).toBe(2);
        });

        test("skips empty manufacturer names", async () => {
            const blueprint = createMockBlueprint([
                { id: "p1", name: "Product 1", manufacturerName: "" },
                { id: "p2", name: "Product 2", manufacturerName: "   " },
                { id: "p3", name: "Product 3", manufacturerName: "Valid Corp" },
            ]);
            const context = createMockContext(blueprint, { dryRun: true });

            const result = await ManufacturerProcessor.process(context);

            // Only 1 valid manufacturer
            expect(result.processed).toBe(1);
        });

        test("dry run mode logs without creating", async () => {
            const blueprint = createMockBlueprint([
                { id: "p1", name: "Product 1", manufacturerName: "Test Manufacturer" },
            ]);
            const context = createMockContext(blueprint, { dryRun: true });

            const result = await ManufacturerProcessor.process(context);

            expect(result.processed).toBe(1);
            expect(result.errors).toHaveLength(0);
        });

        test("skips creating manufacturers that already exist in Shopware", async () => {
            const blueprint = createMockBlueprint([
                { id: "p1", name: "Product 1", manufacturerName: "Existing Corp" },
                { id: "p2", name: "Product 2", manufacturerName: "New Corp" },
            ]);

            const mockApi = createMockApiHelpers();

            // Mock existing manufacturer search
            mockApi.mockPostResponse("search/product-manufacturer", {
                total: 1,
                data: [{ id: "existing-mfg-id", name: "Existing Corp" }],
            });

            // Mock product search - products don't have manufacturers assigned yet
            mockApi.mockPostResponse("search/product", {
                data: blueprint.products.map((p) => ({
                    id: p.id,
                    manufacturerId: null,
                })),
            });

            // Mock sync
            mockApi.setDefaultPostResponse({ success: true });
            mockApi.mockSyncSuccess();

            const context = createMockContext(blueprint, { dryRun: false, mockApi });
            const result = await ManufacturerProcessor.process(context);

            // Only New Corp should be created (Existing Corp already exists)
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            const createCall = syncCalls.find((c) => {
                const body = c.body as Record<string, unknown>;
                return body.createManufacturers !== undefined;
            });

            if (createCall) {
                const body = createCall.body as Record<
                    string,
                    { payload: Array<{ name: string }> }
                >;
                const created = body.createManufacturers?.payload ?? [];
                expect(created).toHaveLength(1);
                expect(created[0]?.name).toBe("New Corp");
            }

            expect(result.errors).toHaveLength(0);
        });

        test("skips product updates when manufacturer already assigned", async () => {
            const blueprint = createMockBlueprint([
                { id: "p1", name: "Product 1", manufacturerName: "Test Corp" },
                { id: "p2", name: "Product 2", manufacturerName: "Test Corp" },
            ]);

            const mockApi = createMockApiHelpers();

            // Mock manufacturer exists
            mockApi.mockPostResponse("search/product-manufacturer", {
                total: 1,
                data: [{ id: "mfg-123", name: "Test Corp" }],
            });

            // Mock product search - p1 already has manufacturer, p2 doesn't
            mockApi.mockPostResponse("search/product", {
                data: [
                    { id: "p1", manufacturerId: "mfg-123" },
                    { id: "p2", manufacturerId: null },
                ],
            });

            // Mock sync
            mockApi.setDefaultPostResponse({ success: true });
            mockApi.mockSyncSuccess();

            const context = createMockContext(blueprint, { dryRun: false, mockApi });
            await ManufacturerProcessor.process(context);

            // Check that only p2 was updated (p1 already has correct manufacturer)
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            const updateCall = syncCalls.find((c) => {
                const body = c.body as Record<string, unknown>;
                return body.updateProductManufacturers !== undefined;
            });

            if (updateCall) {
                const body = updateCall.body as Record<string, { payload: Array<{ id: string }> }>;
                const updates = body.updateProductManufacturers?.payload ?? [];
                expect(updates).toHaveLength(1);
                expect(updates[0]?.id).toBe("p2");
            }
        });
    });
});
