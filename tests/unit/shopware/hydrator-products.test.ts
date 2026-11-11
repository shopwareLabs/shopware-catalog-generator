/**
 * Unit tests for product payload details in ShopwareHydrator:
 * regulation price, packaging units, custom fields and the custom field set.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PricePayload, ProductSyncPayload } from "../../../src/types/index.js";

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

interface ExistingShopData {
    units?: Array<{ id: string; shortCode: string }>;
    customFieldSetId?: string;
    rules?: Array<{ id: string; name: string }>;
    deliveryTimes?: Array<{ id: string }>;
}

function createMockShop(existing: ExistingShopData = {}): MockShop {
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
        if (operation.includes("search/rule")) {
            return { data: { data: existing.rules ?? [] } };
        }
        if (operation.includes("search/delivery-time")) {
            return { data: { data: existing.deliveryTimes ?? [] } };
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

describe("ShopwareHydrator.hydrateEnvWithProductsDirect - removed options", () => {
    test("unlinks removed options after the upsert", async () => {
        const { hydrator, syncOps } = createMockShop();
        const product = baseProduct();

        await hydrator.hydrateEnvWithProductsDirect(
            [{ ...product, removedOptionIds: ["opt-navy"] }],
            "sc-1",
            "nav-1"
        );

        const unlink = syncOps.find((o) => o.entity === "product_property");
        expect(unlink?.action).toBe("delete");
        expect(unlink?.payload).toEqual([{ productId: product.id, optionId: "opt-navy" }]);
        expect(syncOps.indexOf(unlink as SyncOp)).toBeGreaterThan(
            syncOps.findIndex((o) => o.entity === "product")
        );
    });

    test("sends no delete when nothing was removed", async () => {
        const { hydrator, syncOps } = createMockShop();

        await hydrator.hydrateEnvWithProductsDirect([baseProduct()], "sc-1", "nav-1");

        expect(syncOps.some((o) => o.entity === "product_property")).toBe(false);
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

    test("clears the pack fields without a unit lookup when no product has packaging", async () => {
        const { hydrator, searches, syncOps } = createMockShop();

        await hydrator.hydrateEnvWithProductsDirect([baseProduct()], "sc-1", "nav-1");

        expect(searches.some((s) => s.includes("search/unit"))).toBe(false);
        expect(productPayloads(syncOps)[0]).toMatchObject({
            unitId: null,
            purchaseUnit: null,
            referenceUnit: null,
            packUnit: null,
            packUnitPlural: null,
        });
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

describe("ShopwareHydrator.hydrateEnvWithProductsDirect - full payload", () => {
    const shop = (): MockShop =>
        createMockShop({
            rules: [{ id: "rule-1", name: "Always valid (Default)" }],
            deliveryTimes: [{ id: "dt-1" }, { id: "dt-2" }],
        });

    test("builds every field of a product with all options set", async () => {
        const { hydrator, syncOps } = shop();
        const id = "0123456789abcdef0123456789abcdef";

        await hydrator.hydrateEnvWithProductsDirect(
            [
                baseProduct({
                    categoryIds: ["nav-1", "cat-1", "cat-2"],
                    options: [{ id: "opt-1", name: "Red" }],
                    hasTieredPricing: true,
                    isTopseller: true,
                    isShippingFree: true,
                    weight: 2,
                    ean: "4006381333931",
                    manufacturerNumber: "MPN-1",
                    minPurchase: 2,
                    maxPurchase: 20,
                    metaTitle: "Meta title",
                    metaDescription: "Meta description",
                    deliveryTimeIndex: 3,
                    type: "physical",
                }),
            ],
            "sc-1",
            "nav-1"
        );

        const [product] = productPayloads(syncOps);
        const price = (gross: number): PricePayload => ({
            currencyId: "eur-1",
            gross,
            net: gross,
            linked: true,
        });
        expect(product).toEqual({
            id,
            productNumber: `AI-${id}`,
            name: "Test Product",
            description: "A product.",
            stock: 10,
            taxId: "tax-1",
            price: [price(80)],
            visibilities: [
                {
                    id: expect.stringMatching(/^[0-9a-f]{32}$/),
                    productId: id,
                    salesChannelId: "sc-1",
                    visibility: 30,
                },
            ],
            categories: [{ id: "nav-1" }, { id: "cat-1" }, { id: "cat-2" }],
            markAsTopseller: true,
            shippingFree: true,
            weight: 2,
            width: undefined,
            height: undefined,
            length: undefined,
            ean: "4006381333931",
            manufacturerNumber: "MPN-1",
            type: "physical",
            deliveryTimeId: "dt-2",
            minPurchase: 2,
            purchaseSteps: 2,
            maxPurchase: 20,
            metaTitle: "Meta title",
            metaDescription: "Meta description",
            properties: [{ id: "opt-1" }],
            unitId: null,
            purchaseUnit: null,
            referenceUnit: null,
            packUnit: null,
            packUnitPlural: null,
            prices: [
                {
                    id: `${id.slice(0, -1)}0`,
                    ruleId: "rule-1",
                    quantityStart: 1,
                    quantityEnd: 9,
                    price: [price(80)],
                },
                {
                    id: `${id.slice(0, -1)}1`,
                    ruleId: "rule-1",
                    quantityStart: 10,
                    quantityEnd: 49,
                    price: [price(72)],
                },
                {
                    id: `${id.slice(0, -1)}2`,
                    ruleId: "rule-1",
                    quantityStart: 50,
                    price: [price(64)],
                },
            ],
        });
    });

    test("the visibility ID differs per SalesChannel", async () => {
        const first = shop();
        const second = shop();
        await first.hydrator.hydrateEnvWithProductsDirect([baseProduct()], "sc-1", "nav-1");
        await second.hydrator.hydrateEnvWithProductsDirect([baseProduct()], "sc-2", "nav-1");

        const [a] = productPayloads(first.syncOps);
        const [b] = productPayloads(second.syncOps);
        expect(a?.visibilities?.[0]?.id).not.toBe(b?.visibilities?.[0]?.id);
    });

    test("a sale needs both the flag and a percentage", async () => {
        const { hydrator, syncOps } = shop();
        await hydrator.hydrateEnvWithProductsDirect(
            [
                baseProduct({ id: "0123456789abcdef0123456789abcde1", hasSalesPrice: true }),
                baseProduct({ id: "0123456789abcdef0123456789abcde2", salePercentage: 0.2 }),
            ],
            "sc-1",
            "nav-1"
        );

        for (const product of productPayloads(syncOps)) {
            expect(product.price[0]).not.toHaveProperty("listPrice");
        }
    });

    test("the visibility ID is stable per product and SalesChannel", async () => {
        const first = shop();
        const second = shop();
        await first.hydrator.hydrateEnvWithProductsDirect([baseProduct()], "sc-1", "nav-1");
        await second.hydrator.hydrateEnvWithProductsDirect([baseProduct()], "sc-1", "nav-1");

        const [a] = productPayloads(first.syncOps);
        const [b] = productPayloads(second.syncOps);
        expect(a?.visibilities?.[0]?.id).toBe(b?.visibilities?.[0]?.id);
    });

    test("leaves optional fields out of a minimal product", async () => {
        const { hydrator, syncOps } = shop();
        await hydrator.hydrateEnvWithProductsDirect([baseProduct()], "sc-1", "nav-1");

        const [product] = productPayloads(syncOps);
        expect(product?.categories).toEqual([{ id: "nav-1" }]);
        expect(product?.markAsTopseller).toBe(false);
        expect(product?.shippingFree).toBe(false);
        for (const key of [
            "prices",
            "properties",
            "deliveryTimeId",
            "minPurchase",
            "purchaseSteps",
            "maxPurchase",
            "metaTitle",
            "metaDescription",
            "releaseDate",
            "type",
        ]) {
            expect(product).not.toHaveProperty(key);
        }
        expect(product?.unitId).toBeNull();
    });

    test("an explicit purchase step wins over the minimum purchase", async () => {
        const { hydrator, syncOps } = shop();
        await hydrator.hydrateEnvWithProductsDirect(
            [baseProduct({ minPurchase: 6, purchaseSteps: 3 })],
            "sc-1",
            "nav-1"
        );

        const [product] = productPayloads(syncOps);
        expect(product).toMatchObject({ minPurchase: 6, purchaseSteps: 3 });
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
