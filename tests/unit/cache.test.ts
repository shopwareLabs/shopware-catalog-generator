import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";

import type { ProductInput, PropertyGroup } from "../../src/types/index.js";

import { DataCache } from "../../src/cache.js";

const TEST_BASE_DIR = "./test-cache-temp";
const TEST_CACHE_DIR = `${TEST_BASE_DIR}/generated`;
const TEST_SALES_CHANNEL = "test-saleschannel";

describe("DataCache", () => {
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

    describe("initialization", () => {
        test("creates cache directory on initialization", () => {
            expect(fs.existsSync(TEST_CACHE_DIR)).toBe(true);
        });

        test("isEnabled returns true when enabled", () => {
            expect(cache.isEnabled).toBe(true);
        });

        test("isEnabled returns false when disabled", () => {
            const disabledCache = new DataCache({ enabled: false });
            expect(disabledCache.isEnabled).toBe(false);
        });

        test("shouldUseCache respects useCache option", () => {
            const noUseCache = new DataCache({
                enabled: true,
                cacheDir: TEST_CACHE_DIR,
                useCache: false,
                saveToCache: true,
            });
            expect(noUseCache.shouldUseCache).toBe(false);
        });

        test("shouldSaveToCache respects saveToCache option", () => {
            const noSaveCache = new DataCache({
                enabled: true,
                cacheDir: TEST_CACHE_DIR,
                useCache: true,
                saveToCache: false,
            });
            expect(noSaveCache.shouldSaveToCache).toBe(false);
        });
    });

    describe("SalesChannel metadata", () => {
        test("saves and loads metadata", () => {
            cache.saveSalesChannelMetadata(TEST_SALES_CHANNEL, "Test description", "shopware-123");

            const loaded = cache.loadSalesChannelMetadata(TEST_SALES_CHANNEL);
            expect(loaded).not.toBeNull();
            expect(loaded?.name).toBe(TEST_SALES_CHANNEL);
            expect(loaded?.description).toBe("Test description");
            expect(loaded?.shopwareId).toBe("shopware-123");
        });

        test("returns null for non-existent SalesChannel", () => {
            const loaded = cache.loadSalesChannelMetadata("non-existent");
            expect(loaded).toBeNull();
        });
    });

    describe("SalesChannel product caching", () => {
        const testProducts: ProductInput[] = [
            { name: "Product 1", description: "Desc 1", stock: 10, price: 10 },
            { name: "Product 2", description: "Desc 2", stock: 20, price: 20 },
        ];

        test("saves and loads products for a category", () => {
            cache.saveProductsForSalesChannel(TEST_SALES_CHANNEL, "test-category", testProducts);
            const loaded = cache.loadProductsForSalesChannel(TEST_SALES_CHANNEL, "test-category");

            expect(loaded).toHaveLength(2);
            expect(loaded[0]?.name).toBe("Product 1");
        });

        test("returns empty array for non-existent category", () => {
            const loaded = cache.loadProductsForSalesChannel(TEST_SALES_CHANNEL, "non-existent");
            expect(loaded).toHaveLength(0);
        });

        test("merges products by name, avoiding duplicates", () => {
            const firstProduct = testProducts[0];
            if (firstProduct) {
                cache.saveProductsForSalesChannel(TEST_SALES_CHANNEL, "test-category", [
                    firstProduct,
                ]);
            }
            cache.saveProductsForSalesChannel(TEST_SALES_CHANNEL, "test-category", testProducts);

            const loaded = cache.loadProductsForSalesChannel(TEST_SALES_CHANNEL, "test-category");
            expect(loaded).toHaveLength(2);
        });
    });

    describe("SalesChannel property group caching", () => {
        const testGroups: PropertyGroup[] = [
            {
                name: "Color",
                description: "Color options",
                displayType: "color",
                options: [{ name: "Red" }],
            },
            {
                name: "Size",
                description: "Size options",
                displayType: "text",
                options: [{ name: "Large" }],
            },
        ];

        test("saves and loads property groups", () => {
            cache.savePropertyGroupsForSalesChannel(TEST_SALES_CHANNEL, testGroups);
            const loaded = cache.loadPropertyGroupsForSalesChannel(TEST_SALES_CHANNEL);

            expect(loaded).not.toBeNull();
            expect(loaded).toHaveLength(2);
            expect(loaded?.[0]?.name).toBe("Color");
        });

        test("returns null for non-existent SalesChannel", () => {
            const loaded = cache.loadPropertyGroupsForSalesChannel("non-existent");
            expect(loaded).toBeNull();
        });

        test("hasPropertyGroupsForSalesChannel returns true when groups exist", () => {
            cache.savePropertyGroupsForSalesChannel(TEST_SALES_CHANNEL, testGroups);
            expect(cache.hasPropertyGroupsForSalesChannel(TEST_SALES_CHANNEL)).toBe(true);
        });

        test("hasPropertyGroupsForSalesChannel returns false when groups do not exist", () => {
            expect(cache.hasPropertyGroupsForSalesChannel("non-existent")).toBe(false);
        });
    });

    describe("SalesChannel image caching", () => {
        // Valid 1x1 transparent PNG base64
        const testBase64 =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

        test("saves and loads images", () => {
            cache.saveImageForSalesChannel(
                TEST_SALES_CHANNEL,
                "product-123",
                "Test Product",
                testBase64,
                "test prompt"
            );

            const loaded = cache.loadImageForSalesChannel(TEST_SALES_CHANNEL, "product-123");
            expect(loaded).not.toBeNull();
            expect(loaded).toBe(testBase64);
        });

        test("returns null for non-existent image", () => {
            const loaded = cache.loadImageForSalesChannel(TEST_SALES_CHANNEL, "non-existent");
            expect(loaded).toBeNull();
        });

        test("hasImageForSalesChannel returns true when image exists", () => {
            cache.saveImageForSalesChannel(
                TEST_SALES_CHANNEL,
                "product-123",
                "Test Product",
                testBase64,
                "test prompt"
            );
            expect(cache.hasImageForSalesChannel(TEST_SALES_CHANNEL, "product-123")).toBe(true);
        });

        test("hasImageForSalesChannel returns false when image does not exist", () => {
            expect(cache.hasImageForSalesChannel(TEST_SALES_CHANNEL, "non-existent")).toBe(false);
        });

        test("getImageCountForSalesChannel returns correct count", () => {
            cache.saveImageForSalesChannel(
                TEST_SALES_CHANNEL,
                "product-1",
                "Product 1",
                testBase64,
                "prompt 1"
            );
            cache.saveImageForSalesChannel(
                TEST_SALES_CHANNEL,
                "product-2",
                "Product 2",
                testBase64,
                "prompt 2"
            );

            expect(cache.getImageCountForSalesChannel(TEST_SALES_CHANNEL)).toBe(2);
        });

        test("getImageCountForSalesChannel returns 0 for non-existent SalesChannel", () => {
            expect(cache.getImageCountForSalesChannel("non-existent")).toBe(0);
        });
    });

    describe("SalesChannel category tree caching", () => {
        const testTree = [
            {
                name: "Category 1",
                description: "Description 1",
                productCount: 5,
                hasImage: false,
                children: [],
            },
        ];

        test("saves and loads category tree", () => {
            cache.saveCategoryTree(TEST_SALES_CHANNEL, testTree, 5);
            const loaded = cache.loadCategoryTree(TEST_SALES_CHANNEL);

            expect(loaded).not.toBeNull();
            expect(loaded?.tree).toHaveLength(1);
            expect(loaded?.totalProducts).toBe(5);
        });

        test("hasCategoryTree returns true when tree exists", () => {
            cache.saveCategoryTree(TEST_SALES_CHANNEL, testTree, 5);
            expect(cache.hasCategoryTree(TEST_SALES_CHANNEL)).toBe(true);
        });

        test("hasCategoryTree returns false when tree does not exist", () => {
            expect(cache.hasCategoryTree("non-existent")).toBe(false);
        });
    });

    describe("cache management", () => {
        test("listSalesChannels returns all cached SalesChannels", () => {
            cache.saveSalesChannelMetadata("channel-1", "Description 1");
            cache.saveSalesChannelMetadata("channel-2", "Description 2");

            const channels = cache.listSalesChannels();
            expect(channels).toHaveLength(2);
            expect(channels).toContain("channel-1");
            expect(channels).toContain("channel-2");
        });

        test("clearSalesChannel removes SalesChannel cache", () => {
            cache.saveSalesChannelMetadata(TEST_SALES_CHANNEL, "Description");
            cache.saveCategoryTree(TEST_SALES_CHANNEL, [], 0);

            cache.clearSalesChannel(TEST_SALES_CHANNEL);

            expect(cache.loadSalesChannelMetadata(TEST_SALES_CHANNEL)).toBeNull();
            expect(cache.hasCategoryTree(TEST_SALES_CHANNEL)).toBe(false);
        });

        test("clearAll removes all cached data", () => {
            cache.saveSalesChannelMetadata("channel-1", "Description 1");
            cache.saveSalesChannelMetadata("channel-2", "Description 2");

            cache.clearAll();

            expect(cache.listSalesChannels()).toHaveLength(0);
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

        test("loadProductsForSalesChannel returns empty array when disabled", () => {
            expect(disabledCache.loadProductsForSalesChannel("any", "any")).toHaveLength(0);
        });

        test("loadPropertyGroupsForSalesChannel returns null when disabled", () => {
            expect(disabledCache.loadPropertyGroupsForSalesChannel("any")).toBeNull();
        });

        test("loadImageForSalesChannel returns null when disabled", () => {
            expect(disabledCache.loadImageForSalesChannel("any", "any")).toBeNull();
        });

        test("hasImageForSalesChannel returns false when disabled", () => {
            expect(disabledCache.hasImageForSalesChannel("any", "any")).toBe(false);
        });

        test("hasPropertyGroupsForSalesChannel returns false when disabled", () => {
            expect(disabledCache.hasPropertyGroupsForSalesChannel("any")).toBe(false);
        });

        test("hasCategoryTree returns false when disabled", () => {
            expect(disabledCache.hasCategoryTree("any")).toBe(false);
        });
    });
});
