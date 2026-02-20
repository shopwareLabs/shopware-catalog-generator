import { describe, expect, mock, test } from "bun:test";

import type { PostProcessorContext } from "../../../src/post-processors/index.js";

import {
    findCategoryIdByName,
    getAllSalesChannelProductIds,
    getSalesChannelNavigationCategoryId,
    searchAllByEqualsAny,
    searchAllByFilter,
} from "../../../src/shopware/api-helpers.js";
import { createMockApiHelpers, type MockApiHelpers } from "../../mocks/index.js";

function createContext(mockApi?: MockApiHelpers): PostProcessorContext {
    return {
        salesChannelId: "sc-123",
        salesChannelName: "test-store",
        blueprint: {
            version: "1.0",
            salesChannel: { name: "test-store", description: "Test store" },
            categories: [],
            products: [],
            propertyGroups: [],
            createdAt: new Date().toISOString(),
            hydratedAt: new Date().toISOString(),
        },
        cache: {} as PostProcessorContext["cache"],
        shopwareUrl: "https://test.shopware.com",
        getAccessToken: async () => "token",
        api: mockApi as unknown as PostProcessorContext["api"],
        options: { batchSize: 5, dryRun: false },
    };
}

describe("shopware api pagination helpers", () => {
    test("getSalesChannelNavigationCategoryId returns navigationCategoryId", async () => {
        globalThis.fetch = mock(async () => {
            return {
                ok: true,
                status: 200,
                json: async () => ({ data: [{ id: "sc-123", navigationCategoryId: "root-1" }] }),
                text: async () => "{}",
            } as Response;
        }) as unknown as typeof fetch;

        const id = await getSalesChannelNavigationCategoryId(createContext());
        expect(id).toBe("root-1");
    });

    test("findCategoryIdByName returns category id", async () => {
        globalThis.fetch = mock(async () => {
            return {
                ok: true,
                status: 200,
                json: async () => ({ data: [{ id: "cat-1" }] }),
                text: async () => "{}",
            } as Response;
        }) as unknown as typeof fetch;

        const id = await findCategoryIdByName(createContext(), "Testing", "parent-1");
        expect(id).toBe("cat-1");
    });

    test("searchAllByFilter uses api helper path when result < 500", async () => {
        const mockApi = createMockApiHelpers();
        (mockApi as { searchEntities: unknown }).searchEntities = mock(async () => [
            { id: "1" },
            { id: "2" },
        ]);
        const context = createContext(mockApi);

        const result = await searchAllByFilter<{ id: string }>(context, "product", []);
        expect(result).toEqual([{ id: "1" }, { id: "2" }]);
    });

    test("searchAllByFilter falls back to paginated apiPost when api helper hits cap", async () => {
        const mockApi = createMockApiHelpers();
        (mockApi as { searchEntities: unknown }).searchEntities = mock(async () =>
            Array.from({ length: 500 }, (_, i) => ({ id: `seed-${i}` }))
        );
        (mockApi as { post: unknown }).post = mock(async (_endpoint: string, body?: unknown) => {
            const page = (body as { page?: number } | undefined)?.page ?? 1;
            if (page === 1) return { data: [{ id: "a" }, { id: "b" }], total: 3 };
            return { data: [{ id: "c" }], total: 3 };
        });
        const context = createContext(mockApi);

        const result = await searchAllByFilter<{ id: string }>(context, "product", [], {
            pageSize: 2,
        });
        expect(result.map((r) => r.id)).toEqual(["a", "b", "c"]);
    });

    test("searchAllByEqualsAny chunks values and combines results", async () => {
        const mockApi = createMockApiHelpers();
        mockApi.mockSearchResponse("product-review", [{ id: "x" }]);
        const context = createContext(mockApi);

        const values = Array.from({ length: 250 }, (_, i) => `id-${i}`);
        const result = await searchAllByEqualsAny<{ id: string }>(
            context,
            "product-review",
            "productId",
            values
        );

        expect(result).toHaveLength(3);
        expect(mockApi.getCallsByEndpoint("search/product-review")).toHaveLength(3);
    });

    test("getAllSalesChannelProductIds returns mapped product ids", async () => {
        const mockApi = createMockApiHelpers();
        (mockApi as { searchEntities: unknown }).searchEntities = mock(async () => [
            { id: "p1" },
            { id: "p2" },
        ]);
        const context = createContext(mockApi);

        const ids = await getAllSalesChannelProductIds(context);
        expect(ids).toEqual(["p1", "p2"]);
    });
});
