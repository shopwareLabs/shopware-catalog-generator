import { describe, expect, test } from "bun:test";

import { resolvePrimaryCurrencyId } from "../../../src/post-processors/currency-utils.js";
import { createMockApiHelpers } from "../../mocks/index.js";

describe("resolvePrimaryCurrencyId", () => {
    test("returns USD when USD is available", async () => {
        const mockApi = createMockApiHelpers();

        mockApi.getCurrencyId = async (isoCode?: string): Promise<string> => {
            if (isoCode === "USD") return "usd-id";
            if (isoCode === "EUR") return "eur-id";
            throw new Error(`Currency "${isoCode}" not found`);
        };

        const result = await resolvePrimaryCurrencyId(mockApi, "sc-123");
        expect(result).toBe("usd-id");
    });

    test("falls back to EUR when USD is missing", async () => {
        const mockApi = createMockApiHelpers();

        // USD throws (not found), EUR succeeds
        let callCount = 0;
        mockApi.getCurrencyId = async (isoCode?: string): Promise<string> => {
            callCount++;
            if (isoCode === "USD") throw new Error('Currency "USD" not found');
            if (isoCode === "EUR") return "eur-id";
            throw new Error(`Currency "${isoCode}" not found`);
        };

        const result = await resolvePrimaryCurrencyId(mockApi, "sc-123");
        expect(result).toBe("eur-id");
        expect(callCount).toBe(2);
    });

    test("falls back to SalesChannel currency when both USD and EUR are missing", async () => {
        const mockApi = createMockApiHelpers();

        mockApi.getCurrencyId = async (isoCode?: string): Promise<string> => {
            throw new Error(`Currency "${isoCode}" not found`);
        };
        mockApi.mockSearchResponse("sales_channel", [{ id: "sc-123", currencyId: "chf-id" }]);

        const result = await resolvePrimaryCurrencyId(mockApi, "sc-123");
        expect(result).toBe("chf-id");
    });

    test("throws when USD, EUR, and SalesChannel lookup all fail", async () => {
        const mockApi = createMockApiHelpers();

        mockApi.getCurrencyId = async (isoCode?: string): Promise<string> => {
            throw new Error(`Currency "${isoCode}" not found`);
        };
        mockApi.mockSearchResponse("sales_channel", []);

        await expect(resolvePrimaryCurrencyId(mockApi, "sc-123")).rejects.toThrow(
            "No currency found"
        );
    });

    test("prefers USD over EUR when both are available", async () => {
        const mockApi = createMockApiHelpers();

        let callCount = 0;
        mockApi.getCurrencyId = async (isoCode?: string): Promise<string> => {
            callCount++;
            if (isoCode === "USD") return "usd-id";
            if (isoCode === "EUR") return "eur-id";
            throw new Error(`Currency "${isoCode}" not found`);
        };

        const result = await resolvePrimaryCurrencyId(mockApi, "sc-123");
        expect(result).toBe("usd-id");
        expect(callCount).toBe(2);
    });

    test("lookups run in parallel (both called even when USD succeeds)", async () => {
        const mockApi = createMockApiHelpers();
        const calledWith: string[] = [];

        mockApi.getCurrencyId = async (isoCode?: string): Promise<string> => {
            calledWith.push(isoCode ?? "EUR");
            if (isoCode === "USD") return "usd-id";
            if (isoCode === "EUR") return "eur-id";
            throw new Error(`Currency "${isoCode}" not found`);
        };

        await resolvePrimaryCurrencyId(mockApi, "sc-123");
        expect(calledWith).toContain("USD");
        expect(calledWith).toContain("EUR");
    });
});
