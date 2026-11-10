/**
 * Characterization tests for ShopwareHydrator SalesChannel lookup/creation and
 * property group verification.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PropertyGroup } from "../../../src/types/index.js";

import { ShopwareHydrator } from "../../../src/shopware/hydrator.js";
import { logger } from "../../../src/utils/index.js";
import { createMockAdminClientWithInvoke } from "../../mocks/index.js";

interface InvokeCall {
    operation: string;
    params: { body?: unknown; pathParams?: unknown };
}

type Route = (call: InvokeCall) => unknown;

/** Hydrator whose client answers via `route` and records every call */
function hydratorWith(route: Route): { hydrator: ShopwareHydrator; calls: InvokeCall[] } {
    const calls: InvokeCall[] = [];
    const client = createMockAdminClientWithInvoke(async (operation, params) => {
        const call = { operation, params };
        calls.push(call);
        return { data: route(call) ?? { data: [], total: 0 } };
    });
    return { hydrator: new ShopwareHydrator(client), calls };
}

function bodyOf(call: InvokeCall | undefined): string {
    return JSON.stringify(call?.params.body ?? null);
}

beforeEach(() => logger.setMcpMode(true));
afterEach(() => logger.setMcpMode(false));

// =============================================================================
// verifyPropertyGroupsExist
// =============================================================================

describe("ShopwareHydrator.verifyPropertyGroupsExist", () => {
    const GROUPS: PropertyGroup[] = [
        {
            id: "g1",
            name: "Color",
            description: "",
            displayType: "color",
            options: [
                { id: "o1", name: "Red" },
                { id: "o2", name: "Blue" },
            ],
        },
        {
            id: "g2",
            name: "Size",
            description: "",
            displayType: "text",
            options: [{ id: "o3", name: "S" }],
        },
    ];

    function totals(groups: number | undefined, options: number | undefined): Route {
        return ({ operation }) => {
            if (operation.includes("property-group-option")) return { total: options };
            if (operation.includes("property-group")) return { total: groups };
            return undefined;
        };
    }

    test("returns false without a client", async () => {
        expect(await new ShopwareHydrator().verifyPropertyGroupsExist(GROUPS)).toBe(false);
    });

    test("returns false when no group or option has an ID", async () => {
        const { hydrator, calls } = hydratorWith(totals(0, 0));
        const groups: PropertyGroup[] = [
            {
                id: "",
                name: "X",
                description: "",
                displayType: "text",
                options: [{ id: "", name: "a" }],
            },
        ];
        expect(await hydrator.verifyPropertyGroupsExist(groups)).toBe(false);
        expect(await hydrator.verifyPropertyGroupsExist([])).toBe(false);
        expect(calls).toHaveLength(0);
    });

    test("returns true when every group and option exists", async () => {
        const { hydrator, calls } = hydratorWith(totals(2, 3));

        expect(await hydrator.verifyPropertyGroupsExist(GROUPS)).toBe(true);
        expect(calls.map((c) => c.operation)).toEqual([
            "searchPropertyGroup post /search/property-group",
            "searchPropertyGroupOption post /search/property-group-option",
        ]);
        expect(calls[0]?.params.body).toEqual({
            limit: 2,
            filter: [{ type: "equalsAny", field: "id", value: "g1|g2" }],
        });
        expect(calls[1]?.params.body).toEqual({
            limit: 3,
            filter: [{ type: "equalsAny", field: "id", value: "o1|o2|o3" }],
        });
    });

    test("returns false without checking options when a group is missing", async () => {
        const { hydrator, calls } = hydratorWith(totals(1, 3));
        expect(await hydrator.verifyPropertyGroupsExist(GROUPS)).toBe(false);
        expect(calls).toHaveLength(1);
    });

    test("returns false when an option is missing", async () => {
        const { hydrator } = hydratorWith(totals(2, 2));
        expect(await hydrator.verifyPropertyGroupsExist(GROUPS)).toBe(false);
    });

    test("treats a missing total as nothing found", async () => {
        const { hydrator } = hydratorWith(totals(undefined, 3));
        expect(await hydrator.verifyPropertyGroupsExist(GROUPS)).toBe(false);

        const optionsOnly = hydratorWith(totals(2, undefined));
        expect(await optionsOnly.hydrator.verifyPropertyGroupsExist(GROUPS)).toBe(false);
    });

    test("checks only options when no group has an ID", async () => {
        const { hydrator, calls } = hydratorWith(totals(0, 1));
        const groups: PropertyGroup[] = [
            {
                id: "",
                name: "X",
                description: "",
                displayType: "text",
                options: [{ id: "o9", name: "a" }],
            },
        ];
        expect(await hydrator.verifyPropertyGroupsExist(groups)).toBe(true);
        expect(calls.map((c) => c.operation)).toEqual([
            "searchPropertyGroupOption post /search/property-group-option",
        ]);
    });

    test("checks only groups when no option has an ID", async () => {
        const { hydrator, calls } = hydratorWith(totals(1, 0));
        const groups: PropertyGroup[] = [
            { id: "g9", name: "X", description: "", displayType: "text", options: [] },
        ];
        expect(await hydrator.verifyPropertyGroupsExist(groups)).toBe(true);
        expect(calls).toHaveLength(1);
    });

    test("returns false when the search fails", async () => {
        const { hydrator } = hydratorWith(() => {
            throw new Error("boom");
        });
        expect(await hydrator.verifyPropertyGroupsExist(GROUPS)).toBe(false);
    });
});

// =============================================================================
// findSalesChannelByName
// =============================================================================

const BEAUTY_CHANNEL = {
    id: "sc-beauty",
    name: "Beauty",
    typeId: "type-id",
    languageId: "lang-id",
    currencyId: "cur-id",
    paymentMethodId: "pay-id",
    shippingMethodId: "ship-id",
    countryId: "country-id",
    customerGroupId: "cg-id",
    navigationCategoryId: "nav-id",
    domains: [{ snippetSetId: "snippet-id" }],
};

describe("ShopwareHydrator.findSalesChannelByName", () => {
    test("searches by the capitalized name and returns null when nothing matches", async () => {
        const { hydrator, calls } = hydratorWith(() => undefined);

        expect(await hydrator.findSalesChannelByName("beauty")).toBeNull();
        expect(calls).toHaveLength(1);
        expect(calls[0]?.operation).toBe("searchSalesChannel post /search/sales-channel");
        expect(calls[0]?.params.body).toEqual({
            limit: 1,
            filter: [{ type: "equals", field: "name", value: "Beauty" }],
        });
    });

    test("returns the full details including the snippet set", async () => {
        const { hydrator, calls } = hydratorWith(() => ({ data: [BEAUTY_CHANNEL], total: 1 }));

        const result = await hydrator.findSalesChannelByName("beauty");

        expect(result).toEqual({
            id: "sc-beauty",
            name: "Beauty",
            typeId: "type-id",
            languageId: "lang-id",
            currencyId: "cur-id",
            paymentMethodId: "pay-id",
            shippingMethodId: "ship-id",
            countryId: "country-id",
            customerGroupId: "cg-id",
            navigationCategoryId: "nav-id",
            snippetSetId: "snippet-id",
        });
        expect(bodyOf(calls[1])).toContain('"domains"');
    });

    test("falls back to the search result when the full details fail", async () => {
        const { hydrator } = hydratorWith((call) => {
            if (bodyOf(call).includes('"domains"')) throw new Error("details failed");
            return { data: [BEAUTY_CHANNEL], total: 1 };
        });

        const result = await hydrator.findSalesChannelByName("beauty");

        expect(result).toMatchObject({
            id: "sc-beauty",
            name: "Beauty",
            typeId: "type-id",
            languageId: "lang-id",
            currencyId: "cur-id",
            paymentMethodId: "pay-id",
            shippingMethodId: "ship-id",
            countryId: "country-id",
            customerGroupId: "cg-id",
            navigationCategoryId: "nav-id",
        });
        expect(result?.snippetSetId).toBeUndefined();
    });

    test("fallback fills missing fields with empty strings and the searched name", async () => {
        const { hydrator } = hydratorWith((call) => {
            if (bodyOf(call).includes('"domains"')) throw new Error("details failed");
            return { data: [{ id: "sc-x" }], total: 1 };
        });

        const result = await hydrator.findSalesChannelByName("beauty");

        expect(result).toMatchObject({
            id: "sc-x",
            name: "Beauty",
            typeId: "",
            languageId: "",
            currencyId: "",
            paymentMethodId: "",
            shippingMethodId: "",
            countryId: "",
            customerGroupId: "",
            navigationCategoryId: "",
        });
    });
});

// =============================================================================
// createSalesChannel
// =============================================================================

const STOREFRONT = {
    id: "storefront-id",
    name: "Storefront",
    typeId: "8a243080f92e4c719546314b577cf82b",
    languageId: "en-lang-id",
    currencyId: "eur-fallback-id",
    paymentMethodId: "pay-id",
    shippingMethodId: "ship-id",
    countryId: "country-id",
    customerGroupId: "cg-id",
    navigationCategoryId: "nav-id",
    domains: [{ snippetSetId: "en-snippet-id" }],
};

interface ShopOptions {
    existingRootId?: string;
    childCategories?: string[];
    themes?: Array<{ id: string; salesChannels: Array<{ id: string }> }>;
    germanInstalled?: boolean;
}

function shopRoute(options: ShopOptions = {}): Route {
    const {
        existingRootId,
        childCategories = [],
        themes = [{ id: "theme-id", salesChannels: [{ id: "storefront-id" }] }],
        germanInstalled = false,
    } = options;

    return (call) => {
        const { operation } = call;
        const body = bodyOf(call);
        if (operation.includes("search/sales-channel")) {
            if (body.includes('"Beauty"')) return { data: [], total: 0 };
            return { data: [STOREFRONT], total: 1 };
        }
        if (operation.includes("search/currency")) {
            if (body.includes('"USD"')) return { data: [{ id: "usd-id" }], total: 1 };
            return { data: [{ id: "eur-id" }], total: 1 };
        }
        if (operation.includes("search/language") || operation.includes("search/snippet-set")) {
            return germanInstalled ? { data: [{ id: "de-id" }], total: 1 } : undefined;
        }
        if (operation.includes("search/category")) {
            if (body.includes("Demo-Store") && existingRootId) {
                return { data: [{ id: existingRootId }], total: 1 };
            }
            if (body.includes(`"${existingRootId}"`)) {
                return { data: childCategories.map((id) => ({ id })), total: 1 };
            }
            return undefined;
        }
        if (operation.includes("search/theme")) return { data: themes, total: themes.length };
        return undefined;
    };
}

interface SyncOp {
    entity: string;
    action: string;
    payload: Array<Record<string, unknown>>;
}

function syncOps(calls: InvokeCall[]): SyncOp[] {
    return calls
        .filter((c) => c.operation.includes("_action/sync"))
        .flatMap((c) => JSON.parse(bodyOf(c)) as SyncOp[]);
}

function salesChannelPayload(calls: InvokeCall[]): Record<string, unknown> | undefined {
    return syncOps(calls).find((op) => op.entity === "sales_channel")?.payload[0];
}

describe("ShopwareHydrator.createSalesChannel - characterization", () => {
    test("throws without a client", async () => {
        await expect(
            new ShopwareHydrator().createSalesChannel({ name: "beauty", description: "" })
        ).rejects.toThrow("Client is not authenticated");
    });

    test("throws for a name without valid subdomain characters", async () => {
        const { hydrator, calls } = hydratorWith(shopRoute());
        await expect(hydrator.createSalesChannel({ name: "!!!", description: "" })).rejects.toThrow(
            "Invalid SalesChannel name: Name contains no valid characters for a subdomain"
        );
        expect(calls).toHaveLength(0);
    });

    test("sanitizes the name before searching for an existing channel", async () => {
        const { hydrator, calls } = hydratorWith(shopRoute());
        await hydrator.createSalesChannel({ name: "Beauty!", description: "" });
        expect(calls[0]?.params.body).toEqual({
            limit: 1,
            filter: [{ type: "equals", field: "name", value: "Beauty" }],
        });
    });

    test("creates a root category and a SalesChannel cloned from the Storefront", async () => {
        const { hydrator, calls } = hydratorWith(shopRoute());
        hydrator.envPath = "https://shop.example.com";

        const result = await hydrator.createSalesChannel({ name: "beauty", description: "" });

        const rootOp = syncOps(calls).find((op) => op.entity === "category");
        const rootId = rootOp?.payload[0]?.id as string;
        expect(rootOp?.payload[0]).toMatchObject({ name: "Beauty Demo-Store", visible: false });

        const payload = salesChannelPayload(calls);
        expect(payload).toEqual({
            id: result.id,
            name: "Beauty",
            typeId: STOREFRONT.typeId,
            languageId: "en-lang-id",
            currencyId: "usd-id",
            paymentMethodId: "pay-id",
            shippingMethodId: "ship-id",
            countryId: "country-id",
            customerGroupId: "cg-id",
            navigationCategoryId: rootId,
            accessKey: result.accessKey,
            active: true,
            languages: [{ id: "en-lang-id" }],
            currencies: [{ id: "usd-id" }],
            paymentMethods: [{ id: "pay-id" }],
            shippingMethods: [{ id: "ship-id" }],
            countries: [{ id: "country-id" }],
            domains: [
                {
                    id: expect.any(String),
                    url: "http://beauty.shop.example.com",
                    languageId: "en-lang-id",
                    currencyId: "usd-id",
                    snippetSetId: "en-snippet-id",
                },
            ],
        });

        expect(result).toEqual({
            id: expect.any(String),
            name: "Beauty",
            typeId: STOREFRONT.typeId,
            languageId: "en-lang-id",
            currencyId: "usd-id",
            paymentMethodId: "pay-id",
            shippingMethodId: "ship-id",
            countryId: "country-id",
            customerGroupId: "cg-id",
            navigationCategoryId: rootId,
            accessKey: expect.any(String),
            snippetSetId: "en-snippet-id",
            isNew: true,
        });
    });

    test("uses localhost:8000 without an env URL and honours a custom base URL", async () => {
        const plain = hydratorWith(shopRoute({ germanInstalled: true }));
        await plain.hydrator.createSalesChannel({ name: "beauty", description: "" });
        const plainDomains = salesChannelPayload(plain.calls)?.domains as Array<{ url: string }>;
        expect(plainDomains.map((d) => d.url)).toEqual([
            "http://beauty.localhost:8000",
            "http://beauty-de.localhost:8000",
        ]);

        const custom = hydratorWith(shopRoute({ germanInstalled: true }));
        custom.hydrator.envPath = "http://shop.test";
        await custom.hydrator.createSalesChannel({
            name: "beauty",
            description: "",
            baseUrl: "https://custom.example",
        });
        const customDomains = salesChannelPayload(custom.calls)?.domains as Array<{ url: string }>;
        expect(customDomains.map((d) => d.url)).toEqual([
            "https://custom.example",
            "http://beauty-de.shop.test",
        ]);
    });

    test("skips a locale domain that uses the Storefront language", async () => {
        const { hydrator, calls } = hydratorWith((call) => {
            if (call.operation.includes("search/language")) {
                return { data: [{ id: "en-lang-id" }], total: 1 };
            }
            return shopRoute({ germanInstalled: true })(call);
        });
        await hydrator.createSalesChannel({ name: "beauty", description: "" });
        expect(salesChannelPayload(calls)?.domains).toHaveLength(1);
    });

    test("reuses an existing root category and deletes its children", async () => {
        const { hydrator, calls } = hydratorWith(
            shopRoute({ existingRootId: "root-1", childCategories: ["child-1", "child-2"] })
        );

        const result = await hydrator.createSalesChannel({ name: "beauty", description: "" });

        expect(result.navigationCategoryId).toBe("root-1");
        const categoryOps = syncOps(calls).filter((op) => op.entity === "category");
        expect(categoryOps).toEqual([
            {
                entity: "category",
                action: "delete",
                payload: [{ id: "child-1" }, { id: "child-2" }],
            },
        ]);
    });

    test("reuses an existing root category without children", async () => {
        const { hydrator, calls } = hydratorWith(shopRoute({ existingRootId: "root-1" }));
        const result = await hydrator.createSalesChannel({ name: "beauty", description: "" });
        expect(result.navigationCategoryId).toBe("root-1");
        expect(syncOps(calls).filter((op) => op.entity === "category")).toEqual([]);
    });

    test("assigns the Storefront theme to the new SalesChannel", async () => {
        const { hydrator, calls } = hydratorWith(shopRoute());
        const result = await hydrator.createSalesChannel({ name: "beauty", description: "" });

        const assign = calls.find((c) => c.operation.includes("assign"));
        expect(assign?.params.pathParams).toEqual({
            themeId: "theme-id",
            salesChannelId: result.id,
        });
    });

    test("skips theme assignment when no theme exists", async () => {
        const { hydrator, calls } = hydratorWith(shopRoute({ themes: [] }));
        const result = await hydrator.createSalesChannel({ name: "beauty", description: "" });

        expect(result.isNew).toBe(true);
        expect(calls.some((c) => c.operation.includes("assign"))).toBe(false);
    });
});
