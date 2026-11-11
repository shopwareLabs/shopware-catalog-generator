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
            const { context, mockApi, mockCache } = createTestContext({ blueprint, dryRun: true });

            const result = await ManufacturerProcessor.process(context);

            expect(result.processed).toBe(1);
            expect(result.errors).toHaveLength(0);
            expect(mockApi.getCallsByEndpoint("_action/sync")).toHaveLength(0);
            expect(mockCache.saveManufacturersMock).not.toHaveBeenCalled();
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

        test("keeps the deleted count when the local cache cannot be cleared", async () => {
            const { context, mockApi, mockCache } = createTestContext();
            mockApi.mockSearchResponseSequence("product", [
                [{ id: "p1", manufacturerId: "mfg-1" }],
                [],
            ]);
            mockCache.saveManufacturersMock.mockImplementation(() => {
                throw new Error("disk full");
            });
            const result = await ManufacturerProcessor.cleanup!(context);
            expect(result.deleted).toBe(1);
            expect(result.errors).toHaveLength(0);
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

    test("retries an assignment that hits a deadlock", async () => {
        const { context, mockApi } = setup(
            [
                { id: "shop-existing", name: "Existing Corp" },
                { id: "shop-new", name: "New Corp" },
            ],
            false
        );
        mockApi.mockPostFailure(
            "_action/sync",
            new Error("SQLSTATE[40001]: Serialization failure: 1213 Deadlock found")
        );
        const result = await ManufacturerProcessor.process(context);

        expect(result.errors[0]).toContain("Failed to assign manufacturers");
        expect(mockApi.getCallsByEndpoint("_action/sync")).toHaveLength(3);
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

    test("a created manufacturer is assigned and cached with the same ID", async () => {
        const { context, mockApi, mockCache } = setup(
            [{ id: "shop-existing", name: "Existing Corp" }],
            false
        );
        const result = await ManufacturerProcessor.process(context);

        const syncs = mockApi.getCallsByEndpoint("_action/sync").map((c) => c.body);
        const created = syncs.find(
            (b): b is { createManufacturers: { payload: Array<{ id: string; name: string }> } } =>
                typeof b === "object" && b !== null && "createManufacturers" in b
        );
        const createdId = created?.createManufacturers.payload[0]?.id;
        expect(createdId).toBeString();
        expect(result.processed).toBe(1);
        expect(result.errors).toEqual([]);

        const update = syncs.find(
            (b): b is { updateProductManufacturers: { payload: unknown[] } } =>
                typeof b === "object" && b !== null && "updateProductManufacturers" in b
        );
        expect(update?.updateProductManufacturers.payload).toContainEqual({
            id: "p2",
            manufacturerId: createdId,
        });
        const saved = mockCache.saveManufacturersMock.mock.calls.at(-1)?.[1] ?? [];
        expect(saved.find((m) => m.name === "New Corp")?.id).toBe(createdId);
    });

    test("sends no product update when every product already has its manufacturer", async () => {
        const { context, mockApi } = setup(
            [
                { id: "shop-existing", name: "Existing Corp" },
                { id: "shop-new", name: "New Corp" },
            ],
            false
        );
        mockApi.mockPostResponse("search/product", {
            data: [
                { id: "p1", manufacturerId: "shop-existing" },
                { id: "p2", manufacturerId: "shop-new" },
            ],
        });
        await ManufacturerProcessor.process(context);

        expect(mockApi.getCallsByEndpoint("_action/sync")).toHaveLength(0);
    });
});

describe("ManufacturerProcessor (characterization)", () => {
    function productsWith(
        names: Array<string | undefined>
    ): ReturnType<typeof createTestBlueprint> {
        return createTestBlueprint({
            products: names.map((manufacturerName, i) =>
                createTestProduct({ id: `p${i + 1}`, metadata: { manufacturerName } })
            ),
        });
    }

    function syncBodies(mockApi: ReturnType<typeof createTestContext>["mockApi"]) {
        return mockApi
            .getCallsByEndpoint("_action/sync")
            .map((c) => c.body as Record<string, { entity: string; payload: unknown[] }>);
    }

    function productSearches(mockApi: ReturnType<typeof createTestContext>["mockApi"]) {
        return mockApi.getCalls().filter((c) => c.endpoint === "search/product");
    }

    test("trims names and deduplicates them", async () => {
        const { context, mockApi, mockCache } = createTestContext({
            blueprint: productsWith(["  Acme  ", "Acme", "   ", undefined]),
        });
        mockApi.mockPostResponse("search/product-manufacturer", { data: [] });
        mockApi.mockPostResponse("search/product", { data: [] });

        const result = await ManufacturerProcessor.process(context);

        expect(result).toEqual({
            name: "manufacturers",
            processed: 1,
            skipped: 0,
            errors: [],
            durationMs: 0,
        });
        const [create, assign] = syncBodies(mockApi);
        const created = create?.createManufacturers?.payload as Array<{
            id: string;
            name: string;
            link: string;
            description: string;
        }>;
        expect(created.map((m) => m.name)).toEqual(["Acme"]);
        expect(created[0]?.link).toBe("https://www.acme.com");
        expect(created[0]?.description.length).toBeGreaterThan(0);
        expect(create?.createManufacturers?.entity).toBe("product_manufacturer");
        expect(assign?.updateProductManufacturers?.entity).toBe("product");
        expect(assign?.updateProductManufacturers?.payload).toEqual([
            { id: "p1", manufacturerId: created[0]?.id },
            { id: "p2", manufacturerId: created[0]?.id },
        ]);
        const saved = mockCache.saveManufacturersMock.mock.calls.at(-1);
        expect(saved?.[0]).toBe("test-store");
        expect(saved?.[1].map((m): unknown[] => [m.name, m.id])).toEqual([
            ["Acme", created[0]?.id],
        ]);
    });

    test("searches manufacturers by name with equalsAny", async () => {
        const { context, mockApi } = createTestContext({ blueprint: productsWith(["A", "B"]) });
        mockApi.mockPostResponse("search/product", { data: [] });

        await ManufacturerProcessor.process(context);

        const search = mockApi.getCalls().find((c) => c.endpoint === "search/product-manufacturer");
        expect(search?.body).toEqual({
            limit: 500,
            filter: [{ type: "equalsAny", field: "name", value: ["A", "B"] }],
        });
    });

    test("matches nested Admin API results by translated name or attribute id", async () => {
        const { context, mockApi } = createTestContext({
            blueprint: productsWith(["Acme", "Best", "Gone"]),
        });
        mockApi.mockPostResponse("search/product-manufacturer", {
            data: [
                { id: "m-acme", attributes: { name: "Old", translated: { name: "Acme" } } },
                { attributes: { id: "m-best", name: "Best" } },
                { attributes: { name: "Gone" } },
                { id: "m-none" },
            ],
        });
        mockApi.mockPostResponse("search/product", { data: [] });

        const result = await ManufacturerProcessor.process(context);

        expect(result.skipped).toBe(2);
        expect(result.processed).toBe(1);
        const [create, assign] = syncBodies(mockApi);
        const created = create?.createManufacturers?.payload as Array<{ name: string }>;
        expect(created.map((m) => m.name)).toEqual(["Gone"]);
        const updates = assign?.updateProductManufacturers?.payload as Array<{
            id: string;
            manufacturerId: string;
        }>;
        expect(updates.slice(0, 2)).toEqual([
            { id: "p1", manufacturerId: "m-acme" },
            { id: "p2", manufacturerId: "m-best" },
        ]);
    });

    test("reports a failed create and does not assign", async () => {
        const { context, mockApi, mockCache } = createTestContext({
            blueprint: productsWith(["Acme"]),
        });
        mockApi.mockPostResponse("search/product-manufacturer", { data: [] });
        mockApi.mockPostFailure("_action/sync", new Error("boom"));

        const result = await ManufacturerProcessor.process(context);

        expect(result.processed).toBe(0);
        expect(result.errors).toEqual(["Failed to create manufacturers: boom"]);
        expect(productSearches(mockApi)).toHaveLength(0);
        expect(mockCache.saveManufacturersMock).toHaveBeenCalledTimes(1);
    });

    test("stringifies non-Error create failures", async () => {
        const { context, mockApi } = createTestContext({ blueprint: productsWith(["Acme"]) });
        mockApi.mockPostResponse("search/product-manufacturer", { data: [] });
        mockApi.mockPostFailure("_action/sync", "plain" as unknown as Error);

        const result = await ManufacturerProcessor.process(context);

        expect(result.errors).toEqual(["Failed to create manufacturers: plain"]);
    });

    test("reports a failed assignment", async () => {
        const { context, mockApi } = createTestContext({ blueprint: productsWith(["Acme"]) });
        mockApi.mockPostResponse("search/product-manufacturer", {
            data: [{ id: "m1", name: "Acme" }],
        });
        mockApi.mockPostResponse("search/product", { data: [] });
        mockApi.mockPostFailure("_action/sync", new Error("nope"));

        const result = await ManufacturerProcessor.process(context);

        expect(result).toEqual({
            name: "manufacturers",
            processed: 0,
            skipped: 1,
            errors: ["Failed to assign manufacturers: nope"],
            durationMs: 0,
        });
    });

    test("counts created manufacturers even when the assignment fails afterwards", async () => {
        const { context, mockApi } = createTestContext({ blueprint: productsWith(["Acme"]) });
        mockApi.mockPostResponse("search/product-manufacturer", { data: [] });
        mockApi.mockPostResponse("search/product", { data: [] });
        const post = mockApi.post.bind(mockApi);
        let syncCalls = 0;
        mockApi.post = async (endpoint, body) => {
            if (endpoint === "_action/sync" && ++syncCalls === 2) throw new Error("nope");
            return post(endpoint, body);
        };

        const result = await ManufacturerProcessor.process(context);

        expect(result.processed).toBe(1);
        expect(result.skipped).toBe(0);
        expect(result.errors).toEqual(["Failed to assign manufacturers: nope"]);
        expect(syncCalls).toBe(2);
    });

    test("does not sync when every product already has its manufacturer", async () => {
        const { context, mockApi } = createTestContext({ blueprint: productsWith(["Acme"]) });
        mockApi.mockPostResponse("search/product-manufacturer", {
            data: [{ id: "m1", name: "Acme" }],
        });
        mockApi.mockPostResponse("search/product", { data: [{ id: "p1", manufacturerId: "m1" }] });

        const result = await ManufacturerProcessor.process(context);

        expect(syncBodies(mockApi)).toHaveLength(0);
        expect(result.errors).toEqual([]);
    });

    test("reassigns products that have a different manufacturer", async () => {
        const { context, mockApi } = createTestContext({ blueprint: productsWith(["Acme"]) });
        mockApi.mockPostResponse("search/product-manufacturer", {
            data: [{ id: "m1", name: "Acme" }],
        });
        mockApi.mockPostResponse("search/product", { data: [{ id: "p1", manufacturerId: "m2" }] });

        await ManufacturerProcessor.process(context);

        expect(syncBodies(mockApi)[0]?.updateProductManufacturers?.payload).toEqual([
            { id: "p1", manufacturerId: "m1" },
        ]);
    });

    test("queries product assignments in batches of 100", async () => {
        const names = Array.from({ length: 150 }, () => "Acme");
        const { context, mockApi } = createTestContext({ blueprint: productsWith(names) });
        mockApi.mockPostResponse("search/product-manufacturer", {
            data: [{ id: "m1", name: "Acme" }],
        });
        mockApi.mockPostResponse("search/product", { data: [] });

        await ManufacturerProcessor.process(context);

        const batches = productSearches(mockApi).map(
            (c) => c.body as { ids: string[]; includes: unknown }
        );
        expect(batches.map((b) => b.ids.length)).toEqual([100, 50]);
        expect(batches[0]?.ids[0]).toBe("p1");
        expect(batches[1]?.ids[0]).toBe("p101");
        expect(batches[0]?.includes).toEqual({ product: ["id", "manufacturerId"] });
    });

    test("ignores responses without data and assigns everything", async () => {
        const { context, mockApi } = createTestContext({ blueprint: productsWith(["Acme"]) });
        mockApi.mockPostResponse("search/product-manufacturer", {});
        mockApi.mockPostResponse("search/product", {});

        const result = await ManufacturerProcessor.process(context);

        expect(result.processed).toBe(1);
        expect(syncBodies(mockApi)).toHaveLength(2);
    });

    test("creates all manufacturers when the manufacturer search fails", async () => {
        const { context, mockApi } = createTestContext({ blueprint: productsWith(["Acme"]) });
        mockApi.mockPostFailure("search/product-manufacturer", new Error("down"));
        mockApi.mockPostResponse("search/product", { data: [] });

        const result = await ManufacturerProcessor.process(context);

        expect(result.processed).toBe(1);
        expect(result.errors).toEqual([]);
    });

    test("assigns all products when the assignment search fails", async () => {
        const { context, mockApi } = createTestContext({ blueprint: productsWith(["Acme"]) });
        mockApi.mockPostResponse("search/product-manufacturer", {
            data: [{ id: "m1", name: "Acme" }],
        });
        mockApi.mockPostFailure("search/product", new Error("down"));
        // The pattern also matches the manufacturer search, so nothing is found there either
        const result = await ManufacturerProcessor.process(context);

        expect(result.errors).toEqual([]);
        expect(syncBodies(mockApi)).toHaveLength(2);
    });

    test("dry run reports existing manufacturers as skipped without syncing", async () => {
        const { context, mockApi, mockCache } = createTestContext({
            blueprint: productsWith(["Acme", "Best"]),
            dryRun: true,
        });
        mockApi.mockPostResponse("search/product-manufacturer", {
            data: [{ id: "m1", name: "Acme" }],
        });

        const result = await ManufacturerProcessor.process(context);

        expect(result).toEqual({
            name: "manufacturers",
            processed: 1,
            skipped: 1,
            errors: [],
            durationMs: 0,
        });
        expect(syncBodies(mockApi)).toHaveLength(0);
        expect(mockCache.saveManufacturersMock).not.toHaveBeenCalled();
    });

    describe("cleanup", () => {
        test("reports missing API helpers", async () => {
            const { context } = createTestContext();
            const result = await ManufacturerProcessor.cleanup!({
                ...context,
                api: undefined as unknown as typeof context.api,
            });
            expect(result).toEqual({
                name: "manufacturers",
                deleted: 0,
                errors: ["API helpers not available - cannot perform cleanup"],
                durationMs: 0,
            });
        });

        test("unassigns only products with a manufacturer and deletes orphans", async () => {
            const { context, mockApi, mockCache } = createTestContext();
            mockApi.mockSearchResponseSequence("product", [
                [
                    { id: "p1", manufacturerId: "m1" },
                    { id: "p2" },
                    { id: "p3", manufacturerId: "m1" },
                    { id: "p4", manufacturerId: "m2" },
                ],
                [],
                [{ id: "other" }],
            ]);

            const result = await ManufacturerProcessor.cleanup!(context);

            expect(result).toEqual({
                name: "manufacturers",
                deleted: 1,
                errors: [],
                durationMs: 0,
            });
            const [unassign, del] = syncBodies(mockApi);
            expect(unassign?.unassignManufacturers).toEqual({
                entity: "product",
                action: "upsert",
                payload: [
                    { id: "p1", manufacturerId: null },
                    { id: "p3", manufacturerId: null },
                    { id: "p4", manufacturerId: null },
                ],
            } as never);
            expect(del?.["delete-product_manufacturer"]?.payload).toEqual([{ id: "m1" }]);
            const orphanChecks = mockApi
                .getCalls()
                .filter((c) => c.endpoint === "search/product")
                .slice(1)
                .map((c) => c.body);
            expect(orphanChecks).toEqual([
                {
                    _filters: [{ type: "equals", field: "manufacturerId", value: "m1" }],
                    _options: { limit: 1 },
                },
                {
                    _filters: [{ type: "equals", field: "manufacturerId", value: "m2" }],
                    _options: { limit: 1 },
                },
            ]);
            expect(mockCache.saveManufacturersMock.mock.calls.at(-1)).toEqual(["test-store", []]);
        });

        test("filters products by SalesChannel visibility", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponse("product", []);

            await ManufacturerProcessor.cleanup!(context);

            expect(mockApi.getCalls()[0]?.body).toEqual({
                _filters: [
                    {
                        type: "equals",
                        field: "visibilities.salesChannelId",
                        value: context.salesChannelId,
                    },
                ],
                _options: {
                    limit: 500,
                    includes: { product: ["id", "manufacturerId"] },
                    associations: undefined,
                },
            });
        });

        test("clears the cache even when nothing is orphaned", async () => {
            const { context, mockApi, mockCache } = createTestContext();
            mockApi.mockSearchResponseSequence("product", [
                [{ id: "p1", manufacturerId: "m1" }],
                [{ id: "p2" }],
            ]);

            await ManufacturerProcessor.cleanup!(context);

            expect(syncBodies(mockApi)).toHaveLength(1);
            expect(mockCache.saveManufacturersMock.mock.calls.at(-1)).toEqual(["test-store", []]);
        });

        test("reports a failure while unassigning", async () => {
            const { context, mockApi, mockCache } = createTestContext();
            mockApi.mockSearchResponse("product", [{ id: "p1", manufacturerId: "m1" }]);
            mockApi.mockSyncFailure(new Error("locked"));

            const result = await ManufacturerProcessor.cleanup!(context);

            expect(result).toEqual({
                name: "manufacturers",
                deleted: 0,
                errors: ["Manufacturer cleanup failed: locked"],
                durationMs: 0,
            });
            expect(mockCache.saveManufacturersMock).not.toHaveBeenCalled();
        });

        test("makes no API calls in dry run mode", async () => {
            const { context, mockApi, mockCache } = createTestContext({ dryRun: true });
            mockApi.mockSearchResponse("product", [{ id: "p1", manufacturerId: "m1" }]);

            await ManufacturerProcessor.cleanup!(context);

            expect(mockApi.getCalls()).toHaveLength(0);
            expect(mockCache.saveManufacturersMock).not.toHaveBeenCalled();
        });

        test("does not touch the cache when there are no products", async () => {
            const { context, mockApi, mockCache } = createTestContext();
            mockApi.mockSearchResponse("product", []);

            await ManufacturerProcessor.cleanup!(context);

            expect(syncBodies(mockApi)).toHaveLength(0);
            expect(mockCache.saveManufacturersMock).not.toHaveBeenCalled();
        });
    });
});
