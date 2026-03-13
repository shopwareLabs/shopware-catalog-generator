import { describe, expect, test } from "bun:test";

import { resolvePrimaryCurrencyId } from "../../../src/post-processors/currency-utils.js";
import { createMockApiHelpers } from "../../mocks/index.js";

describe("resolvePrimaryCurrencyId", () => {
    test("returns base currency (factor=1) when found", async () => {
        const mockApi = createMockApiHelpers();
        mockApi.mockSearchResponse("currency", [{ id: "eur-id" }]);

        const result = await resolvePrimaryCurrencyId(mockApi);
        expect(result).toBe("eur-id");
    });

    test("falls back to EUR by ISO code when factor=1 search returns nothing", async () => {
        const mockApi = createMockApiHelpers();
        mockApi.mockSearchResponse("currency", []);
        mockApi.getCurrencyId = async (): Promise<string> => "eur-id";

        const result = await resolvePrimaryCurrencyId(mockApi);
        expect(result).toBe("eur-id");
    });

    test("falls back to EUR by ISO code when factor=1 search throws", async () => {
        const mockApi = createMockApiHelpers();
        // Simulate searchEntities throwing for factor filter
        mockApi.searchEntities = async (entity: string) => {
            if (entity === "currency") throw new Error("field not searchable");
            return [];
        };
        mockApi.getCurrencyId = async (): Promise<string> => "eur-id";

        const result = await resolvePrimaryCurrencyId(mockApi);
        expect(result).toBe("eur-id");
    });

    test("falls back to getCurrencyId with EUR iso code", async () => {
        const mockApi = createMockApiHelpers();
        mockApi.mockSearchResponse("currency", []);

        const calledWith: string[] = [];
        mockApi.getCurrencyId = async (isoCode = "EUR"): Promise<string> => {
            calledWith.push(isoCode);
            return "eur-id";
        };

        await resolvePrimaryCurrencyId(mockApi);
        expect(calledWith).toEqual(["EUR"]);
    });

    test("does not call getCurrencyId when factor=1 currency is found", async () => {
        const mockApi = createMockApiHelpers();
        mockApi.mockSearchResponse("currency", [{ id: "base-id" }]);

        let getCurrencyCalled = false;
        mockApi.getCurrencyId = async (): Promise<string> => {
            getCurrencyCalled = true;
            return "eur-id";
        };

        const result = await resolvePrimaryCurrencyId(mockApi);
        expect(result).toBe("base-id");
        expect(getCurrencyCalled).toBe(false);
    });
});
