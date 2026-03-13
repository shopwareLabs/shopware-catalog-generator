import { describe, expect, test } from "bun:test";

import { ManufacturerProcessor } from "../../../src/post-processors/manufacturer-processor.js";
import { createTestBlueprint, createTestProduct } from "../../helpers/blueprint-factory.js";
import { createTestContext } from "../../helpers/post-processor-context.js";

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
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({ id: "p1", name: "Product 1" }),
                    createTestProduct({ id: "p2", name: "Product 2" }),
                ],
            });
            const { context } = createTestContext({ blueprint });

            const result = await ManufacturerProcessor.process(context);

            expect(result.name).toBe("manufacturers");
            expect(result.processed).toBe(0);
            expect(result.errors).toContain("No manufacturer names found in products");
        });

        test("collects unique manufacturer names from products", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: { manufacturerName: "Acme Corp" },
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        metadata: { manufacturerName: "Acme Corp" },
                    }),
                    createTestProduct({
                        id: "p3",
                        name: "Product 3",
                        metadata: { manufacturerName: "Best Inc" },
                    }),
                ],
            });
            const { context } = createTestContext({ blueprint, dryRun: true });

            const result = await ManufacturerProcessor.process(context);

            // In dry run mode, it should report 2 unique manufacturers
            expect(result.processed).toBe(2);
        });

        test("skips empty manufacturer names", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: { manufacturerName: "" },
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        metadata: { manufacturerName: "   " },
                    }),
                    createTestProduct({
                        id: "p3",
                        name: "Product 3",
                        metadata: { manufacturerName: "Valid Corp" },
                    }),
                ],
            });
            const { context } = createTestContext({ blueprint, dryRun: true });

            const result = await ManufacturerProcessor.process(context);

            // Only 1 valid manufacturer
            expect(result.processed).toBe(1);
        });

        test("dry run mode logs without creating", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: { manufacturerName: "Test Manufacturer" },
                    }),
                ],
            });
            const { context } = createTestContext({ blueprint, dryRun: true });

            const result = await ManufacturerProcessor.process(context);

            expect(result.processed).toBe(1);
            expect(result.errors).toHaveLength(0);
        });

        test("skips creating manufacturers that already exist in Shopware", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: { manufacturerName: "Existing Corp" },
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        metadata: { manufacturerName: "New Corp" },
                    }),
                ],
            });

            const { context, mockApi } = createTestContext({ blueprint, dryRun: false });

            mockApi.mockPostResponse("search/product-manufacturer", {
                total: 1,
                data: [{ id: "existing-mfg-id", name: "Existing Corp" }],
            });

            mockApi.mockPostResponse("search/product", {
                data: blueprint.products.map((p) => ({
                    id: p.id,
                    manufacturerId: null,
                })),
            });

            mockApi.setDefaultPostResponse({ success: true });
            mockApi.mockSyncSuccess();
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
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: { manufacturerName: "Test Corp" },
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        metadata: { manufacturerName: "Test Corp" },
                    }),
                ],
            });

            const { context, mockApi } = createTestContext({ blueprint, dryRun: false });

            mockApi.mockPostResponse("search/product-manufacturer", {
                total: 1,
                data: [{ id: "mfg-123", name: "Test Corp" }],
            });

            mockApi.mockPostResponse("search/product", {
                data: [
                    { id: "p1", manufacturerId: "mfg-123" },
                    { id: "p2", manufacturerId: null },
                ],
            });

            mockApi.setDefaultPostResponse({ success: true });
            mockApi.mockSyncSuccess();
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
