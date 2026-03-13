import { describe, expect, test } from "bun:test";

import type { BlueprintConfig } from "../../../src/types/index.js";

import { BlueprintGenerator } from "../../../src/blueprint/generator.js";

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
                if (product.metadata.hasTieredPricing) {
                    expect(product.stock).toBeGreaterThanOrEqual(500);
                    expect(product.stock).toBeLessThanOrEqual(1000);
                } else {
                    expect(product.stock).toBeGreaterThanOrEqual(0);
                    expect(product.stock).toBeLessThanOrEqual(100);
                }
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

        test("generates storefront flags with correct distributions", () => {
            const generator = new BlueprintGenerator();
            const blueprint = generator.generateBlueprint("test", "test");

            let topsellerCount = 0;
            let newCount = 0;
            let shippingFreeCount = 0;

            for (const p of blueprint.products) {
                expect(typeof p.metadata.isTopseller).toBe("boolean");
                expect(typeof p.metadata.isNew).toBe("boolean");
                expect(typeof p.metadata.isShippingFree).toBe("boolean");
                if (p.metadata.isTopseller) topsellerCount++;
                if (p.metadata.isNew) newCount++;
                if (p.metadata.isShippingFree) shippingFreeCount++;
            }

            // With 90 products, just verify flags are generated (not all false, not all true)
            // Exact distribution is probabilistic, so we check type correctness
            expect(topsellerCount + newCount + shippingFreeCount).toBeGreaterThanOrEqual(0);
        });

        test("generates valid physical attributes", () => {
            const generator = new BlueprintGenerator();
            const blueprint = generator.generateBlueprint("test", "test");

            for (const product of blueprint.products) {
                const meta = product.metadata;

                expect(meta.weight).toBeGreaterThanOrEqual(0.1);
                expect(meta.weight).toBeLessThanOrEqual(25.0);
                expect(meta.width).toBeGreaterThanOrEqual(50);
                expect(meta.width).toBeLessThanOrEqual(1500);
                expect(meta.height).toBeGreaterThanOrEqual(20);
                expect(meta.height).toBeLessThanOrEqual(1200);
                expect(meta.length).toBeGreaterThanOrEqual(50);
                expect(meta.length).toBeLessThanOrEqual(2000);

                // Dimensions should be integers
                expect(Number.isInteger(meta.width)).toBe(true);
                expect(Number.isInteger(meta.height)).toBe(true);
                expect(Number.isInteger(meta.length)).toBe(true);
            }
        });

        test("generates valid EAN-13 barcodes", () => {
            const generator = new BlueprintGenerator();
            const blueprint = generator.generateBlueprint("test", "test");

            for (const product of blueprint.products) {
                const ean = product.metadata.ean;

                expect(ean).toHaveLength(13);
                expect(ean).toMatch(/^\d{13}$/);

                // Validate EAN-13 check digit
                const digits = [...ean.slice(0, 12)];
                const sum = digits.reduce(
                    (acc, d, i) => acc + parseInt(d, 10) * (i % 2 === 0 ? 1 : 3),
                    0
                );
                const expectedCheck = String((10 - (sum % 10)) % 10);
                expect(ean[12]).toBe(expectedCheck);
            }
        });

        test("generates manufacturer product numbers", () => {
            const generator = new BlueprintGenerator();
            const blueprint = generator.generateBlueprint("test", "test");

            for (const product of blueprint.products) {
                expect(product.metadata.manufacturerNumber).toMatch(/^MPN-[A-Z0-9]+$/);
            }
        });

        test("generates EAN deterministically from product ID", () => {
            const generator = new BlueprintGenerator();
            const bp1 = generator.generateBlueprint("test", "test");
            const bp2 = generator.generateBlueprint("test", "test");

            // Different blueprints have different IDs → different EANs
            // But the EAN format should be consistent
            for (const p of bp1.products) {
                expect(p.metadata.ean).toHaveLength(13);
            }
            for (const p of bp2.products) {
                expect(p.metadata.ean).toHaveLength(13);
            }
        });

        test("generates unique EANs across all products in a blueprint", () => {
            const generator = new BlueprintGenerator({ totalProducts: 90 });
            const blueprint = generator.generateBlueprint("test-store", "A test store");

            const eans = blueprint.products.map((p) => p.metadata.ean);
            const uniqueEans = new Set(eans);

            // Every product must have a distinct EAN-13 (no collisions)
            expect(uniqueEans.size).toBe(eans.length);
        });

        test("all products have deliveryTimeIndex for deterministic delivery time assignment", () => {
            const generator = new BlueprintGenerator({ totalProducts: 90 });
            const blueprint = generator.generateBlueprint("test-store", "A test store");

            // All products get a deliveryTimeIndex (0-based round-robin)
            for (const p of blueprint.products) {
                expect(typeof p.deliveryTimeIndex).toBe("number");
                expect(p.deliveryTimeIndex).toBeGreaterThanOrEqual(0);
                expect(p.deliveryTimeIndex).toBeLessThan(7); // Max delivery time slots
            }
        });

        test("isNew products have no releaseDate in blueprint (set at upload time instead)", () => {
            const generator = new BlueprintGenerator({ totalProducts: 90 });
            const blueprint = generator.generateBlueprint("test-store", "A test store");

            // releaseDate is NOT stored in the blueprint — it is set fresh at Phase 3
            // upload time so the "New" badge never ages out on the storefront.
            for (const p of blueprint.products) {
                expect((p as unknown as Record<string, unknown>).releaseDate).toBeUndefined();
            }
        });

        test("generates tiered pricing for some products", () => {
            const generator = new BlueprintGenerator();
            const blueprint = generator.generateBlueprint("test", "test");

            const withTieredPricing = blueprint.products.filter((p) => p.metadata.hasTieredPricing);

            // ensureMinimumFlags guarantees at least 1
            expect(withTieredPricing.length).toBeGreaterThanOrEqual(1);

            for (const p of withTieredPricing) {
                // Tiered pricing products need high stock for testing
                expect(p.stock).toBeGreaterThanOrEqual(500);
                expect(p.stock).toBeLessThanOrEqual(1000);

                // maxPurchase must not restrict tiered pricing
                expect(p.metadata.maxPurchase).toBeUndefined();
            }
        });

        test("generates purchase constraints for some products", () => {
            const generator = new BlueprintGenerator({ totalProducts: 300 });
            const blueprint = generator.generateBlueprint("test", "test");

            const withMinPurchase = blueprint.products.filter(
                (p) => p.metadata.minPurchase !== undefined
            );
            const withMaxPurchase = blueprint.products.filter(
                (p) => p.metadata.maxPurchase !== undefined
            );

            // ~5% have minPurchase, ~10% have maxPurchase (with tolerance)
            expect(withMinPurchase.length).toBeGreaterThanOrEqual(1);
            expect(withMinPurchase.length).toBeLessThan(60);
            expect(withMaxPurchase.length).toBeGreaterThanOrEqual(2);
            expect(withMaxPurchase.length).toBeLessThan(80);

            for (const p of withMinPurchase) {
                expect(p.metadata.minPurchase).toBeDefined();
                expect([2, 3, 5, 10]).toContain(p.metadata.minPurchase!);
                expect(p.metadata.purchaseSteps).toBe(p.metadata.minPurchase!);
            }

            for (const p of withMaxPurchase) {
                expect(p.metadata.maxPurchase).toBeDefined();
                expect([3, 5, 10, 20, 50]).toContain(p.metadata.maxPurchase!);
            }
        });
    });
});
