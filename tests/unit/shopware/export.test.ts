import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ExportValidation, SalesChannelFull } from "../../../src/types/index.js";

import { ShopwareExporter } from "../../../src/shopware/export.js";

// Mock API responses
interface MockApiResponse<T> {
    data: T;
    status: number;
    ok: boolean;
}

/**
 * Create a testable exporter with mocked API client
 */
class TestableExporter extends ShopwareExporter {
    public mockPost: ReturnType<typeof mock>;

    constructor() {
        super();
        this.mockPost = mock(() => Promise.resolve({ data: { data: [] }, ok: true, status: 200 }));
        // Override the apiClient.post method
        (this.apiClient as unknown as { post: ReturnType<typeof mock> }).post = this.mockPost;
    }

    setMockResponse<T>(response: MockApiResponse<T>): void {
        this.mockPost.mockResolvedValue(response);
    }

    setMockResponses(responses: MockApiResponse<unknown>[]): void {
        let callIndex = 0;
        this.mockPost.mockImplementation(() => {
            const response = responses[callIndex] || responses[responses.length - 1];
            callIndex++;
            return Promise.resolve(response);
        });
    }
}

describe("ShopwareExporter", () => {
    let exporter: TestableExporter;

    beforeEach(() => {
        exporter = new TestableExporter();
    });

    describe("exportCategories", () => {
        test("exports categories with proper tree structure", async () => {
            const validation: ExportValidation = {
                categoriesWithoutDescription: 0,
                categoriesWithImages: 0,
                productsWithoutDescription: 0,
                productsWithDefaultPrice: 0,
                propertyGroupsWithoutOptions: 0,
            };

            exporter.setMockResponse({
                data: {
                    data: [
                        {
                            id: "cat-1",
                            name: "Furniture",
                            description: "All furniture items",
                            parentId: "root-123",
                            childCount: 2,
                            mediaId: null,
                        },
                        {
                            id: "cat-2",
                            name: "Beds",
                            description: "Comfortable beds",
                            parentId: "cat-1",
                            childCount: 0,
                            mediaId: null,
                        },
                        {
                            id: "cat-3",
                            name: "Tables",
                            description: "Wooden tables",
                            parentId: "cat-1",
                            childCount: 0,
                            mediaId: "media-123",
                        },
                    ],
                },
                ok: true,
                status: 200,
            });

            const categories = await exporter.exportCategories("root-123", validation);

            expect(categories).toHaveLength(1);
            expect(categories[0]?.name).toBe("Furniture");
            expect(categories[0]?.children).toHaveLength(2);
            expect(categories[0]?.children[0]?.name).toBe("Beds");
            expect(categories[0]?.children[1]?.name).toBe("Tables");
            expect(categories[0]?.children[1]?.hasImage).toBe(true);
            expect(validation.categoriesWithImages).toBe(1);
        });

        test("adds placeholder description for categories without description", async () => {
            const validation: ExportValidation = {
                categoriesWithoutDescription: 0,
                categoriesWithImages: 0,
                productsWithoutDescription: 0,
                productsWithDefaultPrice: 0,
                propertyGroupsWithoutOptions: 0,
            };

            exporter.setMockResponse({
                data: {
                    data: [
                        {
                            id: "cat-1",
                            name: "Empty Category",
                            description: null,
                            parentId: "root-123",
                            childCount: 0,
                            mediaId: null,
                        },
                        {
                            id: "cat-2",
                            name: "Whitespace Only",
                            description: "   ",
                            parentId: "root-123",
                            childCount: 0,
                            mediaId: null,
                        },
                    ],
                },
                ok: true,
                status: 200,
            });

            const categories = await exporter.exportCategories("root-123", validation);

            expect(categories).toHaveLength(2);
            expect(categories[0]?.description).toBe("Browse our Empty Category collection.");
            expect(categories[1]?.description).toBe("Browse our Whitespace Only collection.");
            expect(validation.categoriesWithoutDescription).toBe(2);
        });

        test("normalizes category names with whitespace", async () => {
            const validation: ExportValidation = {
                categoriesWithoutDescription: 0,
                categoriesWithImages: 0,
                productsWithoutDescription: 0,
                productsWithDefaultPrice: 0,
                propertyGroupsWithoutOptions: 0,
            };

            exporter.setMockResponse({
                data: {
                    data: [
                        {
                            id: "cat-1",
                            name: "  Extra   Spaces  ",
                            description: "Test",
                            parentId: "root-123",
                            childCount: 0,
                            mediaId: null,
                        },
                    ],
                },
                ok: true,
                status: 200,
            });

            const categories = await exporter.exportCategories("root-123", validation);

            expect(categories[0]?.name).toBe("Extra Spaces");
        });

        test("returns empty array on API error", async () => {
            const validation: ExportValidation = {
                categoriesWithoutDescription: 0,
                categoriesWithImages: 0,
                productsWithoutDescription: 0,
                productsWithDefaultPrice: 0,
                propertyGroupsWithoutOptions: 0,
            };

            exporter.setMockResponse({
                data: { error: "Not found" },
                ok: false,
                status: 404,
            });

            const categories = await exporter.exportCategories("root-123", validation);

            expect(categories).toHaveLength(0);
        });
    });

    describe("exportProductsInCategory", () => {
        test("exports products with all fields", async () => {
            const validation: ExportValidation = {
                categoriesWithoutDescription: 0,
                categoriesWithImages: 0,
                productsWithoutDescription: 0,
                productsWithDefaultPrice: 0,
                propertyGroupsWithoutOptions: 0,
            };

            exporter.setMockResponse({
                data: {
                    data: [
                        {
                            id: "prod-1",
                            name: "Oak Table",
                            description: "Beautiful oak table",
                            stock: 10,
                            price: [{ gross: 299.99, net: 251.25 }],
                            options: [{ id: "opt-1", name: "Brown", colorHexCode: "#8B4513" }],
                        },
                    ],
                },
                ok: true,
                status: 200,
            });

            const products = await exporter.exportProductsInCategory("cat-1", "Tables", validation);

            expect(products).toHaveLength(1);
            const product = products[0];
            expect(product?.id).toBe("prod-1");
            expect(product?.name).toBe("Oak Table");
            expect(product?.description).toBe("Beautiful oak table");
            expect(product?.stock).toBe(10);
            expect(product?.price).toBe(299.99);
            expect(product?.options).toHaveLength(1);
            expect(product?.options?.[0]?.colorHexCode).toBe("#8B4513");
        });

        test("adds placeholder description for products without description", async () => {
            const validation: ExportValidation = {
                categoriesWithoutDescription: 0,
                categoriesWithImages: 0,
                productsWithoutDescription: 0,
                productsWithDefaultPrice: 0,
                propertyGroupsWithoutOptions: 0,
            };

            exporter.setMockResponse({
                data: {
                    data: [
                        {
                            id: "prod-1",
                            name: "Mystery Product",
                            description: null,
                            stock: 5,
                            price: [{ gross: 50, net: 42 }],
                        },
                    ],
                },
                ok: true,
                status: 200,
            });

            const products = await exporter.exportProductsInCategory(
                "cat-1",
                "Furniture",
                validation
            );

            expect(products[0]?.description).toBe(
                "High-quality Mystery Product from our Furniture collection."
            );
            expect(validation.productsWithoutDescription).toBe(1);
        });

        test("applies default price for products with zero price", async () => {
            const validation: ExportValidation = {
                categoriesWithoutDescription: 0,
                categoriesWithImages: 0,
                productsWithoutDescription: 0,
                productsWithDefaultPrice: 0,
                propertyGroupsWithoutOptions: 0,
            };

            exporter.setMockResponse({
                data: {
                    data: [
                        {
                            id: "prod-1",
                            name: "Free Item",
                            description: "A free product",
                            stock: 100,
                            price: [{ gross: 0, net: 0 }],
                        },
                        {
                            id: "prod-2",
                            name: "No Price",
                            description: "Missing price",
                            stock: 50,
                            price: [],
                        },
                    ],
                },
                ok: true,
                status: 200,
            });

            const products = await exporter.exportProductsInCategory("cat-1", "Misc", validation);

            expect(products[0]?.price).toBe(29.99);
            expect(products[1]?.price).toBe(29.99);
            expect(validation.productsWithDefaultPrice).toBe(2);
        });

        test("normalizes negative stock to zero", async () => {
            const validation: ExportValidation = {
                categoriesWithoutDescription: 0,
                categoriesWithImages: 0,
                productsWithoutDescription: 0,
                productsWithDefaultPrice: 0,
                propertyGroupsWithoutOptions: 0,
            };

            exporter.setMockResponse({
                data: {
                    data: [
                        {
                            id: "prod-1",
                            name: "Negative Stock",
                            description: "Test",
                            stock: -5,
                            price: [{ gross: 10, net: 8.4 }],
                        },
                    ],
                },
                ok: true,
                status: 200,
            });

            const products = await exporter.exportProductsInCategory("cat-1", "Test", validation);

            expect(products[0]?.stock).toBe(0);
        });

        test("strips HTML from product descriptions", async () => {
            const validation: ExportValidation = {
                categoriesWithoutDescription: 0,
                categoriesWithImages: 0,
                productsWithoutDescription: 0,
                productsWithDefaultPrice: 0,
                propertyGroupsWithoutOptions: 0,
            };

            exporter.setMockResponse({
                data: {
                    data: [
                        {
                            id: "prod-1",
                            name: "HTML Product",
                            description:
                                "<p>This is a <strong>bold</strong> description with &nbsp; entities.</p>",
                            stock: 10,
                            price: [{ gross: 99.99, net: 84 }],
                        },
                    ],
                },
                ok: true,
                status: 200,
            });

            const products = await exporter.exportProductsInCategory("cat-1", "Test", validation);

            expect(products[0]?.description).toBe("This is a bold description with entities.");
        });

        test("rounds prices to 2 decimal places", async () => {
            const validation: ExportValidation = {
                categoriesWithoutDescription: 0,
                categoriesWithImages: 0,
                productsWithoutDescription: 0,
                productsWithDefaultPrice: 0,
                propertyGroupsWithoutOptions: 0,
            };

            exporter.setMockResponse({
                data: {
                    data: [
                        {
                            id: "prod-1",
                            name: "Precision Price",
                            description: "Test",
                            stock: 1,
                            price: [{ gross: 19.999999, net: 16.8 }],
                        },
                    ],
                },
                ok: true,
                status: 200,
            });

            const products = await exporter.exportProductsInCategory("cat-1", "Test", validation);

            expect(products[0]?.price).toBe(20);
        });
    });

    describe("exportPropertyGroups", () => {
        test("exports property groups with options", async () => {
            const validation: ExportValidation = {
                categoriesWithoutDescription: 0,
                categoriesWithImages: 0,
                productsWithoutDescription: 0,
                productsWithDefaultPrice: 0,
                propertyGroupsWithoutOptions: 0,
            };

            exporter.setMockResponse({
                data: {
                    data: [
                        {
                            id: "pg-1",
                            name: "Color",
                            description: "Product colors",
                            displayType: "color",
                            sortingType: "alphanumeric",
                            options: [
                                { id: "opt-1", name: "Red", colorHexCode: "#FF0000", position: 1 },
                                { id: "opt-2", name: "Blue", colorHexCode: "#0000FF", position: 2 },
                            ],
                        },
                        {
                            id: "pg-2",
                            name: "Size",
                            description: null,
                            displayType: "text",
                            sortingType: "alphanumeric",
                            options: [
                                { id: "opt-3", name: "Small", position: 1 },
                                { id: "opt-4", name: "Large", position: 2 },
                            ],
                        },
                    ],
                },
                ok: true,
                status: 200,
            });

            const groups = await exporter.exportPropertyGroups(validation);

            expect(groups).toHaveLength(2);
            expect(groups[0]?.name).toBe("Color");
            expect(groups[0]?.displayType).toBe("color");
            expect(groups[0]?.options).toHaveLength(2);
            expect(groups[0]?.options[0]?.colorHexCode).toBe("#FF0000");

            expect(groups[1]?.name).toBe("Size");
            expect(groups[1]?.displayType).toBe("text");
            expect(groups[1]?.description).toBe("Size property options");
        });

        test("skips property groups without options", async () => {
            const validation: ExportValidation = {
                categoriesWithoutDescription: 0,
                categoriesWithImages: 0,
                productsWithoutDescription: 0,
                productsWithDefaultPrice: 0,
                propertyGroupsWithoutOptions: 0,
            };

            exporter.setMockResponse({
                data: {
                    data: [
                        {
                            id: "pg-1",
                            name: "Empty Group",
                            description: "No options",
                            displayType: "text",
                            sortingType: "alphanumeric",
                            options: [],
                        },
                        {
                            id: "pg-2",
                            name: "Null Options",
                            description: "Null",
                            displayType: "text",
                            sortingType: "alphanumeric",
                            options: null,
                        },
                    ],
                },
                ok: true,
                status: 200,
            });

            const groups = await exporter.exportPropertyGroups(validation);

            expect(groups).toHaveLength(0);
            expect(validation.propertyGroupsWithoutOptions).toBe(2);
        });

        test("normalizes display type to valid values", async () => {
            const validation: ExportValidation = {
                categoriesWithoutDescription: 0,
                categoriesWithImages: 0,
                productsWithoutDescription: 0,
                productsWithDefaultPrice: 0,
                propertyGroupsWithoutOptions: 0,
            };

            exporter.setMockResponse({
                data: {
                    data: [
                        {
                            id: "pg-1",
                            name: "Unknown Type",
                            description: "Test",
                            displayType: "unknown",
                            sortingType: "alphanumeric",
                            options: [{ id: "opt-1", name: "Option", position: 1 }],
                        },
                        {
                            id: "pg-2",
                            name: "Image Type",
                            description: "Test",
                            displayType: "IMAGE",
                            sortingType: "alphanumeric",
                            options: [{ id: "opt-2", name: "Option", position: 1 }],
                        },
                    ],
                },
                ok: true,
                status: 200,
            });

            const groups = await exporter.exportPropertyGroups(validation);

            expect(groups[0]?.displayType).toBe("text"); // fallback for unknown
            expect(groups[1]?.displayType).toBe("image"); // normalized from IMAGE
        });

        test("defaults colorHexCode for color type without hex", async () => {
            const validation: ExportValidation = {
                categoriesWithoutDescription: 0,
                categoriesWithImages: 0,
                productsWithoutDescription: 0,
                productsWithDefaultPrice: 0,
                propertyGroupsWithoutOptions: 0,
            };

            exporter.setMockResponse({
                data: {
                    data: [
                        {
                            id: "pg-1",
                            name: "Color",
                            description: "Colors",
                            displayType: "color",
                            sortingType: "alphanumeric",
                            options: [
                                { id: "opt-1", name: "Black", position: 1 }, // No colorHexCode
                            ],
                        },
                    ],
                },
                ok: true,
                status: 200,
            });

            const groups = await exporter.exportPropertyGroups(validation);

            expect(groups[0]?.options[0]?.colorHexCode).toBe("#000000");
        });
    });

    describe("exportSalesChannel", () => {
        test("exports complete SalesChannel data", async () => {
            const salesChannel: SalesChannelFull = {
                id: "sc-123",
                name: "Furniture Store",
                navigationCategoryId: "root-123",
                typeId: "type-1",
                languageId: "lang-1",
                paymentMethodId: "pay-1",
                shippingMethodId: "ship-1",
                countryId: "country-1",
                customerGroupId: "cg-1",
                currencyId: "curr-1",
            };

            // Set up sequential mock responses
            exporter.setMockResponses([
                // Categories response
                {
                    data: {
                        data: [
                            {
                                id: "cat-1",
                                name: "Beds",
                                description: "Comfortable beds",
                                parentId: "root-123",
                                childCount: 0,
                                mediaId: null,
                            },
                        ],
                    },
                    ok: true,
                    status: 200,
                },
                // Products response
                {
                    data: {
                        data: [
                            {
                                id: "prod-1",
                                name: "King Bed",
                                description: "Luxurious king bed",
                                stock: 5,
                                price: [{ gross: 999.99, net: 840 }],
                            },
                        ],
                    },
                    ok: true,
                    status: 200,
                },
                // Property groups response
                {
                    data: {
                        data: [
                            {
                                id: "pg-1",
                                name: "Material",
                                description: "Bed materials",
                                displayType: "text",
                                sortingType: "alphanumeric",
                                options: [{ id: "opt-1", name: "Wood", position: 1 }],
                            },
                        ],
                    },
                    ok: true,
                    status: 200,
                },
            ]);

            const result = await exporter.exportSalesChannel(salesChannel);

            expect(result.categories).toHaveLength(1);
            expect(result.categories[0]?.name).toBe("Beds");
            expect(result.products.size).toBe(1);
            expect(result.products.get("Beds")).toHaveLength(1);
            expect(result.propertyGroups).toHaveLength(1);
            expect(result.productCount).toBe(1);
        });

        test("tracks validation stats across all exports", async () => {
            const salesChannel: SalesChannelFull = {
                id: "sc-123",
                name: "Test Store",
                navigationCategoryId: "root-123",
                typeId: "type-1",
                languageId: "lang-1",
                paymentMethodId: "pay-1",
                shippingMethodId: "ship-1",
                countryId: "country-1",
                customerGroupId: "cg-1",
                currencyId: "curr-1",
            };

            exporter.setMockResponses([
                // Categories - one without description, one with image
                {
                    data: {
                        data: [
                            {
                                id: "cat-1",
                                name: "No Desc",
                                description: null,
                                parentId: "root-123",
                                childCount: 0,
                                mediaId: "media-1",
                            },
                        ],
                    },
                    ok: true,
                    status: 200,
                },
                // Products - one without description, one with zero price
                {
                    data: {
                        data: [
                            {
                                id: "prod-1",
                                name: "No Desc Product",
                                description: null,
                                stock: 1,
                                price: [{ gross: 0, net: 0 }],
                            },
                        ],
                    },
                    ok: true,
                    status: 200,
                },
                // Property groups - one without options
                {
                    data: {
                        data: [
                            {
                                id: "pg-1",
                                name: "Empty",
                                description: "No options",
                                displayType: "text",
                                sortingType: "alphanumeric",
                                options: [],
                            },
                        ],
                    },
                    ok: true,
                    status: 200,
                },
            ]);

            const result = await exporter.exportSalesChannel(salesChannel);

            expect(result.validation.categoriesWithoutDescription).toBe(1);
            expect(result.validation.categoriesWithImages).toBe(1);
            expect(result.validation.productsWithoutDescription).toBe(1);
            expect(result.validation.productsWithDefaultPrice).toBe(1);
            expect(result.validation.propertyGroupsWithoutOptions).toBe(1);
        });
    });
});
