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

    describe("cleanup", () => {
        test("returns early in dry run mode", async () => {
            const { context } = createTestContext({ dryRun: true });
            const result = await ManufacturerProcessor.cleanup!(context);
            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("returns 0 deleted when no products in SalesChannel", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponse("product", []);
            const result = await ManufacturerProcessor.cleanup!(context);
            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("returns 0 deleted when products have no manufacturerIds", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponse("product", [
                { id: "p1", manufacturerId: undefined },
                { id: "p2" },
            ]);
            const result = await ManufacturerProcessor.cleanup!(context);
            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("unassigns and deletes orphaned manufacturers", async () => {
            const { context, mockApi } = createTestContext();
            // First call: products with manufacturerIds; second call: orphan check returns 0
            mockApi.mockSearchResponseSequence("product", [
                [{ id: "p1", manufacturerId: "mfg-1" }],
                [],
            ]);
            const result = await ManufacturerProcessor.cleanup!(context);
            expect(result.deleted).toBe(1);
            expect(result.errors).toHaveLength(0);
            const unassignCall = mockApi
                .getCalls()
                .find((c) => (c.body as Record<string, unknown>)?.unassignManufacturers);
            expect(unassignCall).toBeDefined();
        });

        test("does not delete manufacturers still used by other products", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponseSequence("product", [
                [{ id: "p1", manufacturerId: "mfg-1" }],
                [{ id: "p2" }],
            ]);
            const result = await ManufacturerProcessor.cleanup!(context);
            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
        });
    });
});

describe("ManufacturerProcessor with a stale cache", () => {
    const blueprint = createTestBlueprint({
        products: [
            createTestProduct({ id: "p1", metadata: { manufacturerName: "Existing Corp" } }),
            createTestProduct({ id: "p2", metadata: { manufacturerName: "Missing Corp" } }),
        ],
    });

    function setup() {
        const { context, mockApi, mockCache } = createTestContext({ blueprint, dryRun: false });
        // Cached IDs from another shop: neither ID exists in this one
        mockCache.saveManufacturers("test-store", [
            { id: "stale-existing", name: "Existing Corp", description: "cached text" },
            { id: "stale-missing", name: "Missing Corp", description: "cached text" },
        ]);
        mockCache.saveManufacturersMock.mockClear();
        mockApi.mockPostResponse("search/product-manufacturer", {
            total: 1,
            data: [{ id: "shop-existing", name: "Existing Corp" }],
        });
        mockApi.mockPostResponse("search/product", { data: [] });
        mockApi.setDefaultPostResponse({ success: true });
        return { context, mockApi, mockCache };
    }

    test("creates a cached manufacturer that does not exist in Shopware", async () => {
        const { context, mockApi } = setup();
        await ManufacturerProcessor.process(context);

        const createCall = mockApi
            .getCallsByEndpoint("_action/sync")
            .find((c) => (c.body as Record<string, unknown>).createManufacturers !== undefined);
        const body = createCall?.body as Record<string, { payload: Array<{ name: string }> }>;
        expect(body.createManufacturers?.payload.map((m) => m.name)).toEqual(["Missing Corp"]);
    });

    test("saves the Shopware IDs instead of the stale cached ones", async () => {
        const { context, mockCache } = setup();
        await ManufacturerProcessor.process(context);

        const saved = mockCache.saveManufacturersMock.mock.calls.at(-1)?.[1] ?? [];
        const ids = new Map(saved.map((m) => [m.name, m.id]));
        expect(ids.get("Existing Corp")).toBe("shop-existing");
        expect(ids.get("Missing Corp")).not.toBe("stale-missing");
        expect(saved.find((m) => m.name === "Existing Corp")?.description).toBe("cached text");
    });
});

describe("ManufacturerProcessor sync errors", () => {
    const blueprint = createTestBlueprint({
        products: [
            createTestProduct({ id: "p1", metadata: { manufacturerName: "Existing Corp" } }),
            createTestProduct({ id: "p2", metadata: { manufacturerName: "New Corp" } }),
        ],
    });

    function setup(existing: Array<{ id: string; name: string }>, failSync = true) {
        const { context, mockApi, mockCache } = createTestContext({ blueprint, dryRun: false });
        mockApi.mockPostResponse("search/product-manufacturer", {
            total: existing.length,
            data: existing,
        });
        mockApi.mockPostResponse("search/product", { data: [] });
        if (failSync) mockApi.mockPostFailure("_action/sync", new Error("boom"));
        return { context, mockApi, mockCache };
    }

    test("a failed create is reported and products are not assigned", async () => {
        const { context, mockApi, mockCache } = setup([
            { id: "shop-existing", name: "Existing Corp" },
        ]);
        const result = await ManufacturerProcessor.process(context);

        expect(result.errors).toEqual(["Failed to create manufacturers: boom"]);
        expect(result.processed).toBe(0);
        expect(result.skipped).toBe(1);
        const searches = mockApi.getCallsByEndpoint("search/product");
        expect(searches.some((c) => c.endpoint.endsWith("search/product"))).toBe(false);
        expect(mockCache.saveManufacturersMock).toHaveBeenCalled();
    });

    test("a failed assignment is reported", async () => {
        const { context } = setup([
            { id: "shop-existing", name: "Existing Corp" },
            { id: "shop-new", name: "New Corp" },
        ]);
        const result = await ManufacturerProcessor.process(context);

        expect(result.errors).toEqual(["Failed to assign manufacturers: boom"]);
        expect(result.processed).toBe(0);
        expect(result.skipped).toBe(2);
    });

    test("assigns each product its manufacturer ID", async () => {
        const { context, mockApi } = setup(
            [
                { id: "shop-existing", name: "Existing Corp" },
                { id: "shop-new", name: "New Corp" },
            ],
            false
        );
        await ManufacturerProcessor.process(context);

        const update = mockApi
            .getCallsByEndpoint("_action/sync")
            .find((c) => (c.body as Record<string, unknown>).updateProductManufacturers);
        const body = update?.body as Record<string, { payload: unknown[] }>;
        expect(body.updateProductManufacturers?.payload).toEqual([
            { id: "p1", manufacturerId: "shop-existing" },
            { id: "p2", manufacturerId: "shop-new" },
        ]);
    });
});
