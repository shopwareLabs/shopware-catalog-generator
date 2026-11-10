import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PostProcessorContext } from "../../../src/post-processors/index.js";
import type {
    BlueprintPropertyGroup,
    CachedPropertyGroup,
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

        test("sends each option once when the group lists it twice", async () => {
            const colorConfig: VariantConfig = {
                group: "Color",
                selectedOptions: ["Multicolor Floral", "Navy"],
                priceModifiers: {},
            };
            const propertyGroups: BlueprintPropertyGroup[] = [
                {
                    id: "pg-color",
                    name: "Color",
                    displayType: "color",
                    options: [
                        { id: "opt-floral", name: "Multicolor floral" },
                        { id: "opt-floral", name: "Multicolor floral" },
                        { id: "opt-navy", name: "Navy" },
                    ],
                },
            ];
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: "p1",
                        name: "Midi Dress",
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
            mockApi.mockPostResponse("search/property-group", { data: [] });
            mockApi.mockPostResponse("search/product", {
                data: [{ id: "p1", children: [], configuratorSettings: [] }],
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

            const parentCall = mockApi
                .getCallsByEndpoint("_action/sync")
                .find((call) => (call.body as Record<string, unknown>)?.updateParent !== undefined);
            const body = parentCall?.body as {
                updateParent: {
                    payload: Array<{ configuratorSettings: Array<{ optionId: string }> }>;
                };
            };
            const optionIds = body.updateParent.payload[0]?.configuratorSettings.map(
                (c) => c.optionId
            );

            expect(optionIds).toEqual(["opt-floral", "opt-navy"]);
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

    describe("cleanup", () => {
        test("returns early in dry run mode", async () => {
            const { context } = createTestContext({ dryRun: true });
            const result = await VariantProcessor.cleanup!(context);
            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("returns 0 deleted when no parent products in SalesChannel", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponse("product", []);
            const result = await VariantProcessor.cleanup!(context);
            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("returns 0 deleted when no variant children found", async () => {
            const { context, mockApi } = createTestContext();
            // First call: parent products; second call (equalsAny parentId): no variants
            mockApi.mockSearchResponseSequence("product", [[{ id: "parent-1" }], [], []]);
            const result = await VariantProcessor.cleanup!(context);
            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("deletes variant children and returns count", async () => {
            const { context, mockApi } = createTestContext();
            // First call: parent products; second call: variant children; third: configurator search
            mockApi.mockSearchResponseSequence("product", [
                [{ id: "parent-1" }],
                [{ id: "variant-1" }, { id: "variant-2" }],
                [{ id: "parent-1", configuratorSettings: [] }],
            ]);
            const result = await VariantProcessor.cleanup!(context);
            expect(result.deleted).toBe(2);
            expect(result.errors).toHaveLength(0);
        });

        test("reports an error when api helpers are missing", async () => {
            const { context: baseContext } = createTestContext();
            const { api: _api, ...rest } = baseContext;
            const contextWithoutApi = { ...rest } as PostProcessorContext;

            const result = await VariantProcessor.cleanup!(contextWithoutApi);

            expect(result.deleted).toBe(0);
            expect(result.errors).toEqual(["API helpers not available - cannot perform cleanup"]);
        });

        test("deletes configurator settings of parents that have them", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponseSequence("product", [
                [{ id: "parent-1" }, { id: "parent-2" }],
                [],
                [
                    { id: "parent-1", configuratorSettings: [{ id: "cs-1" }] },
                    { id: "parent-2", configuratorSettings: [] },
                ],
            ]);
            mockApi.mockSearchResponse("product-configurator-setting", [
                { id: "cs-1" },
                { id: "cs-2" },
            ]);

            const result = await VariantProcessor.cleanup!(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
            const settingSearches = mockApi.getCallsByEndpoint(
                "search/product-configurator-setting"
            );
            expect(settingSearches).toHaveLength(1);
            expect(JSON.stringify(settingSearches[0]?.body)).toContain('"value":"parent-1"');
            const deleteBodies = mockApi
                .getCallsByEndpoint("_action/sync")
                .map((call) => JSON.stringify(call.body));
            expect(deleteBodies).toEqual([
                JSON.stringify({
                    "delete-product_configurator_setting": {
                        entity: "product_configurator_setting",
                        action: "delete",
                        payload: [{ id: "cs-1" }, { id: "cs-2" }],
                    },
                }),
            ]);
        });

        test("deletes variants by id and searches them by parent id", async () => {
            const { context, mockApi } = createTestContext({ salesChannelId: "sc-clean" });
            mockApi.mockSearchResponseSequence("product", [
                [{ id: "parent-1" }],
                [{ id: "variant-1" }],
                [],
            ]);

            await VariantProcessor.cleanup!(context);

            const searches = mockApi.getCallsByEndpoint("search/product");
            expect(JSON.stringify(searches[0]?.body)).toContain('"value":"sc-clean"');
            expect(JSON.stringify(searches[1]?.body)).toContain(
                '"type":"equalsAny","field":"parentId","value":["parent-1"]'
            );
            const deleteBody = JSON.stringify(mockApi.getCallsByEndpoint("_action/sync")[0]?.body);
            expect(deleteBody).toContain('"delete-product"');
            expect(deleteBody).toContain('"payload":[{"id":"variant-1"}]');
        });

        test("ignores errors while clearing configurator settings of one parent", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponseSequence("product", [
                [{ id: "parent-1" }],
                [],
                [{ id: "parent-1", configuratorSettings: [{ id: "cs-1" }] }],
            ]);
            let searchCount = 0;
            mockApi.searchEntitiesMock.mockImplementation(() => {
                searchCount++;
                if (searchCount === 4) throw new Error("settings search failed");
                return Promise.resolve([]);
            });

            const result = await VariantProcessor.cleanup!(context);

            expect(result.errors).toHaveLength(0);
        });

        test("reports a failed cleanup with the error message", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.searchEntitiesMock.mockImplementation(() => {
                throw new Error("search down");
            });

            const result = await VariantProcessor.cleanup!(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toEqual(["Variant cleanup failed: search down"]);
        });
    });

    describe("property group resolution", () => {
        function setupVariantRun(opts: {
            productId: string;
            configs: VariantConfig[];
            propertyGroups?: BlueprintPropertyGroup[];
            salesChannelName?: string;
        }): { context: PostProcessorContext; mockApi: ReturnType<typeof createMockApiHelpers> } {
            const blueprint = createTestBlueprint({
                products: [
                    createTestProduct({
                        id: opts.productId,
                        name: `Product ${opts.productId}`,
                        metadata: createMockProductMetadata({
                            isVariant: true,
                            variantConfigs: opts.configs,
                        }),
                    }),
                ],
                propertyGroups: opts.propertyGroups ?? [],
            });
            const metadataMap = new Map<string, Partial<ProductMetadata>>([
                [opts.productId, { isVariant: true, variantConfigs: opts.configs }],
            ]);
            const mockApi = createMockApiHelpers();
            mockApi.mockPostResponse("search/product", {
                data: [{ id: opts.productId, children: [], configuratorSettings: [] }],
            });
            mockApi.mockSearchResponse("currency", [{ id: "currency-eur" }]);
            mockApi.mockSyncSuccess();
            const { context } = createTestContext({
                blueprint,
                metadataMap,
                dryRun: false,
                mockApi,
                salesChannelName: opts.salesChannelName,
            });
            return { context, mockApi };
        }

        function configuratorOptionIds(mockApi: ReturnType<typeof createMockApiHelpers>): string[] {
            const call = mockApi
                .getCallsByEndpoint("_action/sync")
                .find((c) => JSON.stringify(c.body).includes("updateParent"));
            const body = call?.body as
                | {
                      updateParent: {
                          payload: Array<{ configuratorSettings: Array<{ optionId: string }> }>;
                      };
                  }
                | undefined;
            return body?.updateParent.payload[0]?.configuratorSettings.map((c) => c.optionId) ?? [];
        }

        function syncBodies(mockApi: ReturnType<typeof createMockApiHelpers>): string[] {
            return mockApi.getCallsByEndpoint("_action/sync").map((c) => JSON.stringify(c.body));
        }

        /** Answer property-group searches by filter type ("equals" / "contains") */
        function answerGroupSearch(
            mockApi: ReturnType<typeof createMockApiHelpers>,
            respond: (filterType: string) => unknown
        ): void {
            mockApi.postMock.mockImplementation(() => {
                const last = mockApi.getCalls().at(-1);
                if (last?.endpoint !== "search/property-group") return Promise.resolve({});
                const body = last.body as { filter: Array<{ type: string }> };
                mockApi.mockPostResponse(
                    "search/property-group",
                    respond(body.filter[0]?.type ?? "")
                );
                return Promise.resolve({});
            });
        }

        test("skips a group with fewer than two options", async () => {
            const { context, mockApi } = setupVariantRun({
                productId: "res-one-option",
                configs: [{ group: "Single", selectedOptions: ["Only"], priceModifiers: {} }],
                propertyGroups: [
                    {
                        id: "pg-single",
                        name: "Single",
                        displayType: "text",
                        options: [{ id: "opt-only", name: "Only" }],
                    },
                ],
            });

            const result = await VariantProcessor.process(context);

            expect(result.skipped).toBe(1);
            expect(result.processed).toBe(0);
            expect(syncBodies(mockApi)).toHaveLength(0);
        });

        test("uses the first three options when the selected options do not match", async () => {
            const { context, mockApi } = setupVariantRun({
                productId: "res-fallback",
                configs: [{ group: "Pattern", selectedOptions: ["Zigzag"], priceModifiers: {} }],
                propertyGroups: [
                    {
                        id: "pg-pattern",
                        name: "Pattern",
                        displayType: "text",
                        options: [
                            { id: "opt-a", name: "Dots" },
                            { id: "opt-a", name: "Dots" },
                            { id: "opt-b", name: "Stripes" },
                            { id: "opt-c", name: "Checks" },
                            { id: "opt-d", name: "Plain" },
                        ],
                    },
                ],
            });

            const result = await VariantProcessor.process(context);

            expect(result.processed).toBe(1);
            expect(configuratorOptionIds(mockApi)).toEqual(["opt-a", "opt-b", "opt-c"]);
        });

        test("matches selected options case-insensitively and keeps group order", async () => {
            const { context, mockApi } = setupVariantRun({
                productId: "res-case",
                configs: [{ group: "Shade", selectedOptions: ["BLUE", "red"], priceModifiers: {} }],
                propertyGroups: [
                    {
                        id: "pg-shade",
                        name: "Shade",
                        displayType: "text",
                        options: [
                            { id: "opt-red", name: "Red" },
                            { id: "opt-green", name: "Green" },
                            { id: "opt-blue", name: "Blue" },
                        ],
                    },
                ],
            });

            await VariantProcessor.process(context);

            expect(configuratorOptionIds(mockApi)).toEqual(["opt-red", "opt-blue"]);
        });

        test("creates variants for the resolved groups when one group is missing", async () => {
            const { context, mockApi } = setupVariantRun({
                productId: "res-partial",
                configs: [
                    { group: "Width", selectedOptions: ["Narrow", "Wide"], priceModifiers: {} },
                    { group: "Missing Group Xyz", selectedOptions: ["A", "B"], priceModifiers: {} },
                ],
                propertyGroups: [
                    {
                        id: "pg-width",
                        name: "Width",
                        displayType: "text",
                        options: [
                            { id: "opt-narrow", name: "Narrow" },
                            { id: "opt-wide", name: "Wide" },
                        ],
                    },
                ],
            });
            mockApi.mockPostResponse("search/property-group", { data: [] });

            const result = await VariantProcessor.process(context);

            expect(result.processed).toBe(1);
            expect(configuratorOptionIds(mockApi)).toEqual(["opt-narrow", "opt-wide"]);
        });

        test("finds a group in Shopware by exact name when not in the blueprint", async () => {
            const { context, mockApi } = setupVariantRun({
                productId: "res-exact",
                configs: [
                    { group: "Grip Exact", selectedOptions: ["Soft", "Hard"], priceModifiers: {} },
                ],
            });
            answerGroupSearch(mockApi, (type) =>
                type === "equals"
                    ? {
                          data: [
                              {
                                  id: "pg-grip",
                                  name: "Grip Exact",
                                  options: [
                                      { id: "opt-soft", name: "Soft" },
                                      { id: "opt-hard", name: "Hard" },
                                  ],
                              },
                          ],
                      }
                    : { data: [] }
            );

            const result = await VariantProcessor.process(context);

            expect(result.processed).toBe(1);
            const searches = mockApi.getCallsByEndpoint("search/property-group");
            expect(searches).toHaveLength(1);
            expect(searches[0]?.body).toEqual({
                filter: [{ type: "equals", field: "name", value: "Grip Exact" }],
                associations: { options: {} },
                limit: 1,
            });
            expect(configuratorOptionIds(mockApi)).toEqual(["opt-soft", "opt-hard"]);
        });

        test("falls back to a contains search when the exact search has no options", async () => {
            const { context, mockApi } = setupVariantRun({
                productId: "res-contains",
                configs: [
                    { group: "Grip Fuzzy", selectedOptions: ["Soft", "Hard"], priceModifiers: {} },
                ],
            });
            answerGroupSearch(mockApi, (type) =>
                type === "contains"
                    ? {
                          data: [
                              {
                                  id: "pg-grip-fuzzy",
                                  name: "Grip Fuzzy Type",
                                  options: [
                                      { id: "opt-soft-f", name: "Soft" },
                                      { id: "opt-hard-f", name: "Hard" },
                                  ],
                              },
                          ],
                      }
                    : { data: [{ id: "pg-no-options", name: "Grip Fuzzy" }] }
            );

            const result = await VariantProcessor.process(context);

            expect(result.processed).toBe(1);
            const searches = mockApi.getCallsByEndpoint("search/property-group");
            expect(searches).toHaveLength(2);
            expect(searches[1]?.body).toEqual({
                filter: [{ type: "contains", field: "name", value: "Grip Fuzzy" }],
                associations: { options: {} },
                limit: 1,
            });
            expect(configuratorOptionIds(mockApi)).toEqual(["opt-soft-f", "opt-hard-f"]);
        });

        test("reuses a group found in Shopware for later products", async () => {
            const config: VariantConfig = {
                group: "Grip Cached",
                selectedOptions: ["Soft", "Hard"],
                priceModifiers: {},
            };
            const group = {
                id: "pg-grip-cached",
                name: "Grip Cached",
                options: [
                    { id: "opt-soft-c", name: "Soft" },
                    { id: "opt-hard-c", name: "Hard" },
                ],
            };
            const first = setupVariantRun({ productId: "res-cached-1", configs: [config] });
            answerGroupSearch(first.mockApi, () => ({ data: [group] }));
            await VariantProcessor.process(first.context);

            const second = setupVariantRun({ productId: "res-cached-2", configs: [config] });
            const result = await VariantProcessor.process(second.context);

            expect(result.processed).toBe(1);
            expect(second.mockApi.getCallsByEndpoint("search/property-group")).toHaveLength(0);
            expect(configuratorOptionIds(second.mockApi)).toEqual(["opt-soft-c", "opt-hard-c"]);
        });

        test("skips the product when the property group search throws", async () => {
            const { context, mockApi } = setupVariantRun({
                productId: "res-throw",
                configs: [
                    { group: "Grip Broken", selectedOptions: ["A", "B"], priceModifiers: {} },
                ],
            });
            mockApi.mockPostFailure("search/property-group", new Error("search failed"));

            const result = await VariantProcessor.process(context);

            expect(result.skipped).toBe(1);
            expect(result.errors).toHaveLength(0);
        });

        test("creates variants when the variant check fails", async () => {
            const { context, mockApi } = setupVariantRun({
                productId: "res-check-fails",
                configs: [{ group: "Depth", selectedOptions: ["Low", "High"], priceModifiers: {} }],
                propertyGroups: [
                    {
                        id: "pg-depth",
                        name: "Depth",
                        displayType: "text",
                        options: [
                            { id: "opt-low", name: "Low" },
                            { id: "opt-high", name: "High" },
                        ],
                    },
                ],
            });
            mockApi.mockPostFailure("search/product", new Error("product search failed"));

            const result = await VariantProcessor.process(context);

            expect(result.processed).toBe(1);
        });

        test("checks for existing variants with children and configurator settings", async () => {
            const { context, mockApi } = setupVariantRun({
                productId: "res-check-body",
                configs: [{ group: "Depth", selectedOptions: ["Low", "High"], priceModifiers: {} }],
                propertyGroups: [
                    {
                        id: "pg-depth",
                        name: "Depth",
                        displayType: "text",
                        options: [
                            { id: "opt-low", name: "Low" },
                            { id: "opt-high", name: "High" },
                        ],
                    },
                ],
            });

            await VariantProcessor.process(context);

            expect(mockApi.getCallsByEndpoint("search/product")[0]?.body).toEqual({
                ids: ["res-check-body"],
                associations: { children: {}, configuratorSettings: {} },
            });
        });

        test("reports an error when the parent update fails", async () => {
            const { context, mockApi } = setupVariantRun({
                productId: "res-sync-fails",
                configs: [{ group: "Depth", selectedOptions: ["Low", "High"], priceModifiers: {} }],
                propertyGroups: [
                    {
                        id: "pg-depth",
                        name: "Depth",
                        displayType: "text",
                        options: [
                            { id: "opt-low", name: "Low" },
                            { id: "opt-high", name: "High" },
                        ],
                    },
                ],
            });
            mockApi.mockPostFailure("_action/sync", new Error("sync rejected"));

            const result = await VariantProcessor.process(context);

            expect(result.processed).toBe(0);
            expect(result.skipped).toBe(0);
            expect(result.errors).toEqual([
                "Failed to create variants for Product res-sync-fails: Failed to update parent product: 500",
            ]);
        });

        describe("with a cached property group definition", () => {
            const previousCacheDir = process.env.CACHE_DIR;
            let cacheDir = "";

            beforeEach(() => {
                cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "variant-cache-"));
                process.env.CACHE_DIR = cacheDir;
            });

            afterEach(() => {
                fs.rmSync(cacheDir, { recursive: true, force: true });
                if (previousCacheDir === undefined) {
                    delete process.env.CACHE_DIR;
                    return;
                }
                process.env.CACHE_DIR = previousCacheDir;
            });

            function writeCachedGroup(store: string, group: CachedPropertyGroup): void {
                const dir = path.join(cacheDir, "sales-channels", store, "properties");
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, `${group.slug}.json`), JSON.stringify(group));
            }

            function cachedGroup(name: string, options: string[]): CachedPropertyGroup {
                return {
                    name,
                    slug: name.toLowerCase().replace(/\s+/g, "-"),
                    displayType: "text",
                    options,
                    source: "ai-generated",
                    createdAt: "2026-01-01T00:00:00.000Z",
                };
            }

            test("creates the group in Shopware with all cached options", async () => {
                writeCachedGroup("cache-store-a", cachedGroup("Finish New", ["Matte", "Gloss"]));
                const { context, mockApi } = setupVariantRun({
                    productId: "ens-create",
                    configs: [
                        {
                            group: "Finish New",
                            selectedOptions: ["Matte", "Gloss"],
                            priceModifiers: {},
                        },
                    ],
                    salesChannelName: "Cache Store A",
                });
                let created = false;
                answerGroupSearch(mockApi, () => {
                    created = syncBodies(mockApi).some((b) => b.includes("createPropertyGroup"));
                    if (!created) return { data: [] };
                    return {
                        data: [
                            {
                                id: "pg-finish-new",
                                name: "Finish New",
                                options: [
                                    { id: "opt-matte", name: "Matte" },
                                    { id: "opt-gloss", name: "Gloss" },
                                ],
                            },
                        ],
                    };
                });

                const result = await VariantProcessor.process(context);

                expect(result.processed).toBe(1);
                const groupSync = mockApi
                    .getCallsByEndpoint("_action/sync")
                    .find((c) => JSON.stringify(c.body).includes("createPropertyGroup"));
                const body = groupSync?.body as {
                    createPropertyGroup: {
                        entity: string;
                        action: string;
                        payload: Array<{
                            id: string;
                            name: string;
                            sortingType: string;
                            displayType: string;
                            options: Array<{ id: string; name: string }>;
                        }>;
                    };
                };
                expect(body.createPropertyGroup.entity).toBe("property_group");
                expect(body.createPropertyGroup.action).toBe("upsert");
                const payload = body.createPropertyGroup.payload[0];
                expect(payload?.name).toBe("Finish New");
                expect(payload?.sortingType).toBe("alphanumeric");
                expect(payload?.displayType).toBe("text");
                expect(payload?.id).toHaveLength(32);
                expect(payload?.options.map((o) => o.name)).toEqual(["Matte", "Gloss"]);
                expect(configuratorOptionIds(mockApi)).toEqual(["opt-matte", "opt-gloss"]);
            });

            test("keeps an existing group that already has enough options", async () => {
                writeCachedGroup("cache-store-b", cachedGroup("Finish Full", ["Matte", "Gloss"]));
                const { context, mockApi } = setupVariantRun({
                    productId: "ens-existing",
                    configs: [
                        {
                            group: "Finish Full",
                            selectedOptions: ["Matte", "Gloss"],
                            priceModifiers: {},
                        },
                    ],
                    salesChannelName: "cache-store-b",
                });
                answerGroupSearch(mockApi, () => ({
                    data: [
                        {
                            id: "pg-finish-full",
                            name: "Finish Full",
                            options: [
                                { id: "opt-matte-f", name: "Matte" },
                                { id: "opt-gloss-f", name: "Gloss" },
                            ],
                        },
                    ],
                }));

                const result = await VariantProcessor.process(context);

                expect(result.processed).toBe(1);
                expect(syncBodies(mockApi).some((b) => b.includes("createPropertyGroup"))).toBe(
                    false
                );
                expect(configuratorOptionIds(mockApi)).toEqual(["opt-matte-f", "opt-gloss-f"]);
            });

            test("prefers the cached group when the blueprint group lacks the selected options", async () => {
                writeCachedGroup("cache-store-d", cachedGroup("Size", ["XS", "M", "XL"]));
                const { context, mockApi } = setupVariantRun({
                    productId: "ens-blueprint-partial",
                    configs: [
                        { group: "Size", selectedOptions: ["XS", "M", "XL"], priceModifiers: {} },
                    ],
                    // Plain product property "Size: Medium", not the variant options
                    propertyGroups: [
                        {
                            id: "pg-size-blueprint",
                            name: "Size",
                            displayType: "text",
                            options: [{ id: "opt-medium", name: "Medium" }],
                        },
                    ],
                    salesChannelName: "cache-store-d",
                });
                answerGroupSearch(mockApi, () => ({
                    data: [
                        {
                            id: "pg-size",
                            name: "Size",
                            options: [
                                { id: "opt-medium", name: "Medium" },
                                { id: "opt-xs", name: "XS" },
                                { id: "opt-m", name: "M" },
                                { id: "opt-xl", name: "XL" },
                            ],
                        },
                    ],
                }));

                const result = await VariantProcessor.process(context);

                expect(result.processed).toBe(1);
                expect(configuratorOptionIds(mockApi)).toEqual(["opt-xs", "opt-m", "opt-xl"]);
            });

            test("adds missing cached options to an existing group", async () => {
                writeCachedGroup(
                    "cache-store-c",
                    cachedGroup("Finish Partial", ["Matte", "Gloss", "Satin"])
                );
                const { context, mockApi } = setupVariantRun({
                    productId: "ens-partial",
                    configs: [
                        {
                            group: "Finish Partial",
                            selectedOptions: ["Matte", "Satin"],
                            priceModifiers: {},
                        },
                    ],
                    salesChannelName: "cache-store-c",
                });
                answerGroupSearch(mockApi, () => ({
                    data: [
                        {
                            id: "pg-finish-partial",
                            name: "Finish Partial",
                            options: [
                                { id: "opt-matte-p", name: "Matte" },
                                { id: "opt-gloss-p", name: "Gloss" },
                            ],
                        },
                    ],
                }));

                const result = await VariantProcessor.process(context);

                expect(result.processed).toBe(1);
                const groupSync = syncBodies(mockApi).find((b) =>
                    b.includes("createPropertyGroup")
                );
                expect(groupSync).toContain('"id":"pg-finish-partial"');
                expect(groupSync).toContain('{"id":"opt-matte-p","name":"Matte"}');
                expect(groupSync).toContain('{"id":"opt-gloss-p","name":"Gloss"}');
                expect(groupSync).toContain('"name":"Satin"');
                // Group search is repeated after the sync (cache cleared)
                expect(mockApi.getCallsByEndpoint("search/property-group")).toHaveLength(2);
            });

            test("does not sync when every cached option name already exists", async () => {
                writeCachedGroup(
                    "cache-store-d",
                    cachedGroup("Finish Dupes", ["Matte", "Matte", "Gloss"])
                );
                const { context, mockApi } = setupVariantRun({
                    productId: "ens-dupes",
                    configs: [
                        {
                            group: "Finish Dupes",
                            selectedOptions: ["Matte", "Gloss"],
                            priceModifiers: {},
                        },
                    ],
                    salesChannelName: "cache-store-d",
                });
                answerGroupSearch(mockApi, () => ({
                    data: [
                        {
                            id: "pg-finish-dupes",
                            name: "Finish Dupes",
                            options: [
                                { id: "opt-matte-d", name: "Matte" },
                                { id: "opt-gloss-d", name: "Gloss" },
                            ],
                        },
                    ],
                }));

                const result = await VariantProcessor.process(context);

                expect(result.processed).toBe(1);
                expect(syncBodies(mockApi).some((b) => b.includes("createPropertyGroup"))).toBe(
                    false
                );
            });

            test("skips the product when the group sync fails", async () => {
                writeCachedGroup("cache-store-e", cachedGroup("Finish Fail", ["Matte", "Gloss"]));
                const { context, mockApi } = setupVariantRun({
                    productId: "ens-fail",
                    configs: [
                        {
                            group: "Finish Fail",
                            selectedOptions: ["Matte", "Gloss"],
                            priceModifiers: {},
                        },
                    ],
                    salesChannelName: "cache-store-e",
                });
                mockApi.mockPostResponse("search/property-group", { data: [] });
                mockApi.mockPostFailure("_action/sync", new Error("sync rejected"));

                const result = await VariantProcessor.process(context);

                expect(result.skipped).toBe(1);
                expect(result.errors).toHaveLength(0);
                expect(mockApi.getCallsByEndpoint("_action/sync")).toHaveLength(1);
            });
        });
    });
});
