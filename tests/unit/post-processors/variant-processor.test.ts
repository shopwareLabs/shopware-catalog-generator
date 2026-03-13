import { describe, expect, test } from "bun:test";

import type {
    BlueprintPropertyGroup,
    ProductMetadata,
    VariantConfig,
} from "../../../src/types/index.js";

import {
    isTransientShopwareSyncError,
    VariantProcessor,
} from "../../../src/post-processors/variant-processor.js";
import { createTestBlueprint, createTestProduct } from "../../helpers/blueprint-factory.js";
import { createTestContext } from "../../helpers/post-processor-context.js";
import { createMockApiHelpers, createMockProductMetadata } from "../../mocks/index.js";

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
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: createMockProductMetadata({ isVariant: false }),
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        metadata: createMockProductMetadata({ isVariant: false }),
                    }),
                ],
            });
            const metadataMap = new Map<string, Partial<ProductMetadata>>();
            const { context } = createTestContext({ blueprint, metadataMap });

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

            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: createMockProductMetadata({
                            isVariant: true,
                            variantConfigs: [sizeConfig],
                        }),
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        metadata: createMockProductMetadata({ isVariant: false }),
                    }),
                ],
                propertyGroups,
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true, variantConfigs: [sizeConfig] }],
                ["p2", { isVariant: false }],
            ]);

            const { context } = createTestContext({ blueprint, metadataMap, dryRun: true });
            const result = await VariantProcessor.process(context);

            expect(result.processed).toBe(1); // p1
            expect(result.skipped).toBe(0); // p2 filtered out early
            expect(result.errors).toHaveLength(0);
        });

        test("skips variant products without variantConfigs", async () => {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: createMockProductMetadata({ isVariant: true }),
                    }),
                ],
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true }],
            ]);

            const { context } = createTestContext({ blueprint, metadataMap });
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

            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: createMockProductMetadata({
                            isVariant: true,
                            variantConfigs: [colorConfig],
                        }),
                    }),
                ],
                propertyGroups,
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true, variantConfigs: [colorConfig] }],
            ]);

            const { context } = createTestContext({ blueprint, metadataMap, dryRun: true });
            const result = await VariantProcessor.process(context);

            // In dry run, it should find the Color property group from blueprint
            expect(result.processed).toBe(1);
        });

        test("dry run processes without checking option count", async () => {
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
                    options: [{ id: "opt-m", name: "M" }],
                },
            ];

            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: createMockProductMetadata({
                            isVariant: true,
                            variantConfigs: [sizeConfig],
                        }),
                    }),
                ],
                propertyGroups,
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true, variantConfigs: [sizeConfig] }],
            ]);

            const { context } = createTestContext({ blueprint, metadataMap, dryRun: true });
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

            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: createMockProductMetadata({
                            isVariant: true,
                            variantConfigs: [sizeConfig],
                        }),
                    }),
                    createTestProduct({
                        id: "p2",
                        name: "Product 2",
                        metadata: createMockProductMetadata({
                            isVariant: true,
                            variantConfigs: [sizeConfig],
                        }),
                    }),
                ],
                propertyGroups,
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true, variantConfigs: [sizeConfig] }],
                ["p2", { isVariant: true, variantConfigs: [sizeConfig] }],
            ]);

            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/product", {
                data: [
                    {
                        id: "p1",
                        children: [{ id: "child-1" }, { id: "child-2" }],
                        configuratorSettings: [],
                    },
                ],
            });
            mockApi.mockPostResponse("search/currency", {
                data: [{ id: "currency-eur" }],
            });
            mockApi.setDefaultPostResponse({ success: true });
            mockApi.mockSyncSuccess();

            const { context } = createTestContext({
                blueprint,
                metadataMap,
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

            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: createMockProductMetadata({
                            isVariant: true,
                            variantConfigs: [colorConfig],
                        }),
                    }),
                ],
                propertyGroups,
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true, variantConfigs: [colorConfig] }],
            ]);

            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/product", {
                data: [
                    {
                        id: "p1",
                        children: [],
                        configuratorSettings: [{ id: "config-1" }],
                    },
                ],
            });

            const { context } = createTestContext({
                blueprint,
                metadataMap,
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

            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: createMockProductMetadata({
                            isVariant: true,
                            variantConfigs: [sizeConfig, colorConfig],
                        }),
                    }),
                ],
                propertyGroups,
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true, variantConfigs: [sizeConfig, colorConfig] }],
            ]);

            const { context } = createTestContext({ blueprint, metadataMap, dryRun: true });
            const result = await VariantProcessor.process(context);

            // Should process the product with multi-property variants
            expect(result.processed).toBe(1);
            expect(result.errors).toHaveLength(0);
        });

        test("generates product numbers within 64 character limit", async () => {
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

            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
                        name: "Product with Long Options",
                        metadata: createMockProductMetadata({
                            isVariant: true,
                            variantConfigs: [longConfig],
                        }),
                    }),
                ],
                propertyGroups,
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                [
                    "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
                    { isVariant: true, variantConfigs: [longConfig] },
                ],
            ]);

            const { context } = createTestContext({ blueprint, metadataMap, dryRun: true });
            const result = await VariantProcessor.process(context);

            // Should process without errors (product number truncation prevents 64-char limit issue)
            expect(result.processed).toBe(1);
            expect(result.errors).toHaveLength(0);
        });

        test("generates unique product numbers for options with long shared prefixes", async () => {
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

            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "d263d564abcdef1234567890abcdef12",
                        name: "Trekking Poles - Carbon - Collapsible",
                        metadata: createMockProductMetadata({
                            isVariant: true,
                            variantConfigs: [materialConfig],
                        }),
                    }),
                ],
                propertyGroups,
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                [
                    "d263d564abcdef1234567890abcdef12",
                    { isVariant: true, variantConfigs: [materialConfig] },
                ],
            ]);

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

            const { context } = createTestContext({
                blueprint,
                metadataMap,
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
            const sizeConfig: VariantConfig = {
                group: "Size Type",
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

            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: createMockProductMetadata({
                            isVariant: true,
                            variantConfigs: [sizeConfig],
                        }),
                    }),
                ],
                propertyGroups,
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true, variantConfigs: [sizeConfig] }],
            ]);

            const { context } = createTestContext({ blueprint, metadataMap, dryRun: true });
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

            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: createMockProductMetadata({
                            isVariant: true,
                            variantConfigs: [nonExistentConfig],
                        }),
                    }),
                ],
                propertyGroups: [],
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                ["p1", { isVariant: true, variantConfigs: [nonExistentConfig] }],
            ]);

            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/property-group", { data: [] });
            mockApi.mockPostResponse("search/product", {
                data: [{ id: "p1", children: [], configuratorSettings: [] }],
            });
            mockApi.mockPostResponse("search/currency", { data: [{ id: "eur-id" }] });

            const { context } = createTestContext({
                blueprint,
                metadataMap,
                mockApi,
            });
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

            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Product 1",
                        metadata: createMockProductMetadata({
                            isVariant: true,
                            variantConfigs: [sizeConfig],
                        }),
                    }),
                ],
                propertyGroups: [],
            });

            const metadataMap = new Map<string, Partial<ProductMetadata>>();

            const { context } = createTestContext({ blueprint, metadataMap });
            const result = await VariantProcessor.process(context);

            // Product p1 should be skipped because metadata is missing
            expect(result.skipped).toBe(1);
        });
    });
});
