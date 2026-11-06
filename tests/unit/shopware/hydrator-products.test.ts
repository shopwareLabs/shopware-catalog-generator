/**
 * Unit tests for product payload details in ShopwareHydrator:
 * regulation price, packaging units, custom fields and the custom field set.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ProductSyncPayload } from "../../../src/types/index.js";

import { PRODUCT_CUSTOM_FIELD_SET } from "../../../src/fixtures/index.js";
import { ShopwareHydrator } from "../../../src/shopware/hydrator.js";
import { logger } from "../../../src/utils/index.js";
import { createMockAdminClientWithInvoke } from "../../mocks/index.js";

type SyncOp = { entity: string; action: string; payload: Array<Record<string, unknown>> };

interface MockShop {
    hydrator: ShopwareHydrator;
    syncOps: SyncOp[];
    searches: string[];
}

function createMockShop(
    existing: { units?: Array<{ id: string; shortCode: string }>; customFieldSetId?: string } = {}
): MockShop {
    const syncOps: SyncOp[] = [];
    const searches: string[] = [];
    const client = createMockAdminClientWithInvoke(async (operation, params) => {
        if (operation.includes("_action/sync")) {
            syncOps.push(...((params.body as SyncOp[]) ?? []));
            return {};
        }
        searches.push(operation);
        if (operation.includes("search/unit")) {
            return { data: { data: existing.units ?? [] } };
        }
        if (operation.includes("search/custom-field-set")) {
            const id = existing.customFieldSetId;
            return { data: { data: id ? [{ id }] : [] } };
        }
        if (operation.includes("search/tax")) {
            return { data: { data: [{ id: "tax-1", taxRate: 19 }] } };
        }
        if (operation.includes("search/currency")) {
            return { data: { data: [{ id: "eur-1", isoCode: "EUR", factor: 1 }] } };
        }
        return { data: { data: [] } };
    });
    const hydrator = new ShopwareHydrator(client);
    return { hydrator, syncOps, searches };
}

function baseProduct(overrides: Record<string, unknown> = {}): {
    id: string;
    name: string;
    description: string;
    price: number;
    stock: number;
} {
    return {
        id: "0123456789abcdef0123456789abcdef",
        name: "Test Product",
        description: "A product.",
        price: 80,
        stock: 10,
        ...overrides,
    };
}

function productPayloads(syncOps: SyncOp[]): ProductSyncPayload[] {
    const op = syncOps.find((o) => o.entity === "product");
    return (op?.payload ?? []) as ProductSyncPayload[];
}

beforeEach(() => logger.setMcpMode(true));
afterEach(() => logger.setMcpMode(false));

describe("ShopwareHydrator.hydrateEnvWithProductsDirect - prices", () => {
    test("sale products get a list price and a regulation price between sale and list price", async () => {
        const { hydrator, syncOps } = createMockShop();

        await hydrator.hydrateEnvWithProductsDirect(
            [{ ...baseProduct(), hasSalesPrice: true, salePercentage: 0.2 }],
            "sc-1",
            "nav-1"
        );

        const price = productPayloads(syncOps)[0]?.price[0];
        expect(price?.listPrice?.gross).toBe(100);
        expect(price?.regulationPrice?.gross).toBe(90);
        expect(price?.regulationPrice?.currencyId).toBe(price?.currencyId ?? "missing");
    });

    test("regular products get neither list nor regulation price", async () => {
        const { hydrator, syncOps } = createMockShop();

        await hydrator.hydrateEnvWithProductsDirect([baseProduct()], "sc-1", "nav-1");

        const price = productPayloads(syncOps)[0]?.price[0];
        expect(price?.listPrice).toBeUndefined();
        expect(price?.regulationPrice).toBeUndefined();
    });
});

describe("ShopwareHydrator.hydrateEnvWithProductsDirect - packaging", () => {
    const packaging = {
        unitShortCode: "pc",
        unitName: "Piece",
        purchaseUnit: 6,
        referenceUnit: 1,
        packUnit: "Pack",
        packUnitPlural: "Packs",
    };

    test("creates a missing unit and links it with the packaging fields", async () => {
        const { hydrator, syncOps } = createMockShop();

        await hydrator.hydrateEnvWithProductsDirect([baseProduct({ packaging })], "sc-1", "nav-1");

        const unitOp = syncOps.find((o) => o.entity === "unit");
        expect(unitOp?.payload).toHaveLength(1);
        expect(unitOp?.payload[0]).toMatchObject({ shortCode: "pc", name: "Piece" });

        const product = productPayloads(syncOps)[0];
        expect(product?.unitId).toBe(unitOp?.payload[0]?.id as string);
        expect(product).toMatchObject({
            purchaseUnit: 6,
            referenceUnit: 1,
            packUnit: "Pack",
            packUnitPlural: "Packs",
        });
    });

    test("reuses an existing unit instead of creating a second one", async () => {
        const { hydrator, syncOps } = createMockShop({
            units: [{ id: "unit-existing", shortCode: "pc" }],
        });

        await hydrator.hydrateEnvWithProductsDirect(
            [
                baseProduct({ packaging }),
                baseProduct({ id: "fedcba9876543210fedcba9876543210", packaging }),
            ],
            "sc-1",
            "nav-1"
        );

        expect(syncOps.some((o) => o.entity === "unit")).toBe(false);
        expect(productPayloads(syncOps).map((p) => p.unitId)).toEqual([
            "unit-existing",
            "unit-existing",
        ]);
    });

    test("does not look up units when no product has packaging", async () => {
        const { hydrator, searches, syncOps } = createMockShop();

        await hydrator.hydrateEnvWithProductsDirect([baseProduct()], "sc-1", "nav-1");

        expect(searches.some((s) => s.includes("search/unit"))).toBe(false);
        expect(productPayloads(syncOps)[0]?.unitId).toBeUndefined();
    });
});

describe("ShopwareHydrator.hydrateEnvWithProductsDirect - optional text fields", () => {
    test("passes custom fields and Open Graph fields through", async () => {
        const { hydrator, syncOps } = createMockShop();
        const customFields = { cg_featured: true, cg_launch_year: 2024, cg_internal_note: "x" };

        await hydrator.hydrateEnvWithProductsDirect(
            [
                baseProduct({
                    customFields,
                    ogTitle: "OG title",
                    ogDescription: "OG description",
                }),
            ],
            "sc-1",
            "nav-1"
        );

        expect(productPayloads(syncOps)[0]).toMatchObject({
            customFields,
            ogTitle: "OG title",
            ogDescription: "OG description",
        });
    });

    test("leaves the fields out when the caller does not send them", async () => {
        const { hydrator, syncOps } = createMockShop();

        await hydrator.hydrateEnvWithProductsDirect([baseProduct()], "sc-1", "nav-1");

        const product = productPayloads(syncOps)[0] ?? {};
        expect(Object.keys(product)).not.toContain("customFields");
        expect(Object.keys(product)).not.toContain("ogTitle");
    });
});

describe("ShopwareHydrator.ensureProductCustomFieldSet", () => {
    test("creates the set with a product relation and all fixture fields", async () => {
        const { hydrator, syncOps } = createMockShop();

        await hydrator.ensureProductCustomFieldSet(true);

        const set = syncOps.find((o) => o.entity === "custom_field_set")?.payload[0];
        expect(set?.name).toBe(PRODUCT_CUSTOM_FIELD_SET.name);
        expect(set?.relations).toEqual([expect.objectContaining({ entityName: "product" })]);
        const fields = set?.customFields as Array<Record<string, unknown>>;
        expect(fields.map((f) => f.name)).toEqual(
            PRODUCT_CUSTOM_FIELD_SET.fields.map((f) => f.name)
        );
        expect(fields.find((f) => f.name === "cg_internal_note")?.includeInSearch).toBe(true);
    });

    test("leaves includeInSearch out for shops older than 6.7.7", async () => {
        const { hydrator, syncOps } = createMockShop();

        await hydrator.ensureProductCustomFieldSet(false);

        const set = syncOps.find((o) => o.entity === "custom_field_set")?.payload[0];
        const fields = set?.customFields as Array<Record<string, unknown>>;
        expect(fields.every((f) => !("includeInSearch" in f))).toBe(true);
    });

    test("returns the existing set without creating a new one", async () => {
        const { hydrator, syncOps } = createMockShop({ customFieldSetId: "set-existing" });

        const id = await hydrator.ensureProductCustomFieldSet(true);

        expect(id).toBe("set-existing");
        expect(syncOps).toHaveLength(0);
    });
});
