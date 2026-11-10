/**
 * Unit tests for ShopwareClient sales channel lookups (name match + Storefront-type fallback).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ShopwareClient } from "../../../src/shopware/client.js";
import { logger } from "../../../src/utils/index.js";
import { createMockAdminClientWithInvoke } from "../../mocks/index.js";

interface SearchCall {
    filter: Array<{ type: string; field: string; value: string }>;
    associations?: unknown;
    limit: number;
}

const FULL_CHANNEL = {
    id: "sc-1",
    name: "Storefront",
    typeId: "type-1",
    languageId: "lang-1",
    currencyId: "cur-1",
    paymentMethodId: "pay-1",
    shippingMethodId: "ship-1",
    countryId: "country-1",
    customerGroupId: "cg-1",
    navigationCategoryId: "nav-1",
    domains: [{ snippetSetId: "snip-1" }, { snippetSetId: "snip-2" }],
};

/** Client whose sales channel search answers by filter field; records every request body */
function clientWith(byField: Record<string, unknown[]>): {
    client: ShopwareClient;
    calls: SearchCall[];
} {
    const calls: SearchCall[] = [];
    const client = new ShopwareClient(
        createMockAdminClientWithInvoke(async (_op, params) => {
            const body = params.body as SearchCall;
            calls.push(body);
            const field = body.filter[0]?.field ?? "";
            return { data: { data: byField[field] ?? [] } };
        })
    );
    return { client, calls };
}

beforeEach(() => logger.setMcpMode(true));
afterEach(() => logger.setMcpMode(false));

describe("ShopwareClient.getFullSalesChannel", () => {
    test("returns the channel found by name with the first domain's snippet set", async () => {
        const { client, calls } = clientWith({ name: [FULL_CHANNEL] });

        const result = await client.getFullSalesChannel("Storefront");

        expect(result).toEqual({
            id: "sc-1",
            name: "Storefront",
            typeId: "type-1",
            languageId: "lang-1",
            currencyId: "cur-1",
            paymentMethodId: "pay-1",
            shippingMethodId: "ship-1",
            countryId: "country-1",
            customerGroupId: "cg-1",
            navigationCategoryId: "nav-1",
            snippetSetId: "snip-1",
        });
        expect(calls).toEqual([
            {
                limit: 1,
                filter: [{ type: "equals", field: "name", value: "Storefront" }],
                associations: { domains: {} },
            },
        ]);
    });

    test("defaults to the Storefront name", async () => {
        const { client, calls } = clientWith({ name: [FULL_CHANNEL] });

        await client.getFullSalesChannel();

        expect(calls[0]?.filter[0]?.value).toBe("Storefront");
    });

    test("fills missing fields with empty strings", async () => {
        const { client } = clientWith({ name: [{ id: "sc-2" }] });

        const result = await client.getFullSalesChannel("Bare");

        expect(result).toEqual({
            id: "sc-2",
            name: "",
            typeId: "",
            languageId: "",
            currencyId: "",
            paymentMethodId: "",
            shippingMethodId: "",
            countryId: "",
            customerGroupId: "",
            navigationCategoryId: "",
            snippetSetId: undefined,
        });
    });

    test("falls back to any Storefront-type channel when the name is unknown", async () => {
        const { client, calls } = clientWith({ typeId: [{ ...FULL_CHANNEL, id: "sc-type" }] });
        const warn = logger.warn.bind(logger);
        const warnings: string[] = [];
        logger.warn = (message: string) => {
            warnings.push(message);
        };

        try {
            const result = await client.getFullSalesChannel("Missing");

            expect(result.id).toBe("sc-type");
            expect(result.snippetSetId).toBe("snip-1");
        } finally {
            logger.warn = warn;
        }

        expect(calls).toHaveLength(2);
        expect(calls[1]).toEqual({
            limit: 1,
            filter: [{ type: "equals", field: "typeId", value: ShopwareClient.STOREFRONT_TYPE_ID }],
            associations: { domains: {} },
        });
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toContain('"Missing" not found by name');
        expect(warnings[1]).toContain("Using sales channel fallback");
    });

    test("throws when neither the name nor the Storefront type matches", async () => {
        const { client } = clientWith({});

        await expect(client.getFullSalesChannel("Missing")).rejects.toThrow(
            `No sales channel found: tried name "Missing" and Storefront type ID "${ShopwareClient.STOREFRONT_TYPE_ID}"`
        );
    });

    test("treats a response without data as not found", async () => {
        const client = new ShopwareClient(
            createMockAdminClientWithInvoke(async () => ({ data: {} }))
        );

        await expect(client.getFullSalesChannel("Missing")).rejects.toThrow(
            "No sales channel found"
        );
    });
});

describe("ShopwareClient.getStandardSalesChannel", () => {
    test("returns id, navigation category and currency of the channel found by name", async () => {
        const { client, calls } = clientWith({ name: [FULL_CHANNEL] });

        const result = await client.getStandardSalesChannel("Storefront");

        expect(result).toEqual({ id: "sc-1", navigationCategoryId: "nav-1", currencyId: "cur-1" });
        expect(calls).toEqual([
            { limit: 1, filter: [{ type: "equals", field: "name", value: "Storefront" }] },
        ]);
    });

    test("falls back to a Storefront-type channel without the domains association", async () => {
        const { client, calls } = clientWith({ typeId: [{ id: "sc-type" }] });

        const result = await client.getStandardSalesChannel("Missing");

        expect(result).toEqual({ id: "sc-type", navigationCategoryId: "", currencyId: undefined });
        expect(calls[1]).toEqual({
            limit: 1,
            filter: [{ type: "equals", field: "typeId", value: ShopwareClient.STOREFRONT_TYPE_ID }],
        });
    });

    test("throws when no channel matches", async () => {
        const { client } = clientWith({});

        await expect(client.getStandardSalesChannel("Missing")).rejects.toThrow(
            "Ensure at least one Storefront-type sales channel exists in Shopware."
        );
    });
});
