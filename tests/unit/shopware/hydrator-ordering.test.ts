import { describe, expect, test } from "bun:test";

import type { AdminApiClient } from "../../../src/shopware/admin-client.js";
import type { CategoryNode } from "../../../src/types/index.js";

import { ShopwareHydrator } from "../../../src/shopware/hydrator.js";

describe("ShopwareHydrator createCategoryTree", () => {
    test("includes afterCategoryId in category payloads", async () => {
        let capturedSyncBody: Array<{ entity: string; action: string; payload: unknown[] }> = [];

        const mockClient = {
            invoke: async (operation: string, params: { body?: unknown[] }) => {
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
            },
            getSessionData: () => ({ accessToken: "test-token" }),
        } as unknown as AdminApiClient;

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

        const mockClient = {
            invoke: async (operation: string, params: { body?: unknown[] }) => {
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
            },
            getSessionData: () => ({ accessToken: "test-token" }),
        } as unknown as AdminApiClient;

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

        const mockClient = {
            invoke: async (operation: string, params: { body?: unknown[] }) => {
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
            },
            getSessionData: () => ({ accessToken: "test-token" }),
        } as unknown as AdminApiClient;

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
