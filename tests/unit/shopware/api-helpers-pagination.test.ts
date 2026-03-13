import { describe, expect, test } from "bun:test";

import {
    findCategoryIdByName,
    getAllSalesChannelProductIds,
    getSalesChannelNavigationCategoryId,
    searchAllByEqualsAny,
    searchAllByFilter,
} from "../../../src/shopware/api-helpers.js";
import { createTestContext } from "../../helpers/post-processor-context.js";
import { createMockApiHelpers, type MockApiHelpers } from "../../mocks/index.js";

function createContext(mockApi?: MockApiHelpers) {
    return createTestContext({ mockApi }).context;
}

describe("shopware api pagination helpers", () => {
    test("getSalesChannelNavigationCategoryId returns navigationCategoryId", async () => {
        const mockApi = createMockApiHelpers();
        mockApi.mockPostResponse("search/sales-channel", {
            data: [{ id: "sc-123", navigationCategoryId: "root-1" }],
        });

        const id = await getSalesChannelNavigationCategoryId(createContext(mockApi));
        expect(id).toBe("root-1");
    });

    test("findCategoryIdByName returns category id", async () => {
        const mockApi = createMockApiHelpers();
        mockApi.mockPostResponse("search/category", { data: [{ id: "cat-1" }] });

        const id = await findCategoryIdByName(createContext(mockApi), "Testing", "parent-1");
        expect(id).toBe("cat-1");
    });

    test("searchAllByFilter uses api helper path when result < 500", async () => {
        const mockApi = createMockApiHelpers();
        mockApi.mockSearchResponse("product", [{ id: "1" }, { id: "2" }]);
        const context = createContext(mockApi);

        const result = await searchAllByFilter<{ id: string }>(context, "product", []);
        expect(result).toEqual([{ id: "1" }, { id: "2" }]);
    });

    test("searchAllByFilter falls back to paginated apiPost when api helper hits cap", async () => {
        const mockApi = createMockApiHelpers();
        mockApi.mockSearchResponse(
            "product",
            Array.from({ length: 500 }, (_, i) => ({ id: `seed-${i}` }))
        );
        mockApi.mockPostResponse("search/product", { fallback: true });
        const originalPost = mockApi.post.bind(mockApi);
        mockApi.post = (async (_endpoint: string, body?: unknown) => {
            const page = (body as { page?: number } | undefined)?.page ?? 1;
            if (page === 1) return { data: [{ id: "a" }, { id: "b" }], total: 3 };
            return { data: [{ id: "c" }], total: 3 };
        }) as typeof originalPost;
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
        mockApi.mockSearchResponse("product", [{ id: "p1" }, { id: "p2" }]);
        const context = createContext(mockApi);

        const ids = await getAllSalesChannelProductIds(context);
        expect(ids).toEqual(["p1", "p2"]);
    });
});
