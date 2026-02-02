/**
 * Unit tests for MCP cache tools
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { createCacheFromEnv } from "../../../../src/cache.js";

// Test constants
const TEST_CACHE_DIR = "./test-generated-mcp-cache";
const TEST_TRASH_DIR = "./.trash";
const TEST_SALES_CHANNEL = "cache-test-store";

describe("Cache MCP Tools", () => {
    beforeEach(() => {
        // Set up test environment
        process.env.CACHE_DIR = TEST_CACHE_DIR;

        // Clean up any existing test data
        if (fs.existsSync(TEST_CACHE_DIR)) {
            fs.rmSync(TEST_CACHE_DIR, { recursive: true });
        }

        // Clean up trash from previous tests
        if (fs.existsSync(TEST_TRASH_DIR)) {
            fs.rmSync(TEST_TRASH_DIR, { recursive: true });
        }
    });

    afterEach(() => {
        // Clean up test data
        if (fs.existsSync(TEST_CACHE_DIR)) {
            fs.rmSync(TEST_CACHE_DIR, { recursive: true });
        }

        // Clean up trash
        if (fs.existsSync(TEST_TRASH_DIR)) {
            fs.rmSync(TEST_TRASH_DIR, { recursive: true });
        }

        delete process.env.CACHE_DIR;
    });

    describe("cache_list logic", () => {
        it("should return empty list when no cache exists", () => {
            const cache = createCacheFromEnv();
            const salesChannels = cache.listSalesChannels();
            expect(salesChannels).toEqual([]);
        });

        it("should list cached SalesChannels", async () => {
            const cache = createCacheFromEnv();
            const { BlueprintGenerator } = await import("../../../../src/generators/index.js");

            // Create a blueprint to populate cache
            const generator = new BlueprintGenerator({
                totalProducts: 5,
                productsPerBranch: 2,
            });
            const blueprint = generator.generateBlueprint(TEST_SALES_CHANNEL, "Test store");
            cache.saveBlueprint(TEST_SALES_CHANNEL, blueprint);

            const salesChannels = cache.listSalesChannels();
            expect(salesChannels).toContain(TEST_SALES_CHANNEL);
        });
    });

    describe("cache_clear logic", () => {
        it("should move specific SalesChannel to trash", async () => {
            const cache = createCacheFromEnv();
            const { BlueprintGenerator } = await import("../../../../src/generators/index.js");

            // Create a blueprint
            const generator = new BlueprintGenerator({
                totalProducts: 5,
                productsPerBranch: 2,
            });
            const blueprint = generator.generateBlueprint(TEST_SALES_CHANNEL, "Test store");
            cache.saveBlueprint(TEST_SALES_CHANNEL, blueprint);

            // Verify it exists
            expect(cache.listSalesChannels()).toContain(TEST_SALES_CHANNEL);

            // Clear it
            cache.clearSalesChannel(TEST_SALES_CHANNEL);

            // Verify it's gone from main cache
            expect(cache.listSalesChannels()).not.toContain(TEST_SALES_CHANNEL);

            // Verify it's in trash
            const trashItems = cache.listTrash();
            expect(trashItems.some((item) => item.includes(TEST_SALES_CHANNEL))).toBe(true);
        });
    });

    describe("cache_trash logic", () => {
        it("should list trash items after clearing", async () => {
            const cache = createCacheFromEnv();
            const { BlueprintGenerator } = await import("../../../../src/generators/index.js");

            // Create and clear a blueprint to add something to trash
            const generator = new BlueprintGenerator({
                totalProducts: 5,
                productsPerBranch: 2,
            });
            const blueprint = generator.generateBlueprint(TEST_SALES_CHANNEL, "Test store");
            cache.saveBlueprint(TEST_SALES_CHANNEL, blueprint);
            cache.clearSalesChannel(TEST_SALES_CHANNEL);

            const trashItems = cache.listTrash();
            expect(trashItems.length).toBeGreaterThan(0);
            expect(trashItems.some((item) => item.includes(TEST_SALES_CHANNEL))).toBe(true);
        });
    });

    describe("cache_restore logic", () => {
        it("should restore item from trash", async () => {
            const cache = createCacheFromEnv();
            const { BlueprintGenerator } = await import("../../../../src/generators/index.js");

            // Create and clear a blueprint
            const generator = new BlueprintGenerator({
                totalProducts: 5,
                productsPerBranch: 2,
            });
            const blueprint = generator.generateBlueprint(TEST_SALES_CHANNEL, "Test store");
            cache.saveBlueprint(TEST_SALES_CHANNEL, blueprint);
            cache.clearSalesChannel(TEST_SALES_CHANNEL);

            // Get trash item name
            const trashItems = cache.listTrash();
            const itemToRestore = trashItems.find((item) => item.includes(TEST_SALES_CHANNEL));
            expect(itemToRestore).toBeDefined();

            // Restore it
            const targetPath = path.join(TEST_CACHE_DIR, "sales-channels", TEST_SALES_CHANNEL);
            const success = cache.restoreFromTrash(itemToRestore!, targetPath);
            expect(success).toBe(true);

            // Verify it's back
            expect(cache.listSalesChannels()).toContain(TEST_SALES_CHANNEL);
        });
    });

    describe("cache_empty_trash logic", () => {
        it("should permanently delete trash", async () => {
            const cache = createCacheFromEnv();
            const { BlueprintGenerator } = await import("../../../../src/generators/index.js");

            // Create and clear a blueprint
            const generator = new BlueprintGenerator({
                totalProducts: 5,
                productsPerBranch: 2,
            });
            const blueprint = generator.generateBlueprint(TEST_SALES_CHANNEL, "Test store");
            cache.saveBlueprint(TEST_SALES_CHANNEL, blueprint);
            cache.clearSalesChannel(TEST_SALES_CHANNEL);

            // Verify trash has items
            expect(cache.listTrash().length).toBeGreaterThan(0);

            // Empty trash
            cache.emptyTrash();

            // Verify trash is empty
            expect(cache.listTrash()).toEqual([]);
        });
    });
});
