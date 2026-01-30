import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";

import { DataCache } from "../../src/cache.js";
import type { CategoryNode } from "../../src/types/index.js";

const TEST_BASE_DIR = "./test-cache-sc";
const TEST_CACHE_DIR = `${TEST_BASE_DIR}/generated`;

describe("SalesChannel Cache Operations", () => {
    let cache: DataCache;

    beforeEach(() => {
        cache = new DataCache({
            enabled: true,
            cacheDir: TEST_CACHE_DIR,
            useCache: true,
            saveToCache: true,
        });
    });

    afterEach(() => {
        // Clean up the entire test base directory (includes both cache and trash)
        if (fs.existsSync(TEST_BASE_DIR)) {
            fs.rmSync(TEST_BASE_DIR, { recursive: true });
        }
    });

    describe("SalesChannel metadata", () => {
        test("saves and loads metadata", () => {
            cache.saveSalesChannelMetadata("furniture", "Selling wood furniture", "sc-123");

            const metadata = cache.loadSalesChannelMetadata("furniture");

            expect(metadata).not.toBeNull();
            expect(metadata?.name).toBe("furniture");
            expect(metadata?.description).toBe("Selling wood furniture");
            expect(metadata?.shopwareId).toBe("sc-123");
            expect(metadata?.createdAt).toBeDefined();
        });

        test("returns null for non-existent SalesChannel", () => {
            const metadata = cache.loadSalesChannelMetadata("nonexistent");
            expect(metadata).toBeNull();
        });
    });

    describe("Category tree caching", () => {
        const testTree: CategoryNode[] = [
            {
                id: "cat-1",
                name: "Beds",
                description: "Comfortable beds",
                productCount: 5,
                hasImage: true,
                children: [],
            },
            {
                id: "cat-2",
                name: "Tables",
                description: "Beautiful tables",
                productCount: 5,
                hasImage: false,
                children: [],
            },
        ];

        test("saves and loads category tree", () => {
            cache.saveCategoryTree("furniture", testTree, 10, "gpt-4");

            const loaded = cache.loadCategoryTree("furniture");

            expect(loaded).not.toBeNull();
            expect(loaded?.tree).toHaveLength(2);
            expect(loaded?.totalProducts).toBe(10);
            expect(loaded?.textModel).toBe("gpt-4");
        });

        test("hasCategoryTree returns true when tree exists", () => {
            cache.saveCategoryTree("furniture", testTree, 10);

            expect(cache.hasCategoryTree("furniture")).toBe(true);
        });

        test("hasCategoryTree returns false when tree does not exist", () => {
            expect(cache.hasCategoryTree("nonexistent")).toBe(false);
        });

        test("returns null for non-existent SalesChannel", () => {
            const loaded = cache.loadCategoryTree("nonexistent");
            expect(loaded).toBeNull();
        });
    });

    describe("SalesChannel-scoped products", () => {
        const testProducts = [
            { name: "Product 1", description: "Desc 1", stock: 10, price: 99 },
            { name: "Product 2", description: "Desc 2", stock: 20, price: 199 },
        ];

        test("saves and loads products for a category", () => {
            cache.saveProductsForSalesChannel("furniture", "beds", testProducts);

            const loaded = cache.loadProductsForSalesChannel("furniture", "beds");

            expect(loaded).toHaveLength(2);
            expect(loaded[0]?.name).toBe("Product 1");
        });

        test("returns empty array for non-existent category", () => {
            const loaded = cache.loadProductsForSalesChannel("furniture", "nonexistent");
            expect(loaded).toHaveLength(0);
        });

        test("merges products avoiding duplicates", () => {
            const firstProduct = testProducts[0];
            if (firstProduct) {
                cache.saveProductsForSalesChannel("furniture", "beds", [firstProduct]);
            }
            cache.saveProductsForSalesChannel("furniture", "beds", testProducts);

            const loaded = cache.loadProductsForSalesChannel("furniture", "beds");
            expect(loaded).toHaveLength(2);
        });
    });

    describe("SalesChannel listing and clearing", () => {
        test("lists all cached SalesChannels", () => {
            cache.saveSalesChannelMetadata("furniture", "Furniture store");
            cache.saveSalesChannelMetadata("electronics", "Electronics store");

            const salesChannels = cache.listSalesChannels();

            expect(salesChannels).toHaveLength(2);
            expect(salesChannels).toContain("furniture");
            expect(salesChannels).toContain("electronics");
        });

        test("clears SalesChannel cache", () => {
            cache.saveSalesChannelMetadata("furniture", "Furniture store");
            cache.saveCategoryTree("furniture", [], 0);

            cache.clearSalesChannel("furniture");

            expect(cache.loadSalesChannelMetadata("furniture")).toBeNull();
            expect(cache.hasCategoryTree("furniture")).toBe(false);
        });
    });

    describe("disabled cache", () => {
        let disabledCache: DataCache;

        beforeEach(() => {
            disabledCache = new DataCache({ enabled: false });
        });

        test("loadSalesChannelMetadata returns null when disabled", () => {
            expect(disabledCache.loadSalesChannelMetadata("any")).toBeNull();
        });

        test("loadCategoryTree returns null when disabled", () => {
            expect(disabledCache.loadCategoryTree("any")).toBeNull();
        });

        test("hasCategoryTree returns false when disabled", () => {
            expect(disabledCache.hasCategoryTree("any")).toBe(false);
        });

        test("loadProductsForSalesChannel returns empty array when disabled", () => {
            expect(disabledCache.loadProductsForSalesChannel("any", "any")).toHaveLength(0);
        });
    });
});
