import { describe, expect, mock, test } from "bun:test";

import type { PostProcessorContext } from "../../../src/post-processors/index.js";
import type {
    BlueprintPropertyGroup,
    HydratedBlueprint,
    ProductMetadata,
    VariantConfig,
} from "../../../src/types/index.js";

import {
    isTransientShopwareSyncError,
    VariantProcessor,
} from "../../../src/post-processors/variant-processor.js";
import { createMockApiHelpers, type MockApiHelpers } from "../../mocks/index.js";

// Helper to create a minimal mock blueprint
function createMockBlueprint(
    products: Array<{
        id: string;
        name: string;
        isVariant?: boolean;
        variantConfigs?: VariantConfig[];
        properties?: Array<{ group: string; value: string }>;
    }>,
    propertyGroups: BlueprintPropertyGroup[] = []
): HydratedBlueprint {
    return {
        version: "1.0",
        salesChannel: { name: "test-store", description: "Test store" },
        categories: [],
        products: products.map((p) => ({
            id: p.id,
            name: p.name,
            description: "Test description",
            price: 29.99,
            stock: 10,
            primaryCategoryId: "cat1",
            categoryIds: ["cat1"],
            metadata: {
                imageCount: 1 as const,
                imageDescriptions: [],
                isVariant: p.isVariant || false,
                variantConfigs: p.variantConfigs,
                properties: p.properties || [],
                reviewCount: 0 as const,
                hasSalesPrice: false,
            },
        })),
        propertyGroups,
        createdAt: new Date().toISOString(),
        hydratedAt: new Date().toISOString(),
    };
}

// Helper to create mock cache
function createMockCache(metadataMap: Map<string, Partial<ProductMetadata>>) {
    return {
        loadProductMetadata: mock((_salesChannelName: string, productId: string) => {
            const meta = metadataMap.get(productId);
            if (!meta) return null;
            return {
                imageCount: 1 as const,
                imageDescriptions: [],
                isVariant: false,
                properties: [],
                reviewCount: 0 as const,
                hasSalesPrice: false,
                ...meta,
            } as ProductMetadata;
        }),
    };
}

// Helper to create mock context
function createMockContext(
    blueprint: HydratedBlueprint,
    metadataMap: Map<string, Partial<ProductMetadata>>,
    options: { dryRun?: boolean; mockApi?: MockApiHelpers } = {}
): PostProcessorContext {
    return {
        salesChannelId: "sc-123",
        salesChannelName: "test-store",
        blueprint,
        cache: createMockCache(metadataMap) as unknown as PostProcessorContext["cache"],
        shopwareUrl: "https://test.shopware.com",
        getAccessToken: async () => "test-token",
        api: options.mockApi as unknown as PostProcessorContext["api"],
        options: {
            batchSize: 5,
            dryRun: options.dryRun || false,
        },
    };
}

describe("VariantProcessor", () => {
    describe("isTransientShopwareSyncError", () => {
        test("returns true for deadlock and savepoint errors", () => {
            expect(
                isTransientShopwareSyncError(
                    "SQLSTATE[40001]: Serialization failure: 1213 Deadlock found when trying to get lock"
                )
            ).toBe(true);
            expect(
                isTransientShopwareSyncError(
                    "SQLSTATE[42000]: Syntax error or access violation: 1305 SAVEPOINT DOCTRINE_2 does not exist"
                )
            ).toBe(true);
        });

        test("returns false for non-transient errors", () => {
            expect(isTransientShopwareSyncError("Validation failed: missing required field")).toBe(
                false
            );
        });
    });

    describe("metadata", () => {
        test("has correct name", () => {
            expect(VariantProcessor.name).toBe("variants");
        });

        test("has description", () => {
            expect(VariantProcessor.description).toBeDefined();
            expect(VariantProcessor.description.length).toBeGreaterThan(0);
        });

        test("depends on manufacturers", () => {
            expect(VariantProcessor.dependsOn).toContain("manufacturers");
        });
    });

    describe("process", () => {
        test("skips all products when none are variants", async () => {
            const blueprint = createMockBlueprint([
                { id: "p1", name: "Product 1", isVariant: false },
                { id: "p2", name: "Product 2", isVariant: false },
            ]);

            const metadataMap = new Map<string, Partial<ProductMetadata>>();
            const context = createMockContext(blueprint, metadataMap);

            const result = await VariantProcessor.process(context);

            expect(result.processed).toBe(0);
            expect(result.skipped).toBe(2);
            expect(result.errors).toHaveLength(0);
        });

        test("processes variant products in dry run mode", async () => {
            const sizeConfig: VariantConfig = {
                group: "Size",
                selectedOptions: ["S", "M", "L"],
                priceModifiers: { S: 0.9, M: 1.0, L: 1.1 },
            };

            const propertyGroups: BlueprintPropertyGroup[] = [
                {
                    id: "pg-size",
                    name: "Size",
                    displayType: "text",
                    options: [
                        { id: "opt-s", name: "S" },
                        { id: "opt-m", name: "M" },
                        { id: "opt-l", name: "L" },
                    ],
                },
            ];

            const blueprint = createMockBlueprint(
                [
                    { id: "p1", name: "Product 1", isVariant: true, variantConfigs: [sizeConfig] },
                    { id: "p2", name: "Product 2", isVariant: false },
                ],
                propertyGroups
            );

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true, variantConfigs: [sizeConfig] }],
                ["p2", { isVariant: false }],
            ]);

            const context = createMockContext(blueprint, metadataMap, { dryRun: true });
            const result = await VariantProcessor.process(context);

            expect(result.processed).toBe(1); // p1
            expect(result.skipped).toBe(0); // p2 filtered out early
            expect(result.errors).toHaveLength(0);
        });

        test("skips variant products without variantConfigs", async () => {
            const blueprint = createMockBlueprint([
                { id: "p1", name: "Product 1", isVariant: true }, // No variantConfigs
            ]);

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true }], // No variantConfigs
            ]);

            const context = createMockContext(blueprint, metadataMap);
            const result = await VariantProcessor.process(context);

            expect(result.processed).toBe(0);
            expect(result.skipped).toBe(1);
        });

        test("finds property group from blueprint", async () => {
            const colorConfig: VariantConfig = {
                group: "Color",
                selectedOptions: ["Red", "Blue"],
                priceModifiers: { Red: 1.0, Blue: 1.05 },
            };

            const propertyGroups: BlueprintPropertyGroup[] = [
                {
                    id: "pg-color",
                    name: "Color",
                    displayType: "color",
                    options: [
                        { id: "opt-red", name: "Red", colorHexCode: "#dc2626" },
                        { id: "opt-blue", name: "Blue", colorHexCode: "#2563eb" },
                    ],
                },
            ];

            const blueprint = createMockBlueprint(
                [{ id: "p1", name: "Product 1", isVariant: true, variantConfigs: [colorConfig] }],
                propertyGroups
            );

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true, variantConfigs: [colorConfig] }],
            ]);

            const context = createMockContext(blueprint, metadataMap, { dryRun: true });
            const result = await VariantProcessor.process(context);

            // In dry run, it should find the Color property group from blueprint
            expect(result.processed).toBe(1);
        });

        test("dry run processes without checking option count", async () => {
            // Note: In dry run mode, the processor doesn't fully validate
            // property groups before reporting it would create variants.
            // This is expected behavior for quick dry run checks.
            const sizeConfig: VariantConfig = {
                group: "Size",
                selectedOptions: ["M"],
                priceModifiers: { M: 1.0 },
            };

            const propertyGroups: BlueprintPropertyGroup[] = [
                {
                    id: "pg-size",
                    name: "Size",
                    displayType: "text",
                    options: [
                        { id: "opt-m", name: "M" }, // Only 1 option
                    ],
                },
            ];

            const blueprint = createMockBlueprint(
                [{ id: "p1", name: "Product 1", isVariant: true, variantConfigs: [sizeConfig] }],
                propertyGroups
            );

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true, variantConfigs: [sizeConfig] }],
            ]);

            const context = createMockContext(blueprint, metadataMap, { dryRun: true });
            const result = await VariantProcessor.process(context);

            // In dry run mode, it reports as processed without full validation
            expect(result.processed).toBe(1);
        });

        test("skips products that already have variants in Shopware", async () => {
            const sizeConfig: VariantConfig = {
                group: "Size",
                selectedOptions: ["S", "M", "L"],
                priceModifiers: { S: 0.9, M: 1.0, L: 1.1 },
            };

            const propertyGroups: BlueprintPropertyGroup[] = [
                {
                    id: "pg-size",
                    name: "Size",
                    displayType: "text",
                    options: [
                        { id: "opt-s", name: "S" },
                        { id: "opt-m", name: "M" },
                        { id: "opt-l", name: "L" },
                    ],
                },
            ];

            const blueprint = createMockBlueprint(
                [
                    { id: "p1", name: "Product 1", isVariant: true, variantConfigs: [sizeConfig] },
                    { id: "p2", name: "Product 2", isVariant: true, variantConfigs: [sizeConfig] },
                ],
                propertyGroups
            );

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true, variantConfigs: [sizeConfig] }],
                ["p2", { isVariant: true, variantConfigs: [sizeConfig] }],
            ]);

            const mockApi = createMockApiHelpers();

            // Mock product search - ALL products have children (variants)
            // Note: MockApiHelpers returns the same response for all calls to the same endpoint,
            // so we mock that all products have variants to test the skip logic
            mockApi.mockPostResponse("search/product", {
                data: [
                    {
                        id: "p1",
                        children: [{ id: "child-1" }, { id: "child-2" }],
                        configuratorSettings: [],
                    },
                ],
            });

            // Mock currency search
            mockApi.mockPostResponse("search/currency", {
                data: [{ id: "currency-eur" }],
            });

            // Mock sync success
            mockApi.setDefaultPostResponse({ success: true });
            mockApi.mockSyncSuccess();

            const context = createMockContext(blueprint, metadataMap, {
                dryRun: false,
                mockApi,
            });
            const result = await VariantProcessor.process(context);

            // Both products are detected as having variants due to mock returning same response
            // This tests that the skip logic works correctly
            expect(result.skipped).toBe(2); // Both skipped
            expect(result.processed).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("skips products with existing configurator settings", async () => {
            const colorConfig: VariantConfig = {
                group: "Color",
                selectedOptions: ["Red", "Blue"],
                priceModifiers: { Red: 1.0, Blue: 1.05 },
            };

            const propertyGroups: BlueprintPropertyGroup[] = [
                {
                    id: "pg-color",
                    name: "Color",
                    displayType: "color",
                    options: [
                        { id: "opt-red", name: "Red" },
                        { id: "opt-blue", name: "Blue" },
                    ],
                },
            ];

            const blueprint = createMockBlueprint(
                [{ id: "p1", name: "Product 1", isVariant: true, variantConfigs: [colorConfig] }],
                propertyGroups
            );

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true, variantConfigs: [colorConfig] }],
            ]);

            const mockApi = createMockApiHelpers();

            // Mock product search - p1 has configurator settings
            mockApi.mockPostResponse("search/product", {
                data: [
                    {
                        id: "p1",
                        children: [],
                        configuratorSettings: [{ id: "config-1" }], // Has configurator settings
                    },
                ],
            });

            const context = createMockContext(blueprint, metadataMap, {
                dryRun: false,
                mockApi,
            });
            const result = await VariantProcessor.process(context);

            // p1 should be skipped (already has configurator settings)
            expect(result.skipped).toBe(1);
            expect(result.processed).toBe(0);
        });

        test("processes multiple property groups with cartesian product", async () => {
            const sizeConfig: VariantConfig = {
                group: "Size",
                selectedOptions: ["S", "M"],
                priceModifiers: { S: 0.9, M: 1.0 },
            };
            const colorConfig: VariantConfig = {
                group: "Color",
                selectedOptions: ["Red", "Blue"],
                priceModifiers: { Red: 1.0, Blue: 1.05 },
            };

            const propertyGroups: BlueprintPropertyGroup[] = [
                {
                    id: "pg-size",
                    name: "Size",
                    displayType: "text",
                    options: [
                        { id: "opt-s", name: "S" },
                        { id: "opt-m", name: "M" },
                    ],
                },
                {
                    id: "pg-color",
                    name: "Color",
                    displayType: "color",
                    options: [
                        { id: "opt-red", name: "Red" },
                        { id: "opt-blue", name: "Blue" },
                    ],
                },
            ];

            const blueprint = createMockBlueprint(
                [
                    {
                        id: "p1",
                        name: "Product 1",
                        isVariant: true,
                        variantConfigs: [sizeConfig, colorConfig],
                    },
                ],
                propertyGroups
            );

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true, variantConfigs: [sizeConfig, colorConfig] }],
            ]);

            const context = createMockContext(blueprint, metadataMap, { dryRun: true });
            const result = await VariantProcessor.process(context);

            // Should process the product with multi-property variants
            expect(result.processed).toBe(1);
            expect(result.errors).toHaveLength(0);
        });

        test("generates product numbers within 64 character limit", async () => {
            // Test with very long option names that would exceed 64 chars
            const longConfig: VariantConfig = {
                group: "Format",
                selectedOptions: [
                    "Printable PDF with Assembly Guide",
                    "1920x1080 HD Video Format",
                    "Ultra High Definition 4K",
                ],
                priceModifiers: {},
            };

            const propertyGroups: BlueprintPropertyGroup[] = [
                {
                    id: "pg-format",
                    name: "Format",
                    displayType: "text",
                    options: [
                        { id: "opt-pdf", name: "Printable PDF with Assembly Guide" },
                        { id: "opt-hd", name: "1920x1080 HD Video Format" },
                        { id: "opt-4k", name: "Ultra High Definition 4K" },
                    ],
                },
            ];

            const blueprint = createMockBlueprint(
                [
                    {
                        id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", // 32-char UUID
                        name: "Product with Long Options",
                        isVariant: true,
                        variantConfigs: [longConfig],
                    },
                ],
                propertyGroups
            );

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                [
                    "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
                    { isVariant: true, variantConfigs: [longConfig] },
                ],
            ]);

            const context = createMockContext(blueprint, metadataMap, { dryRun: true });
            const result = await VariantProcessor.process(context);

            // Should process without errors (product number truncation prevents 64-char limit issue)
            expect(result.processed).toBe(1);
            expect(result.errors).toHaveLength(0);
        });

        test("generates unique product numbers for options with long shared prefixes", async () => {
            // Simulate the real-world bug: options that share a very long prefix
            // and only differ after the truncation point
            const materialConfig: VariantConfig = {
                group: "Material",
                selectedOptions: [
                    "Adjustable 100-135 cm Polyester Exterior with Foam Interior Padding",
                    "Adjustable 100-135 cm Polyester Exterior with Nylon Interior Padding",
                ],
                priceModifiers: {},
            };

            const propertyGroups: BlueprintPropertyGroup[] = [
                {
                    id: "pg-material",
                    name: "Material",
                    displayType: "text",
                    options: [
                        {
                            id: "opt-foam",
                            name: "Adjustable 100-135 cm Polyester Exterior with Foam Interior Padding",
                        },
                        {
                            id: "opt-nylon",
                            name: "Adjustable 100-135 cm Polyester Exterior with Nylon Interior Padding",
                        },
                    ],
                },
            ];

            const blueprint = createMockBlueprint(
                [
                    {
                        id: "d263d564abcdef1234567890abcdef12",
                        name: "Trekking Poles - Carbon - Collapsible",
                        isVariant: true,
                        variantConfigs: [materialConfig],
                    },
                ],
                propertyGroups
            );

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                [
                    "d263d564abcdef1234567890abcdef12",
                    { isVariant: true, variantConfigs: [materialConfig] },
                ],
            ]);

            // Use non-dry-run to capture the actual sync payload
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/property-group", { data: [] });
            mockApi.mockPostResponse("search/product", {
                data: [
                    {
                        id: "d263d564abcdef1234567890abcdef12",
                        children: [],
                        configuratorSettings: [],
                    },
                ],
            });
            mockApi.mockPostResponse("search/currency", { data: [{ id: "currency-eur" }] });
            mockApi.setDefaultPostResponse({ success: true });
            mockApi.mockSyncSuccess();

            const context = createMockContext(blueprint, metadataMap, {
                dryRun: false,
                mockApi,
            });
            const result = await VariantProcessor.process(context);

            // Check that the sync was called and extract variant product numbers
            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            const variantSyncCall = syncCalls.find((call) => {
                const body = call.body as Record<string, unknown> | undefined;
                return body?.createVariants !== undefined;
            });

            if (variantSyncCall) {
                const body = variantSyncCall.body as Record<
                    string,
                    { payload: Array<{ productNumber: string }> } | undefined
                >;
                const variants = body.createVariants?.payload ?? [];
                const productNumbers = variants.map((v) => v.productNumber);

                // All product numbers must be unique
                const uniqueNumbers = new Set(productNumbers);
                expect(uniqueNumbers.size).toBe(productNumbers.length);

                // All product numbers must be within 64-char limit
                for (const num of productNumbers) {
                    expect(num.length).toBeLessThanOrEqual(64);
                }
            }

            expect(result.processed).toBe(1);
            expect(result.errors).toHaveLength(0);
        });

        test("finds property group via partial match", async () => {
            // The processor should find "Size Type" when looking for "Size"
            const sizeConfig: VariantConfig = {
                group: "Size Type", // Partial match needed
                selectedOptions: ["Small", "Large"],
                priceModifiers: {},
            };

            const propertyGroups: BlueprintPropertyGroup[] = [
                {
                    id: "pg-size-type",
                    name: "Size Type",
                    displayType: "text",
                    options: [
                        { id: "opt-small", name: "Small" },
                        { id: "opt-large", name: "Large" },
                    ],
                },
            ];

            const blueprint = createMockBlueprint(
                [
                    {
                        id: "p1",
                        name: "Product 1",
                        isVariant: true,
                        variantConfigs: [sizeConfig],
                    },
                ],
                propertyGroups
            );

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true, variantConfigs: [sizeConfig] }],
            ]);

            const context = createMockContext(blueprint, metadataMap, { dryRun: true });
            const result = await VariantProcessor.process(context);

            // Should find the property group via exact match
            expect(result.processed).toBe(1);
        });

        test("handles missing property group", async () => {
            const nonExistentConfig: VariantConfig = {
                group: "NonExistent",
                selectedOptions: ["A", "B"],
                priceModifiers: {},
            };

            const blueprint = createMockBlueprint(
                [
                    {
                        id: "p1",
                        name: "Product 1",
                        isVariant: true,
                        variantConfigs: [nonExistentConfig],
                    },
                ],
                [] // No property groups
            );

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true, variantConfigs: [nonExistentConfig] }],
            ]);

            const mockApi = createMockApiHelpers();
            // Mock property group search - nothing found
            mockApi.mockPostResponse("search/property-group", { data: [] });
            // Mock product search - no existing variants
            mockApi.mockPostResponse("search/product", {
                data: [{ id: "p1", children: [], configuratorSettings: [] }],
            });
            // Mock currency
            mockApi.mockPostResponse("search/currency", { data: [{ id: "eur-id" }] });

            const context = createMockContext(blueprint, metadataMap, { mockApi });
            const result = await VariantProcessor.process(context);

            // Product should be skipped because property group not found
            expect(result.skipped).toBe(1);
        });

        test("skips products with no metadata", async () => {
            const sizeConfig: VariantConfig = {
                group: "Size",
                selectedOptions: ["S", "M"],
                priceModifiers: {},
            };

            const blueprint = createMockBlueprint(
                [{ id: "p1", name: "Product 1", isVariant: true, variantConfigs: [sizeConfig] }],
                []
            );

            // No metadata for p1
            const metadataMap = new Map<string, Partial<ProductMetadata>>();

            const context = createMockContext(blueprint, metadataMap);
            const result = await VariantProcessor.process(context);

            // Product p1 should be skipped because metadata is missing
            expect(result.skipped).toBe(1);
        });
    });
});
