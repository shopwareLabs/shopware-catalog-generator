import { describe, expect, test } from "bun:test";

import { BlueprintGenerator } from "../../../src/generators/blueprint-generator.js";
import type { BlueprintConfig } from "../../../src/types/index.js";

describe("BlueprintGenerator", () => {
    describe("generateBlueprint", () => {
        test("generates blueprint with default config", () => {
            const generator = new BlueprintGenerator();
            const blueprint = generator.generateBlueprint("test-store", "A test store");

            expect(blueprint.version).toBe("1.0");
            expect(blueprint.salesChannel.name).toBe("test-store");
            expect(blueprint.salesChannel.description).toBe("A test store");
            expect(blueprint.categories.length).toBe(3); // Default 3 top-level
            expect(blueprint.products.length).toBe(90); // Default 90 products
            expect(blueprint.createdAt).toBeDefined();
        });

        test("generates blueprint with custom config", () => {
            const config: Partial<BlueprintConfig> = {
                topLevelCategories: 2,
                totalProducts: 60,
                productsPerBranch: 30,
            };

            const generator = new BlueprintGenerator(config);
            const blueprint = generator.generateBlueprint("custom-store", "Custom store");

            expect(blueprint.categories.length).toBe(2);
            expect(blueprint.products.length).toBe(60);
        });

        test("generates category tree with correct structure", () => {
            const generator = new BlueprintGenerator({
                topLevelCategories: 2,
                maxDepth: 2,
                subcategoriesPerCategory: { min: 2, max: 2 },
            });

            const blueprint = generator.generateBlueprint("test", "test");

            // 2 top-level categories
            expect(blueprint.categories.length).toBe(2);

            // Each top-level should have children
            for (const topCat of blueprint.categories) {
                expect(topCat.level).toBe(1);
                expect(topCat.id).toBeDefined();
                expect(topCat.id.length).toBe(32); // Shopware UUID format
                expect(topCat.children.length).toBeGreaterThanOrEqual(2);

                for (const childCat of topCat.children) {
                    expect(childCat.level).toBe(2);
                    expect(childCat.parentId).toBe(topCat.id);
                }
            }
        });

        test("assigns products to categories correctly", () => {
            const generator = new BlueprintGenerator({
                topLevelCategories: 3,
                totalProducts: 90,
                productsPerBranch: 30,
            });

            const blueprint = generator.generateBlueprint("test", "test");

            // Each product should have:
            // - A primary category ID
            // - At least one category ID
            for (const product of blueprint.products) {
                expect(product.primaryCategoryId).toBeDefined();
                expect(product.categoryIds.length).toBeGreaterThanOrEqual(1);
                expect(product.categoryIds).toContain(product.primaryCategoryId);
            }

            // Count products per top-level category
            const productsPerBranch = new Map<string, number>();
            for (const product of blueprint.products) {
                const count = productsPerBranch.get(product.primaryCategoryId) || 0;
                productsPerBranch.set(product.primaryCategoryId, count + 1);
            }

            // Should have 30 products per branch
            for (const [, count] of productsPerBranch) {
                expect(count).toBe(30);
            }
        });

        test("generates product metadata correctly", () => {
            const generator = new BlueprintGenerator();
            const blueprint = generator.generateBlueprint("test", "test");

            for (const product of blueprint.products) {
                const meta = product.metadata;

                // Image count should be 1, 2, or 3
                expect([1, 2, 3]).toContain(meta.imageCount);
                expect(meta.imageDescriptions.length).toBe(meta.imageCount);

                // Review count should be valid
                expect([0, 1, 2, 3, 5, 8, 10]).toContain(meta.reviewCount);

                // Properties should be an empty array (filled during hydration)
                expect(meta.properties).toEqual([]);

                // Variant products have isVariant=true, but variantConfigs is now
                // filled during hydration (not during blueprint generation)
                // So we only check the isVariant flag here
                if (meta.isVariant) {
                    // variantConfigs should be undefined - filled during hydration
                    expect(meta.variantConfigs).toBeUndefined();
                }

                // If has sale price, should have percentage
                if (meta.hasSalesPrice) {
                    expect(meta.salePercentage).toBeDefined();
                    expect(meta.salePercentage).toBeGreaterThan(0);
                    expect(meta.salePercentage).toBeLessThanOrEqual(0.3);
                }
            }
        });

        test("generates valid UUIDs", () => {
            const generator = new BlueprintGenerator();
            const blueprint = generator.generateBlueprint("test", "test");

            // Check category UUIDs
            for (const cat of blueprint.categories) {
                expect(cat.id).toMatch(/^[0-9a-f]{32}$/);
            }

            // Check product UUIDs
            for (const product of blueprint.products) {
                expect(product.id).toMatch(/^[0-9a-f]{32}$/);
            }

            // Check for uniqueness
            const allIds = new Set<string>();
            for (const cat of blueprint.categories) {
                allIds.add(cat.id);
            }
            for (const product of blueprint.products) {
                allIds.add(product.id);
            }

            // All IDs should be unique
            expect(allIds.size).toBe(blueprint.categories.length + blueprint.products.length);
        });

        test("generates prices in valid range", () => {
            const generator = new BlueprintGenerator();
            const blueprint = generator.generateBlueprint("test", "test");

            for (const product of blueprint.products) {
                expect(product.price).toBeGreaterThanOrEqual(9.99);
                expect(product.price).toBeLessThanOrEqual(299.99);
                // Should be rounded to 2 decimal places
                expect(Math.round(product.price * 100) / 100).toBe(product.price);
            }
        });

        test("generates stock in valid range", () => {
            const generator = new BlueprintGenerator();
            const blueprint = generator.generateBlueprint("test", "test");

            for (const product of blueprint.products) {
                expect(product.stock).toBeGreaterThanOrEqual(0);
                expect(product.stock).toBeLessThanOrEqual(100);
                expect(Number.isInteger(product.stock)).toBe(true);
            }
        });

        test("generates category images for some categories", () => {
            const generator = new BlueprintGenerator({
                categoryImagePercentage: 1.0, // 100% of categories get images
            });

            const blueprint = generator.generateBlueprint("test", "test");

            // All categories should have hasImage = true with 100% percentage
            for (const cat of blueprint.categories) {
                expect(cat.hasImage).toBe(true);
            }
        });
    });
});
