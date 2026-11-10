import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ExportValidation, SalesChannelFull } from "../../../src/types/index.js";

import { ShopwareExporter } from "../../../src/shopware/export.js";
import { createEmptyValidation } from "../../../src/types/index.js";

/**
 * Create a mock AdminApiClient with invoke() support.
 */
function createMockAdminClient() {
    const responses: Array<unknown> = [];
    let callIndex = 0;

    const invoke = mock(async (_operation: string, _params?: unknown): Promise<unknown> => {
        const responseBody = responses[callIndex] ?? responses[responses.length - 1];
        callIndex++;
        // invoke() returns { data: responseBody, status: 200 }
        return { data: responseBody };
    });

    return {
        invoke,
        getSessionData: () => ({ accessToken: "test-token", expirationTime: Date.now() + 3600000 }),

        /** Set a single mock response body (will be wrapped in { data: body } by invoke) */
        setMockResponse(response: unknown) {
            responses.length = 0;
            responses.push(response);
            callIndex = 0;
        },

        /** Set sequential mock response bodies (each wrapped in { data: body } by invoke) */
        setMockResponses(newResponses: unknown[]) {
            responses.length = 0;
            responses.push(...newResponses);
            callIndex = 0;
        },
    };
}

/**
 * Create a testable exporter with mocked API client
 */
class TestableExporter extends ShopwareExporter {
    public mockAdminClient: ReturnType<typeof createMockAdminClient>;

    constructor() {
        const mockClient = createMockAdminClient();
        super(mockClient as never);
        this.mockAdminClient = mockClient;
    }

    setMockResponse(response: unknown): void {
        this.mockAdminClient.setMockResponse(response);
    }

    setMockResponses(responses: unknown[]): void {
        this.mockAdminClient.setMockResponses(responses);
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
                total: 3,
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
                total: 2,
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
                total: 1,
            });

            const categories = await exporter.exportCategories("root-123", validation);

            expect(categories[0]?.name).toBe("Extra Spaces");
        });

        test("returns empty array when no data", async () => {
            const validation: ExportValidation = {
                categoriesWithoutDescription: 0,
                categoriesWithImages: 0,
                productsWithoutDescription: 0,
                productsWithDefaultPrice: 0,
                propertyGroupsWithoutOptions: 0,
            };

            exporter.setMockResponse({ data: undefined, total: 0 });

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
                total: 1,
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
                data: [
                    {
                        id: "prod-1",
                        name: "Mystery Product",
                        description: null,
                        stock: 5,
                        price: [{ gross: 50, net: 42 }],
                    },
                ],
                total: 1,
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
                total: 2,
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
                data: [
                    {
                        id: "prod-1",
                        name: "Negative Stock",
                        description: "Test",
                        stock: -5,
                        price: [{ gross: 10, net: 8.4 }],
                    },
                ],
                total: 1,
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
                total: 1,
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
                data: [
                    {
                        id: "prod-1",
                        name: "Precision Price",
                        description: "Test",
                        stock: 1,
                        price: [{ gross: 19.999999, net: 16.8 }],
                    },
                ],
                total: 1,
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
                total: 2,
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
                total: 2,
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
                total: 2,
            });

            const groups = await exporter.exportPropertyGroups(validation);

            expect(groups[0]?.displayType).toBe("text");
            expect(groups[1]?.displayType).toBe("image");
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
                data: [
                    {
                        id: "pg-1",
                        name: "Color",
                        description: "Colors",
                        displayType: "color",
                        sortingType: "alphanumeric",
                        options: [{ id: "opt-1", name: "Black", position: 1 }],
                    },
                ],
                total: 1,
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

            exporter.setMockResponses([
                // Categories
                {
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
                    total: 1,
                },
                // Products
                {
                    data: [
                        {
                            id: "prod-1",
                            name: "King Bed",
                            description: "Luxurious king bed",
                            stock: 5,
                            price: [{ gross: 999.99, net: 840 }],
                        },
                    ],
                    total: 1,
                },
                // Property groups
                {
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
                    total: 1,
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
                // Categories
                {
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
                    total: 1,
                },
                // Products
                {
                    data: [
                        {
                            id: "prod-1",
                            name: "No Desc Product",
                            description: null,
                            stock: 1,
                            price: [{ gross: 0, net: 0 }],
                        },
                    ],
                    total: 1,
                },
                // Property groups
                {
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
                    total: 1,
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

describe("ShopwareExporter — category tree details", () => {
    test("searches categories below the root, sorted by level", async () => {
        const exporter = new TestableExporter();
        exporter.setMockResponse({ data: [] });

        await exporter.exportCategories("root-1", createEmptyValidation());

        expect(exporter.mockAdminClient.invoke).toHaveBeenCalledWith(
            "searchCategory post /search/category",
            {
                body: {
                    limit: 500,
                    filter: [{ type: "contains", field: "path", value: "root-1" }],
                    sort: [{ field: "level", order: "ASC" }],
                },
            }
        );
    });

    test("builds full nodes and counts images and missing descriptions", async () => {
        const exporter = new TestableExporter();
        const validation = createEmptyValidation();
        exporter.setMockResponse({
            data: [
                { id: "a", name: "  Alpha  ", description: "   ", parentId: "root", mediaId: "m" },
                { id: "b", name: "Beta", description: "<p>Text</p>", parentId: "a" },
                { id: "c", parentId: "a", mediaId: null },
            ],
        });

        const tree = await exporter.exportCategories("root", validation);

        expect(tree).toEqual([
            {
                id: "a",
                name: "Alpha",
                description: "Browse our Alpha collection.",
                children: [
                    {
                        id: "b",
                        name: "Beta",
                        description: "Text",
                        children: [],
                        productCount: 0,
                        hasImage: false,
                    },
                    {
                        id: "c",
                        name: "",
                        description: "Browse our collection.",
                        children: [],
                        productCount: 0,
                        hasImage: false,
                    },
                ],
                productCount: 0,
                hasImage: true,
            },
        ]);
        expect(validation.categoriesWithImages).toBe(1);
        expect(validation.categoriesWithoutDescription).toBe(2);
    });

    test("drops categories whose parent is missing or unknown", async () => {
        const exporter = new TestableExporter();
        exporter.setMockResponse({
            data: [
                { id: "a", name: "A", description: "d", parentId: "root" },
                { id: "orphan", name: "Orphan", description: "d", parentId: "unknown" },
                { id: "top", name: "Top", description: "d", parentId: null },
                { id: "none", name: "None", description: "d" },
            ],
        });

        const tree = await exporter.exportCategories("root", createEmptyValidation());

        expect(tree.map((n) => n.id)).toEqual(["a"]);
        expect(tree[0]?.children).toEqual([]);
    });

    test("keeps the response order for siblings and nests deeper levels", async () => {
        const exporter = new TestableExporter();
        exporter.setMockResponse({
            data: [
                { id: "a", name: "A", description: "d", parentId: "root" },
                { id: "b", name: "B", description: "d", parentId: "root" },
                { id: "a1", name: "A1", description: "d", parentId: "a" },
                { id: "a1x", name: "A1x", description: "d", parentId: "a1" },
            ],
        });

        const tree = await exporter.exportCategories("root", createEmptyValidation());

        expect(tree.map((n) => n.id)).toEqual(["a", "b"]);
        expect(tree[0]?.children[0]?.children.map((n) => n.id)).toEqual(["a1x"]);
    });
});

describe("ShopwareExporter — product export details", () => {
    test("searches products of the category with their options", async () => {
        const exporter = new TestableExporter();
        exporter.setMockResponse({ data: [] });

        await exporter.exportProductsInCategory("cat-9", "Cat", createEmptyValidation());

        expect(exporter.mockAdminClient.invoke).toHaveBeenCalledWith(
            "searchProduct post /search/product",
            {
                body: {
                    limit: 500,
                    filter: [{ type: "equals", field: "categories.id", value: "cat-9" }],
                    associations: { options: {} },
                },
            }
        );
    });

    test("maps a product with missing fields to placeholders and defaults", async () => {
        const exporter = new TestableExporter();
        const validation = createEmptyValidation();
        exporter.setMockResponse({
            data: [
                { id: "p1", options: [] },
                { id: "p2", price: [] },
            ],
        });

        const products = await exporter.exportProductsInCategory("c", "Lamps", validation);

        const expected = {
            name: "",
            description: "High-quality from our Lamps collection.",
            stock: 0,
            price: 29.99,
            options: undefined,
        };
        expect(products).toEqual([
            { id: "p1", ...expected },
            { id: "p2", ...expected },
        ]);
        expect(validation.productsWithoutDescription).toBe(2);
        expect(validation.productsWithDefaultPrice).toBe(2);
    });

    test("treats a whitespace description as missing and keeps a positive price", async () => {
        const exporter = new TestableExporter();
        const validation = createEmptyValidation();
        exporter.setMockResponse({
            data: [
                {
                    id: "p",
                    name: " Lamp  One ",
                    description: "  ",
                    stock: 3,
                    price: [{ gross: 0.014 }],
                    options: [{ id: "o", name: " Red  Dark ", colorHexCode: "#f00" }],
                },
            ],
        });

        const [product] = await exporter.exportProductsInCategory("c", "Lamps", validation);

        expect(product).toEqual({
            id: "p",
            name: "Lamp One",
            description: "High-quality Lamp One from our Lamps collection.",
            stock: 3,
            price: 0.01,
            options: [{ id: "o", name: "Red Dark", colorHexCode: "#f00" }],
        });
        expect(validation.productsWithoutDescription).toBe(1);
        expect(validation.productsWithDefaultPrice).toBe(0);
    });

    test("treats a negative price as missing", async () => {
        const exporter = new TestableExporter();
        const validation = createEmptyValidation();
        exporter.setMockResponse({
            data: [{ id: "p", name: "P", description: "d", price: [{ gross: -5 }] }],
        });

        const [product] = await exporter.exportProductsInCategory("c", "C", validation);

        expect(product?.price).toBe(29.99);
        expect(validation.productsWithDefaultPrice).toBe(1);
        expect(validation.productsWithoutDescription).toBe(0);
    });
});
