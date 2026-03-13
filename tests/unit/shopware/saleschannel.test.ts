/**
 * Unit tests for multi-domain/multi-language/multi-currency SalesChannel creation.
 */

import { describe, expect, test } from "bun:test";

import type { AdminApiClient } from "../../../src/shopware/admin-client.js";

import { ShopwareClient } from "../../../src/shopware/client.js";
import { ShopwareHydrator } from "../../../src/shopware/hydrator.js";
import { logger } from "../../../src/utils/index.js";
import { createMockAdminClient, createMockAdminClientWithInvoke } from "../../mocks/index.js";

/** Minimal Storefront SalesChannel response used when cloning */
const STOREFRONT_RESPONSE = {
    data: [
        {
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
        },
    ],
    total: 1,
};

// =============================================================================
// ShopwareClient.getLanguageId tests
// =============================================================================

describe("ShopwareClient.getLanguageId", () => {
    test("returns language ID when found", async () => {
        const client = new ShopwareClient(
            createMockAdminClient({
                "search/language": { data: [{ id: "de-lang-id" }], total: 1 },
            })
        );
        const result = await client.getLanguageId("de-DE");
        expect(result).toBe("de-lang-id");
    });

    test("returns null when language is not installed", async () => {
        const client = new ShopwareClient(
            createMockAdminClient({
                "search/language": { data: [], total: 0 },
            })
        );
        const result = await client.getLanguageId("de-DE");
        expect(result).toBeNull();
    });

    test("returns null when data is missing", async () => {
        const client = new ShopwareClient(
            createMockAdminClient({
                "search/language": { total: 0 },
            })
        );
        const result = await client.getLanguageId("de-DE");
        expect(result).toBeNull();
    });
});

// =============================================================================
// ShopwareClient.getSnippetSetId tests
// =============================================================================

describe("ShopwareClient.getSnippetSetId", () => {
    test("returns snippet set ID when found", async () => {
        const client = new ShopwareClient(
            createMockAdminClient({
                "search/snippet-set": { data: [{ id: "de-snippet-id" }], total: 1 },
            })
        );
        const result = await client.getSnippetSetId("de-DE");
        expect(result).toBe("de-snippet-id");
    });

    test("returns null when snippet set is not installed", async () => {
        const client = new ShopwareClient(
            createMockAdminClient({
                "search/snippet-set": { data: [], total: 0 },
            })
        );
        const result = await client.getSnippetSetId("de-DE");
        expect(result).toBeNull();
    });
});

// =============================================================================
// ShopwareHydrator.createSalesChannel - multi-domain tests
// =============================================================================

/**
 * Build a fully-configured mock AdminApiClient for createSalesChannel tests.
 * Callers can override the German language and snippet set to test fallback.
 */
function buildHydratorMockClient({
    germanLanguageId = "de-lang-id",
    germanSnippetSetId = "de-snippet-id",
    usdCurrencyId = "usd-id",
    eurCurrencyId = "eur-id",
}: {
    germanLanguageId?: string | null;
    germanSnippetSetId?: string | null;
    usdCurrencyId?: string | null;
    eurCurrencyId?: string;
} = {}): { client: AdminApiClient; capturedSyncPayloads: unknown[] } {
    const capturedSyncPayloads: unknown[] = [];

    const client = createMockAdminClientWithInvoke(
        async (operation: string, params: { body?: unknown }) => {
            if (
                operation.includes("search/sales-channel") &&
                JSON.stringify(params?.body).includes('"Beauty"')
            ) {
                return { data: { data: [], total: 0 } };
            }

            if (operation.includes("search/sales-channel")) {
                return { data: STOREFRONT_RESPONSE };
            }

            if (operation.includes("search/currency")) {
                const body = params?.body as { filter?: Array<{ value: string }> };
                const iso = body?.filter?.[0]?.value;
                if (iso === "USD") {
                    if (!usdCurrencyId) return { data: { data: [], total: 0 } };
                    return { data: { data: [{ id: usdCurrencyId }], total: 1 } };
                }
                if (iso === "EUR") {
                    return { data: { data: [{ id: eurCurrencyId }], total: 1 } };
                }
                return { data: { data: [], total: 0 } };
            }

            if (operation.includes("search/language")) {
                if (!germanLanguageId) return { data: { data: [], total: 0 } };
                return { data: { data: [{ id: germanLanguageId }], total: 1 } };
            }

            if (operation.includes("search/snippet-set")) {
                if (!germanSnippetSetId) return { data: { data: [], total: 0 } };
                return { data: { data: [{ id: germanSnippetSetId }], total: 1 } };
            }

            if (operation.includes("search/category")) {
                return { data: { data: [], total: 0 } };
            }

            if (operation.includes("search/theme")) {
                return { data: { data: [{ id: "theme-id", salesChannels: [] }], total: 1 } };
            }

            if (operation.includes("theme") && operation.includes("assign")) {
                return { data: {} };
            }

            if (operation.includes("_action/sync")) {
                const ops = params?.body as Array<{ entity: string; payload: unknown[] }>;
                for (const op of ops ?? []) {
                    capturedSyncPayloads.push(op);
                }
                return { data: {} };
            }

            return { data: { data: [], total: 0 } };
        }
    );

    return { client, capturedSyncPayloads };
}

describe("ShopwareHydrator.createSalesChannel - multi-domain", () => {
    test("creates two domains when German language and snippet set are available", async () => {
        logger.setMcpMode(true);

        const { client, capturedSyncPayloads } = buildHydratorMockClient();
        const hydrator = new ShopwareHydrator(client);
        hydrator.envPath = "http://localhost:8000";

        await hydrator.createSalesChannel({ name: "beauty", description: "Beauty store" });

        const scSync = capturedSyncPayloads.find(
            (op) => (op as { entity: string }).entity === "sales_channel"
        ) as { entity: string; payload: Array<{ domains: unknown[] }> } | undefined;

        expect(scSync).toBeDefined();
        const scPayload = scSync?.payload[0];
        expect(scPayload?.domains).toHaveLength(2);

        logger.setMcpMode(false);
    });

    test("English domain uses USD currency and storefront language", async () => {
        logger.setMcpMode(true);

        const { client, capturedSyncPayloads } = buildHydratorMockClient();
        const hydrator = new ShopwareHydrator(client);
        hydrator.envPath = "http://localhost:8000";

        await hydrator.createSalesChannel({ name: "beauty", description: "Beauty store" });

        const scSync = capturedSyncPayloads.find(
            (op) => (op as { entity: string }).entity === "sales_channel"
        ) as {
            entity: string;
            payload: Array<{
                domains: Array<{ url: string; languageId: string; currencyId: string }>;
                currencyId: string;
            }>;
        };

        const scPayload = scSync?.payload[0];
        const enDomain = scPayload?.domains.find((d) => d.url.includes("beauty.localhost"));
        expect(enDomain?.currencyId).toBe("usd-id");
        expect(enDomain?.languageId).toBe("en-lang-id");
        expect(scPayload?.currencyId).toBe("usd-id");

        logger.setMcpMode(false);
    });

    test("German domain uses EUR currency and de-DE language", async () => {
        logger.setMcpMode(true);

        const { client, capturedSyncPayloads } = buildHydratorMockClient();
        const hydrator = new ShopwareHydrator(client);
        hydrator.envPath = "http://localhost:8000";

        await hydrator.createSalesChannel({ name: "beauty", description: "Beauty store" });

        const scSync = capturedSyncPayloads.find(
            (op) => (op as { entity: string }).entity === "sales_channel"
        ) as {
            entity: string;
            payload: Array<{
                domains: Array<{
                    url: string;
                    languageId: string;
                    currencyId: string;
                    snippetSetId: string;
                }>;
            }>;
        };

        const deDomain = scSync?.payload[0]?.domains.find((d) => d.url.includes("-de.localhost"));
        expect(deDomain?.url).toBe("http://beauty-de.localhost:8000");
        expect(deDomain?.currencyId).toBe("eur-id");
        expect(deDomain?.languageId).toBe("de-lang-id");
        expect(deDomain?.snippetSetId).toBe("de-snippet-id");

        logger.setMcpMode(false);
    });

    test("falls back to single English domain when German language is not installed", async () => {
        logger.setMcpMode(true);

        const { client, capturedSyncPayloads } = buildHydratorMockClient({
            germanLanguageId: null,
        });
        const hydrator = new ShopwareHydrator(client);
        hydrator.envPath = "http://localhost:8000";

        await hydrator.createSalesChannel({ name: "beauty", description: "Beauty store" });

        const scSync = capturedSyncPayloads.find(
            (op) => (op as { entity: string }).entity === "sales_channel"
        ) as { entity: string; payload: Array<{ domains: unknown[] }> } | undefined;

        expect(scSync?.payload[0]?.domains).toHaveLength(1);

        logger.setMcpMode(false);
    });

    test("falls back to single English domain when German snippet set is not installed", async () => {
        logger.setMcpMode(true);

        const { client, capturedSyncPayloads } = buildHydratorMockClient({
            germanSnippetSetId: null,
        });
        const hydrator = new ShopwareHydrator(client);
        hydrator.envPath = "http://localhost:8000";

        await hydrator.createSalesChannel({ name: "beauty", description: "Beauty store" });

        const scSync = capturedSyncPayloads.find(
            (op) => (op as { entity: string }).entity === "sales_channel"
        ) as { entity: string; payload: Array<{ domains: unknown[] }> } | undefined;

        expect(scSync?.payload[0]?.domains).toHaveLength(1);

        logger.setMcpMode(false);
    });

    test("falls back to storefront currency when USD is not found", async () => {
        logger.setMcpMode(true);

        const { client, capturedSyncPayloads } = buildHydratorMockClient({ usdCurrencyId: null });
        const hydrator = new ShopwareHydrator(client);
        hydrator.envPath = "http://localhost:8000";

        await hydrator.createSalesChannel({ name: "beauty", description: "Beauty store" });

        const scSync = capturedSyncPayloads.find(
            (op) => (op as { entity: string }).entity === "sales_channel"
        ) as {
            entity: string;
            payload: Array<{ currencyId: string }>;
        };

        // Should use the storefront fallback currency ID
        expect(scSync?.payload[0]?.currencyId).toBe("eur-fallback-id");

        logger.setMcpMode(false);
    });

    test("includes both languages and both currencies in SalesChannel arrays", async () => {
        logger.setMcpMode(true);

        const { client, capturedSyncPayloads } = buildHydratorMockClient();
        const hydrator = new ShopwareHydrator(client);
        hydrator.envPath = "http://localhost:8000";

        await hydrator.createSalesChannel({ name: "beauty", description: "Beauty store" });

        const scSync = capturedSyncPayloads.find(
            (op) => (op as { entity: string }).entity === "sales_channel"
        ) as {
            entity: string;
            payload: Array<{
                languages: Array<{ id: string }>;
                currencies: Array<{ id: string }>;
            }>;
        };

        const scPayload = scSync?.payload[0];
        const languageIds = scPayload?.languages.map((l) => l.id);
        const currencyIds = scPayload?.currencies.map((c) => c.id);

        expect(languageIds).toContain("en-lang-id");
        expect(languageIds).toContain("de-lang-id");
        expect(currencyIds).toContain("usd-id");
        expect(currencyIds).toContain("eur-id");

        logger.setMcpMode(false);
    });

    test("returns isNew: false for existing SalesChannel without modification", async () => {
        logger.setMcpMode(true);

        const client = createMockAdminClient({
            "search/sales-channel": {
                data: [
                    {
                        id: "existing-sc",
                        name: "Beauty",
                        typeId: "8a243080f92e4c719546314b577cf82b",
                        languageId: "en-lang-id",
                        currencyId: "usd-id",
                        paymentMethodId: "pay-id",
                        shippingMethodId: "ship-id",
                        countryId: "country-id",
                        customerGroupId: "cg-id",
                        navigationCategoryId: "nav-id",
                        domains: [{ snippetSetId: "en-snippet-id" }],
                    },
                ],
                total: 1,
            },
        });
        const hydrator = new ShopwareHydrator(client);

        const result = await hydrator.createSalesChannel({
            name: "beauty",
            description: "Beauty store",
        });

        expect(result.isNew).toBe(false);
        expect(result.id).toBe("existing-sc");

        logger.setMcpMode(false);
    });
});
