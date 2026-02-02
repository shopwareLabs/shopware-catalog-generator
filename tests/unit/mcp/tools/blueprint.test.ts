/**
 * Unit tests for MCP blueprint tools
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { createCacheFromEnv } from "../../../../src/cache.js";

// Test constants
const TEST_CACHE_DIR = "./test-generated-mcp";
const TEST_SALES_CHANNEL = "mcp-test-store";

describe("Blueprint MCP Tools", () => {
    beforeEach(() => {
        // Set up test environment
        process.env.CACHE_DIR = TEST_CACHE_DIR;

        // Clean up any existing test data
        if (fs.existsSync(TEST_CACHE_DIR)) {
            fs.rmSync(TEST_CACHE_DIR, { recursive: true });
        }
    });

    afterEach(() => {
        // Clean up test data
        if (fs.existsSync(TEST_CACHE_DIR)) {
            fs.rmSync(TEST_CACHE_DIR, { recursive: true });
        }
        delete process.env.CACHE_DIR;
    });

    describe("blueprint_create logic", () => {
        it("should create a blueprint with default products", async () => {
            const { BlueprintGenerator } = await import("../../../../src/generators/index.js");

            const generator = new BlueprintGenerator({
                totalProducts: 90,
                productsPerBranch: 30,
            });

            const blueprint = generator.generateBlueprint(TEST_SALES_CHANNEL, "Test webshop");

            expect(blueprint.salesChannel.name).toBe(TEST_SALES_CHANNEL);
            expect(blueprint.products.length).toBe(90);
            expect(blueprint.categories.length).toBeGreaterThan(0);
        });

        it("should create a blueprint with custom product count", async () => {
            const { BlueprintGenerator } = await import("../../../../src/generators/index.js");

            const generator = new BlueprintGenerator({
                totalProducts: 12,
                productsPerBranch: 4,
            });

            const blueprint = generator.generateBlueprint(TEST_SALES_CHANNEL, "Small store");

            // Generator distributes products across branches, may not be exact
            expect(blueprint.products.length).toBeGreaterThanOrEqual(10);
            expect(blueprint.products.length).toBeLessThanOrEqual(15);
        });

        it("should save blueprint to cache", async () => {
            const { BlueprintGenerator } = await import("../../../../src/generators/index.js");

            const cache = createCacheFromEnv();
            const generator = new BlueprintGenerator({
                totalProducts: 12,
                productsPerBranch: 4,
            });

            const blueprint = generator.generateBlueprint(TEST_SALES_CHANNEL, "Test store");
            cache.saveBlueprint(TEST_SALES_CHANNEL, blueprint);

            // Verify file exists
            const blueprintPath = path.join(
                TEST_CACHE_DIR,
                "sales-channels",
                TEST_SALES_CHANNEL,
                "blueprint.json"
            );
            expect(fs.existsSync(blueprintPath)).toBe(true);

            // Verify content
            const loaded = cache.loadBlueprint(TEST_SALES_CHANNEL);
            expect(loaded).not.toBeNull();
            expect(loaded?.products.length).toBeGreaterThan(0);
        });
    });

    describe("name validation", () => {
        it("should validate subdomain names", async () => {
            const { validateSubdomainName } = await import("../../../../src/utils/index.js");

            // Valid names (function auto-sanitizes)
            expect(validateSubdomainName("furniture").valid).toBe(true);
            expect(validateSubdomainName("my-store").valid).toBe(true);
            expect(validateSubdomainName("store123").valid).toBe(true);

            // Empty string is invalid
            expect(validateSubdomainName("").valid).toBe(false);
        });

        it("should sanitize names with spaces", async () => {
            const { validateSubdomainName } = await import("../../../../src/utils/index.js");

            // Function sanitizes and returns valid=true with sanitized version
            const result = validateSubdomainName("My Store");
            // Sanitized version should be lowercase with hyphens
            expect(result.sanitized).toBe("my-store");
        });
    });

    describe("blueprint loading", () => {
        it("should return null for non-existent blueprint", () => {
            const cache = createCacheFromEnv();
            const blueprint = cache.loadBlueprint("non-existent");
            expect(blueprint).toBeNull();
        });

        it("should return null for non-existent hydrated blueprint", () => {
            const cache = createCacheFromEnv();
            const blueprint = cache.loadHydratedBlueprint("non-existent");
            expect(blueprint).toBeNull();
        });
    });
});
