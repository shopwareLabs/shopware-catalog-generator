import { describe, expect, test } from "bun:test";

import type { AdminApiClient } from "../../../src/shopware/admin-client.js";
import type { CategoryNode, ProductSyncPayload } from "../../../src/types/index.js";

import { ShopwareHydrator } from "../../../src/shopware/hydrator.js";
import { createMockAdminClientWithInvoke } from "../../mocks/index.js";

describe("ShopwareHydrator createCategoryTree", () => {
    test("includes afterCategoryId in category payloads", async () => {
        let capturedSyncBody: Array<{ entity: string; action: string; payload: unknown[] }> = [];

        const mockClient = createMockAdminClientWithInvoke(
            async (operation: string, params: { body?: unknown }) => {
                if (operation.includes("search/category")) {
                    return { data: { data: [], total: 0 } };
                }
                if (operation.includes("_action/sync")) {
                    capturedSyncBody =
                        (params.body as Array<{
                            entity: string;
                            action: string;
                            payload: unknown[];
                        }>) ?? [];
                }
                return {};
            }
        );

        const hydrator = new ShopwareHydrator(mockClient);

        const tree: CategoryNode[] = [
            {
                id: "cat-1",
                name: "First",
                description: "First category",
                productCount: 0,
                hasImage: false,
                children: [
                    {
                        id: "cat-2",
                        name: "Child A",
                        description: "Child A",
                        productCount: 0,
                        hasImage: false,
                        children: [],
                    },
                    {
                        id: "cat-3",
                        name: "Child B",
                        description: "Child B",
                        productCount: 0,
                        hasImage: false,
                        children: [],
                    },
                ],
            },
            {
                id: "cat-4",
                name: "Second",
                description: "Second category",
                productCount: 0,
                hasImage: false,
                children: [],
            },
        ];

        await hydrator.createCategoryTree(tree, "root-id", "sc-id");

        const categorySync = capturedSyncBody.find((op) => op.entity === "category");
        expect(categorySync).toBeDefined();
        expect(categorySync?.action).toBe("upsert");

        const payload = categorySync?.payload as Array<{
            id: string;
            name: string;
            afterCategoryId: string | null;
            parentId: string;
        }>;
        expect(payload.length).toBeGreaterThan(0);
    });

    test("first sibling gets afterCategoryId null", async () => {
        let capturedPayload: Array<Record<string, unknown>> = [];

        const mockClient = createMockAdminClientWithInvoke(
            async (operation: string, params: { body?: unknown }) => {
                if (operation.includes("search/category")) {
                    return { data: { data: [], total: 0 } };
                }
                if (operation.includes("_action/sync")) {
                    const ops = params.body as Array<{ entity: string; payload: unknown[] }>;
                    const categoryOp = ops?.find((o) => o.entity === "category");
                    if (categoryOp?.payload) {
                        capturedPayload = categoryOp.payload as Array<Record<string, unknown>>;
                    }
                }
                return {};
            }
        );

        const hydrator = new ShopwareHydrator(mockClient);

        const tree: CategoryNode[] = [
            {
                id: "cat-1",
                name: "Only",
                description: "Only child",
                productCount: 0,
                hasImage: false,
                children: [],
            },
        ];

        await hydrator.createCategoryTree(tree, "root-id", "sc-id");

        const firstCategory = capturedPayload[0];
        expect(firstCategory).toBeDefined();
        expect(firstCategory?.afterCategoryId).toBe(null);
    });

    test("subsequent siblings chain to the previous one", async () => {
        let capturedPayload: Array<Record<string, unknown>> = [];

        const mockClient = createMockAdminClientWithInvoke(
            async (operation: string, params: { body?: unknown }) => {
                if (operation.includes("search/category")) {
                    return { data: { data: [], total: 0 } };
                }
                if (operation.includes("_action/sync")) {
                    const ops = params.body as Array<{ entity: string; payload: unknown[] }>;
                    const categoryOp = ops?.find((o) => o.entity === "category");
                    if (categoryOp?.payload) {
                        capturedPayload = categoryOp.payload as Array<Record<string, unknown>>;
                    }
                }
                return {};
            }
        );

        const hydrator = new ShopwareHydrator(mockClient);

        const tree: CategoryNode[] = [
            {
                id: "cat-a",
                name: "First",
                description: "First",
                productCount: 0,
                hasImage: false,
                children: [],
            },
            {
                id: "cat-b",
                name: "Second",
                description: "Second",
                productCount: 0,
                hasImage: false,
                children: [],
            },
            {
                id: "cat-c",
                name: "Third",
                description: "Third",
                productCount: 0,
                hasImage: false,
                children: [],
            },
        ];

        await hydrator.createCategoryTree(tree, "root-id", "sc-id");

        expect(capturedPayload.length).toBe(3);

        const first = capturedPayload[0] as { id: string; afterCategoryId: string | null };
        const second = capturedPayload[1] as { id: string; afterCategoryId: string | null };
        const third = capturedPayload[2] as { id: string; afterCategoryId: string | null };

        expect(first.afterCategoryId).toBe(null);
        expect(second.afterCategoryId).toBe(first.id);
        expect(third.afterCategoryId).toBe(second.id);
    });
});

// =============================================================================
// hydrateEnvWithProductsDirect — tiered pricing and idempotency
// =============================================================================

/**
 * Build a minimal AdminApiClient mock that captures the product sync payload.
 *
 * The mock:
 * - Returns a standard tax ID for `search/tax`
 * - Returns a USD currency ID for `search/currency`
 * - Returns an empty delivery time list for `search/delivery-time`
 * - Optionally returns an "Always valid" rule for `search/rule`
 * - Captures every `_action/sync` call so tests can inspect the payloads
 */
function buildProductMockClient(opts: {
    hasAlwaysValidRule: boolean;
    capturedSyncs: Array<{ entity: string; action: string; payload: ProductSyncPayload[] }>;
}): AdminApiClient {
    return createMockAdminClientWithInvoke(
        async (operation: string, params: { body?: unknown }) => {
            if (operation.includes("search/tax")) {
                return { data: { data: [{ id: "tax-standard" }], total: 1 } };
            }
            if (operation.includes("search/currency")) {
                return { data: { data: [{ id: "currency-usd", isoCode: "USD" }], total: 1 } };
            }
            if (operation.includes("search/delivery-time")) {
                return {
                    data: {
                        data: [
                            { id: "dt-1", name: "1-3 days" },
                            { id: "dt-2", name: "3-5 days" },
                        ],
                        total: 2,
                    },
                };
            }
            if (operation.includes("search/rule")) {
                const ruleData = opts.hasAlwaysValidRule
                    ? [{ id: "rule-always-valid", name: "Always valid" }]
                    : [];
                return { data: { data: ruleData, total: ruleData.length } };
            }
            if (operation.includes("_action/sync")) {
                const ops = params.body as Array<{
                    entity: string;
                    action: string;
                    payload: ProductSyncPayload[];
                }>;
                opts.capturedSyncs.push(...(ops ?? []));
            }
            return {};
        }
    );
}

/** Minimal product fixture with `hasTieredPricing` */
function makeProduct(
    id: string,
    opts: {
        hasTieredPricing?: boolean;
        isNew?: boolean;
        deliveryTimeIndex?: number;
    } = {}
) {
    return {
        id,
        name: `Product ${id}`,
        description: "Test product",
        price: 49.99,
        stock: 600,
        ean: "1234567890128",
        manufacturerNumber: "MPN-TEST",
        hasTieredPricing: opts.hasTieredPricing ?? false,
        isNew: opts.isNew ?? false,
        deliveryTimeIndex: opts.deliveryTimeIndex,
        isTopseller: false,
        isShippingFree: false,
        weight: 1.0,
        width: 100,
        height: 100,
        length: 100,
    };
}

describe("ShopwareHydrator hydrateEnvWithProductsDirect — tiered pricing", () => {
    test("attaches tiered prices when alwaysValidRule is present", async () => {
        const syncs: Array<{ entity: string; action: string; payload: ProductSyncPayload[] }> = [];
        const client = buildProductMockClient({ hasAlwaysValidRule: true, capturedSyncs: syncs });
        const hydrator = new ShopwareHydrator(client);

        await hydrator.hydrateEnvWithProductsDirect(
            [makeProduct("prod-1", { hasTieredPricing: true })],
            "sc-id",
            "nav-id"
        );

        const productSync = syncs.find((s) => s.entity === "product");
        expect(productSync).toBeDefined();

        const product = productSync!.payload[0]!;
        // Tiered prices array should be populated
        expect(Array.isArray(product.prices)).toBe(true);
        expect((product.prices as unknown[]).length).toBe(3);
    });

    test("skips tiered prices when no alwaysValidRule is found (null fallback)", async () => {
        const syncs: Array<{ entity: string; action: string; payload: ProductSyncPayload[] }> = [];
        const client = buildProductMockClient({ hasAlwaysValidRule: false, capturedSyncs: syncs });
        const hydrator = new ShopwareHydrator(client);

        await hydrator.hydrateEnvWithProductsDirect(
            [makeProduct("prod-1", { hasTieredPricing: true })],
            "sc-id",
            "nav-id"
        );

        const productSync = syncs.find((s) => s.entity === "product");
        expect(productSync).toBeDefined();

        const product = productSync!.payload[0]!;
        // No tiered prices when rule is unavailable
        expect(product.prices).toBeUndefined();
    });
});

describe("ShopwareHydrator hydrateEnvWithProductsDirect — idempotency", () => {
    test("sets releaseDate to current upload time for isNew products (always fresh)", async () => {
        const syncs: Array<{ entity: string; action: string; payload: ProductSyncPayload[] }> = [];
        const client = buildProductMockClient({ hasAlwaysValidRule: false, capturedSyncs: syncs });
        const hydrator = new ShopwareHydrator(client);

        const before = Date.now();
        await hydrator.hydrateEnvWithProductsDirect(
            [makeProduct("prod-1", { isNew: true })],
            "sc-id",
            "nav-id"
        );
        const after = Date.now();

        const product = syncs.find((s) => s.entity === "product")!.payload[0]!;
        expect(product.releaseDate).toBeDefined();
        const ts = new Date(product.releaseDate as string).getTime();
        // Must be set at upload time — always within the "new" window
        expect(ts).toBeGreaterThanOrEqual(before);
        expect(ts).toBeLessThanOrEqual(after);
    });

    test("omits releaseDate for non-new products", async () => {
        const syncs: Array<{ entity: string; action: string; payload: ProductSyncPayload[] }> = [];
        const client = buildProductMockClient({ hasAlwaysValidRule: false, capturedSyncs: syncs });
        const hydrator = new ShopwareHydrator(client);

        await hydrator.hydrateEnvWithProductsDirect(
            [makeProduct("prod-1", { isNew: false })],
            "sc-id",
            "nav-id"
        );

        const product = syncs.find((s) => s.entity === "product")!.payload[0]!;
        expect(product.releaseDate).toBeUndefined();
    });

    test("uses deterministic deliveryTimeId via deliveryTimeIndex from blueprint", async () => {
        const syncs: Array<{ entity: string; action: string; payload: ProductSyncPayload[] }> = [];
        const client = buildProductMockClient({ hasAlwaysValidRule: false, capturedSyncs: syncs });
        const hydrator = new ShopwareHydrator(client);

        // deliveryTimeIndex 0 → first delivery time id ("dt-1")
        // deliveryTimeIndex 1 → second delivery time id ("dt-2")
        await hydrator.hydrateEnvWithProductsDirect(
            [
                makeProduct("prod-a", { deliveryTimeIndex: 0 }),
                makeProduct("prod-b", { deliveryTimeIndex: 1 }),
                makeProduct("prod-c", { deliveryTimeIndex: 2 }), // wraps to dt-1 (2 % 2 === 0)
            ],
            "sc-id",
            "nav-id"
        );

        const payload = syncs.find((s) => s.entity === "product")!.payload;
        expect(payload[0]!.deliveryTimeId).toBe("dt-1");
        expect(payload[1]!.deliveryTimeId).toBe("dt-2");
        expect(payload[2]!.deliveryTimeId).toBe("dt-1"); // wraps around
    });
});
