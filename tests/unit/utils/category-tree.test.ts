import { describe, expect, test } from "bun:test";

import type { BlueprintCategory, CategoryNode } from "../../../src/types/index.js";

import {
    buildBlueprintCategoryPathMap,
    buildCategoryPath,
    CATEGORY_PATH_SEPARATOR,
    collectCategoryIdsByPath,
    convertBlueprintCategories,
    countCategories,
    countProducts,
    findCategoryByName,
    findCategoryPathById,
    flattenCategoryTree,
    flattenCategoryTreeWithPath,
    getLeafCategories,
    getLeafCategoriesWithProducts,
    getTreeDepth,
    redistributeProductsToTree,
} from "../../../src/utils/category-tree.js";

// Test fixtures
const createTestTree = (): CategoryNode[] => [
    {
        id: "cat-1",
        name: "Furniture",
        description: "All furniture",
        children: [
            {
                id: "cat-1-1",
                name: "Beds",
                description: "Comfortable beds",
                children: [],
                productCount: 10,
                hasImage: true,
            },
            {
                id: "cat-1-2",
                name: "Tables",
                description: "Wooden tables",
                children: [
                    {
                        id: "cat-1-2-1",
                        name: "Dining Tables",
                        description: "For dining",
                        children: [],
                        productCount: 5,
                        hasImage: false,
                    },
                ],
                productCount: 0,
                hasImage: false,
            },
        ],
        productCount: 0,
        hasImage: true,
    },
    {
        id: "cat-2",
        name: "Electronics",
        description: "Electronic devices",
        children: [],
        productCount: 20,
        hasImage: false,
    },
];

describe("category tree utilities", () => {
    describe("countCategories", () => {
        test("counts all categories including children", () => {
            const tree = createTestTree();
            expect(countCategories(tree)).toBe(5);
        });

        test("returns 0 for empty array", () => {
            expect(countCategories([])).toBe(0);
        });

        test("counts flat categories", () => {
            const flat: CategoryNode[] = [
                { name: "A", description: "", children: [], productCount: 0, hasImage: false },
                { name: "B", description: "", children: [], productCount: 0, hasImage: false },
            ];
            expect(countCategories(flat)).toBe(2);
        });
    });

    describe("countProducts", () => {
        test("sums products across all categories", () => {
            const tree = createTestTree();
            expect(countProducts(tree)).toBe(35); // 10 + 5 + 20
        });

        test("returns 0 for empty array", () => {
            expect(countProducts([])).toBe(0);
        });

        test("includes nested products", () => {
            const tree: CategoryNode[] = [
                {
                    name: "Parent",
                    description: "",
                    children: [
                        {
                            name: "Child",
                            description: "",
                            children: [],
                            productCount: 15,
                            hasImage: false,
                        },
                    ],
                    productCount: 5,
                    hasImage: false,
                },
            ];
            expect(countProducts(tree)).toBe(20);
        });
    });

    describe("getLeafCategories", () => {
        test("returns only categories without children", () => {
            const tree = createTestTree();
            const leaves = getLeafCategories(tree);

            expect(leaves).toHaveLength(3);
            expect(leaves.map((l) => l.name)).toEqual(["Beds", "Dining Tables", "Electronics"]);
        });

        test("returns all categories if none have children", () => {
            const flat: CategoryNode[] = [
                { name: "A", description: "", children: [], productCount: 0, hasImage: false },
                { name: "B", description: "", children: [], productCount: 0, hasImage: false },
            ];
            expect(getLeafCategories(flat)).toHaveLength(2);
        });

        test("returns empty array for empty input", () => {
            expect(getLeafCategories([])).toHaveLength(0);
        });
    });

    describe("getLeafCategoriesWithProducts", () => {
        test("returns only leaf categories with productCount > 0", () => {
            const tree = createTestTree();
            const leaves = getLeafCategoriesWithProducts(tree);

            expect(leaves).toHaveLength(3);
            expect(leaves.every((l) => l.productCount > 0)).toBe(true);
        });

        test("excludes leaves with zero products", () => {
            const tree: CategoryNode[] = [
                {
                    name: "Empty",
                    description: "",
                    children: [],
                    productCount: 0,
                    hasImage: false,
                },
                {
                    name: "HasProducts",
                    description: "",
                    children: [],
                    productCount: 10,
                    hasImage: false,
                },
            ];
            const leaves = getLeafCategoriesWithProducts(tree);

            expect(leaves).toHaveLength(1);
            expect(leaves[0]?.name).toBe("HasProducts");
        });
    });

    describe("flattenCategoryTree", () => {
        test("flattens tree with parent references", () => {
            const tree = createTestTree();
            const flat = flattenCategoryTree(tree);

            expect(flat).toHaveLength(5);
            expect(flat[0]).toEqual({
                id: "cat-1",
                name: "Furniture",
                description: "All furniture",
                parentName: null,
                productCount: 0,
                hasImage: true,
            });
            expect(flat[1]?.parentName).toBe("Furniture");
        });

        test("returns empty array for empty input", () => {
            expect(flattenCategoryTree([])).toHaveLength(0);
        });

        test("preserves order", () => {
            const tree = createTestTree();
            const flat = flattenCategoryTree(tree);
            const names = flat.map((c) => c.name);

            expect(names).toEqual(["Furniture", "Beds", "Tables", "Dining Tables", "Electronics"]);
        });
    });

    describe("findCategoryByName", () => {
        test("finds category at root level", () => {
            const tree = createTestTree();
            const found = findCategoryByName(tree, "Electronics");

            expect(found).toBeDefined();
            expect(found?.id).toBe("cat-2");
        });

        test("finds nested category", () => {
            const tree = createTestTree();
            const found = findCategoryByName(tree, "Dining Tables");

            expect(found).toBeDefined();
            expect(found?.id).toBe("cat-1-2-1");
        });

        test("returns undefined for non-existent category", () => {
            const tree = createTestTree();
            const found = findCategoryByName(tree, "NotFound");

            expect(found).toBeUndefined();
        });

        test("returns undefined for empty tree", () => {
            expect(findCategoryByName([], "Any")).toBeUndefined();
        });
    });

    describe("getTreeDepth", () => {
        test("returns 0 for empty tree", () => {
            expect(getTreeDepth([])).toBe(0);
        });

        test("returns 1 for flat tree", () => {
            const flat: CategoryNode[] = [
                { name: "A", description: "", children: [], productCount: 0, hasImage: false },
            ];
            expect(getTreeDepth(flat)).toBe(1);
        });

        test("returns correct depth for nested tree", () => {
            const tree = createTestTree();
            expect(getTreeDepth(tree)).toBe(3); // Furniture > Tables > Dining Tables
        });

        test("handles multiple root categories", () => {
            const tree: CategoryNode[] = [
                {
                    name: "Deep",
                    description: "",
                    children: [
                        {
                            name: "Deeper",
                            description: "",
                            children: [
                                {
                                    name: "Deepest",
                                    description: "",
                                    children: [],
                                    productCount: 0,
                                    hasImage: false,
                                },
                            ],
                            productCount: 0,
                            hasImage: false,
                        },
                    ],
                    productCount: 0,
                    hasImage: false,
                },
                {
                    name: "Shallow",
                    description: "",
                    children: [],
                    productCount: 0,
                    hasImage: false,
                },
            ];
            expect(getTreeDepth(tree)).toBe(3);
        });
    });

    describe("redistributeProductsToTree", () => {
        test("distributes products with first leaf getting 25+", () => {
            const tree: CategoryNode[] = [
                {
                    name: "Cat1",
                    description: "",
                    children: [],
                    productCount: 0,
                    hasImage: false,
                },
                {
                    name: "Cat2",
                    description: "",
                    children: [],
                    productCount: 0,
                    hasImage: false,
                },
                {
                    name: "Cat3",
                    description: "",
                    children: [],
                    productCount: 0,
                    hasImage: false,
                },
            ];

            redistributeProductsToTree(tree, 50);

            const leaves = getLeafCategories(tree);
            expect(leaves[0]?.productCount).toBe(25); // First gets 25
            expect(countProducts(tree)).toBe(50); // Total is 50
        });

        test("gives all products to single leaf", () => {
            const tree: CategoryNode[] = [
                {
                    name: "Only",
                    description: "",
                    children: [],
                    productCount: 0,
                    hasImage: false,
                },
            ];

            redistributeProductsToTree(tree, 30);

            expect(tree[0]?.productCount).toBe(30);
        });

        test("resets existing product counts before redistribution", () => {
            const tree: CategoryNode[] = [
                {
                    name: "Cat1",
                    description: "",
                    children: [],
                    productCount: 100, // Existing count
                    hasImage: false,
                },
                {
                    name: "Cat2",
                    description: "",
                    children: [],
                    productCount: 50, // Existing count
                    hasImage: false,
                },
            ];

            redistributeProductsToTree(tree, 30);

            // Should reset and redistribute
            expect(countProducts(tree)).toBe(30);
            expect(tree[0]?.productCount).toBe(25);
            expect(tree[1]?.productCount).toBe(5);
        });

        test("handles nested tree structure", () => {
            const tree: CategoryNode[] = [
                {
                    name: "Parent",
                    description: "",
                    productCount: 0,
                    hasImage: false,
                    children: [
                        {
                            name: "Child1",
                            description: "",
                            children: [],
                            productCount: 0,
                            hasImage: false,
                        },
                        {
                            name: "Child2",
                            description: "",
                            children: [],
                            productCount: 0,
                            hasImage: false,
                        },
                    ],
                },
            ];

            redistributeProductsToTree(tree, 40);

            const leaves = getLeafCategories(tree);
            expect(leaves).toHaveLength(2);
            expect(leaves[0]?.productCount).toBe(25);
            expect(leaves[1]?.productCount).toBe(15);
            expect(tree[0]?.productCount).toBe(0); // Parent should remain 0
        });

        test("handles empty tree", () => {
            const tree: CategoryNode[] = [];
            redistributeProductsToTree(tree, 30);
            expect(countProducts(tree)).toBe(0);
        });

        test("simulates synced categories with zero products", () => {
            // This simulates the exact scenario when:
            // 1. SalesChannel exists in Shopware
            // 2. Categories exist but products were deleted
            // 3. We sync/cache with productCount: 0
            // 4. User runs generate again expecting products
            const syncedTree: CategoryNode[] = [
                {
                    id: "synced-root",
                    name: "Furniture",
                    description: "All furniture",
                    productCount: 0, // Synced with 0 products
                    hasImage: false,
                    children: [
                        {
                            id: "synced-beds",
                            name: "Beds",
                            description: "Comfortable beds",
                            children: [],
                            productCount: 0, // No products
                            hasImage: true,
                        },
                        {
                            id: "synced-tables",
                            name: "Tables",
                            description: "Various tables",
                            children: [],
                            productCount: 0, // No products
                            hasImage: false,
                        },
                    ],
                },
            ];

            // User requests 30 products
            redistributeProductsToTree(syncedTree, 30);

            // Verify products were redistributed
            const leaves = getLeafCategories(syncedTree);
            expect(leaves).toHaveLength(2);
            expect(leaves[0]?.productCount).toBe(25); // First leaf gets 25 for pagination
            expect(leaves[1]?.productCount).toBe(5); // Remainder to second leaf
            expect(countProducts(syncedTree)).toBe(30);

            // Verify getLeafCategoriesWithProducts now returns leaves
            const leavesWithProducts = getLeafCategoriesWithProducts(syncedTree);
            expect(leavesWithProducts).toHaveLength(2);
        });
    });

    describe("buildCategoryPath", () => {
        test("returns name when parent is null", () => {
            expect(buildCategoryPath(null, "Furniture")).toBe("Furniture");
        });

        test("returns name when parent is empty string", () => {
            expect(buildCategoryPath("", "Furniture")).toBe("Furniture");
        });

        test("builds path with separator", () => {
            expect(buildCategoryPath("Furniture", "Sofas")).toBe(
                `Furniture${CATEGORY_PATH_SEPARATOR}Sofas`
            );
        });

        test("builds multi-level path", () => {
            const level1 = buildCategoryPath(null, "Furniture");
            const level2 = buildCategoryPath(level1, "Sofas");
            const level3 = buildCategoryPath(level2, "Leather");

            expect(level3).toBe(
                `Furniture${CATEGORY_PATH_SEPARATOR}Sofas${CATEGORY_PATH_SEPARATOR}Leather`
            );
        });
    });

    describe("flattenCategoryTreeWithPath", () => {
        test("includes full path for each category", () => {
            const tree = createTestTree();
            const flat = flattenCategoryTreeWithPath(tree);

            expect(flat).toHaveLength(5);

            // Check paths
            const furniturePath = flat.find((c) => c.name === "Furniture")?.path;
            expect(furniturePath).toBe("Furniture");

            const bedsPath = flat.find((c) => c.name === "Beds")?.path;
            expect(bedsPath).toBe(`Furniture${CATEGORY_PATH_SEPARATOR}Beds`);

            const diningPath = flat.find((c) => c.name === "Dining Tables")?.path;
            expect(diningPath).toBe(
                `Furniture${CATEGORY_PATH_SEPARATOR}Tables${CATEGORY_PATH_SEPARATOR}Dining Tables`
            );
        });

        test("handles duplicate names in different branches", () => {
            // Create a tree with duplicate names in different branches
            const treeWithDuplicates: CategoryNode[] = [
                {
                    id: "branch-1",
                    name: "Living Room",
                    description: "",
                    children: [
                        {
                            id: "lr-sofas",
                            name: "Sofas",
                            description: "",
                            children: [],
                            productCount: 5,
                            hasImage: false,
                        },
                    ],
                    productCount: 0,
                    hasImage: false,
                },
                {
                    id: "branch-2",
                    name: "Office",
                    description: "",
                    children: [
                        {
                            id: "off-sofas",
                            name: "Sofas", // Same name, different branch
                            description: "",
                            children: [],
                            productCount: 3,
                            hasImage: false,
                        },
                    ],
                    productCount: 0,
                    hasImage: false,
                },
            ];

            const flat = flattenCategoryTreeWithPath(treeWithDuplicates);

            // Both "Sofas" should have unique paths
            const sofasPaths = flat.filter((c) => c.name === "Sofas").map((c) => c.path);
            expect(sofasPaths).toHaveLength(2);
            expect(sofasPaths).toContain(`Living Room${CATEGORY_PATH_SEPARATOR}Sofas`);
            expect(sofasPaths).toContain(`Office${CATEGORY_PATH_SEPARATOR}Sofas`);
        });

        test("returns empty array for empty input", () => {
            expect(flattenCategoryTreeWithPath([])).toHaveLength(0);
        });
    });

    describe("collectCategoryIdsByPath", () => {
        test("collects IDs using full paths as keys", () => {
            const tree = createTestTree();
            const ids = collectCategoryIdsByPath(tree);

            expect(ids.size).toBe(5);
            expect(ids.get("Furniture")).toBe("cat-1");
            expect(ids.get(`Furniture${CATEGORY_PATH_SEPARATOR}Beds`)).toBe("cat-1-1");
            expect(
                ids.get(
                    `Furniture${CATEGORY_PATH_SEPARATOR}Tables${CATEGORY_PATH_SEPARATOR}Dining Tables`
                )
            ).toBe("cat-1-2-1");
        });

        test("handles duplicate names with unique paths", () => {
            const treeWithDuplicates: CategoryNode[] = [
                {
                    id: "branch-1",
                    name: "Living Room",
                    description: "",
                    children: [
                        {
                            id: "lr-sofas",
                            name: "Sofas",
                            description: "",
                            children: [],
                            productCount: 0,
                            hasImage: false,
                        },
                    ],
                    productCount: 0,
                    hasImage: false,
                },
                {
                    id: "branch-2",
                    name: "Office",
                    description: "",
                    children: [
                        {
                            id: "off-sofas",
                            name: "Sofas",
                            description: "",
                            children: [],
                            productCount: 0,
                            hasImage: false,
                        },
                    ],
                    productCount: 0,
                    hasImage: false,
                },
            ];

            const ids = collectCategoryIdsByPath(treeWithDuplicates);

            // Both "Sofas" should be in the map with different keys
            expect(ids.size).toBe(4);
            expect(ids.get(`Living Room${CATEGORY_PATH_SEPARATOR}Sofas`)).toBe("lr-sofas");
            expect(ids.get(`Office${CATEGORY_PATH_SEPARATOR}Sofas`)).toBe("off-sofas");
        });

        test("skips categories without IDs", () => {
            const tree: CategoryNode[] = [
                {
                    name: "NoId",
                    description: "",
                    children: [],
                    productCount: 0,
                    hasImage: false,
                },
            ];
            const ids = collectCategoryIdsByPath(tree);

            expect(ids.size).toBe(0);
        });

        test("returns empty map for empty input", () => {
            expect(collectCategoryIdsByPath([]).size).toBe(0);
        });
    });
});

// =============================================================================
// Blueprint Category Utilities Tests
// =============================================================================

const createBlueprintTree = (): BlueprintCategory[] => [
    {
        id: "cat-1",
        name: "Furniture",
        description: "All furniture",
        level: 1,
        hasImage: true,
        children: [
            {
                id: "cat-1-1",
                name: "Beds",
                description: "Comfortable beds",
                level: 2,
                hasImage: true,
                children: [],
            },
            {
                id: "cat-1-2",
                name: "Tables",
                description: "Wooden tables",
                level: 2,
                hasImage: false,
                children: [
                    {
                        id: "cat-1-2-1",
                        name: "Dining Tables",
                        description: "For dining",
                        level: 3,
                        hasImage: false,
                        children: [],
                    },
                ],
            },
        ],
    },
    {
        id: "cat-2",
        name: "Electronics",
        description: "Electronic devices",
        level: 1,
        hasImage: false,
        children: [],
    },
];

describe("blueprint category utilities", () => {
    describe("convertBlueprintCategories", () => {
        test("converts blueprint categories to CategoryNode format", () => {
            const blueprintTree = createBlueprintTree();
            const categoryNodes = convertBlueprintCategories(blueprintTree);

            expect(categoryNodes).toHaveLength(2);

            // Check first category
            expect(categoryNodes[0]?.id).toBe("cat-1");
            expect(categoryNodes[0]?.name).toBe("Furniture");
            expect(categoryNodes[0]?.description).toBe("All furniture");
            expect(categoryNodes[0]?.hasImage).toBe(true);
            expect(categoryNodes[0]?.productCount).toBe(0);
            expect(categoryNodes[0]?.children).toHaveLength(2);

            // Check nested children
            const beds = categoryNodes[0]?.children[0];
            expect(beds?.id).toBe("cat-1-1");
            expect(beds?.name).toBe("Beds");
        });

        test("sets productCount to 0 for all categories", () => {
            const blueprintTree = createBlueprintTree();
            const categoryNodes = convertBlueprintCategories(blueprintTree);

            const checkProductCount = (nodes: CategoryNode[]): void => {
                for (const node of nodes) {
                    expect(node.productCount).toBe(0);
                    if (node.children.length > 0) {
                        checkProductCount(node.children);
                    }
                }
            };

            checkProductCount(categoryNodes);
        });

        test("preserves nested structure", () => {
            const blueprintTree = createBlueprintTree();
            const categoryNodes = convertBlueprintCategories(blueprintTree);

            // Navigate to Dining Tables
            const furniture = categoryNodes[0];
            const tables = furniture?.children[1];
            const diningTables = tables?.children[0];

            expect(diningTables?.name).toBe("Dining Tables");
            expect(diningTables?.id).toBe("cat-1-2-1");
        });

        test("returns empty array for empty input", () => {
            expect(convertBlueprintCategories([])).toHaveLength(0);
        });
    });

    describe("findCategoryPathById", () => {
        test("finds path for root category", () => {
            const blueprintTree = createBlueprintTree();
            const path = findCategoryPathById(blueprintTree, "cat-1");

            expect(path).toBe("Furniture");
        });

        test("finds path for nested category", () => {
            const blueprintTree = createBlueprintTree();
            const path = findCategoryPathById(blueprintTree, "cat-1-1");

            expect(path).toBe(`Furniture${CATEGORY_PATH_SEPARATOR}Beds`);
        });

        test("finds path for deeply nested category", () => {
            const blueprintTree = createBlueprintTree();
            const path = findCategoryPathById(blueprintTree, "cat-1-2-1");

            expect(path).toBe(
                `Furniture${CATEGORY_PATH_SEPARATOR}Tables${CATEGORY_PATH_SEPARATOR}Dining Tables`
            );
        });

        test("returns null for non-existent ID", () => {
            const blueprintTree = createBlueprintTree();
            const path = findCategoryPathById(blueprintTree, "non-existent");

            expect(path).toBeNull();
        });

        test("returns null for empty tree", () => {
            expect(findCategoryPathById([], "any-id")).toBeNull();
        });
    });

    describe("buildBlueprintCategoryPathMap", () => {
        test("builds map of paths to IDs", () => {
            const blueprintTree = createBlueprintTree();
            const pathMap = buildBlueprintCategoryPathMap(blueprintTree);

            expect(pathMap.size).toBe(5);
            expect(pathMap.get("Furniture")).toBe("cat-1");
            expect(pathMap.get(`Furniture${CATEGORY_PATH_SEPARATOR}Beds`)).toBe("cat-1-1");
            expect(pathMap.get(`Furniture${CATEGORY_PATH_SEPARATOR}Tables`)).toBe("cat-1-2");
            expect(
                pathMap.get(
                    `Furniture${CATEGORY_PATH_SEPARATOR}Tables${CATEGORY_PATH_SEPARATOR}Dining Tables`
                )
            ).toBe("cat-1-2-1");
            expect(pathMap.get("Electronics")).toBe("cat-2");
        });

        test("returns empty map for empty tree", () => {
            expect(buildBlueprintCategoryPathMap([]).size).toBe(0);
        });

        test("creates unique keys for duplicate names in different branches", () => {
            const treeWithDuplicates: BlueprintCategory[] = [
                {
                    id: "branch-1",
                    name: "Living Room",
                    description: "",
                    level: 1,
                    hasImage: false,
                    children: [
                        {
                            id: "lr-sofas",
                            name: "Sofas",
                            description: "",
                            level: 2,
                            hasImage: false,
                            children: [],
                        },
                    ],
                },
                {
                    id: "branch-2",
                    name: "Office",
                    description: "",
                    level: 1,
                    hasImage: false,
                    children: [
                        {
                            id: "off-sofas",
                            name: "Sofas",
                            description: "",
                            level: 2,
                            hasImage: false,
                            children: [],
                        },
                    ],
                },
            ];

            const pathMap = buildBlueprintCategoryPathMap(treeWithDuplicates);

            expect(pathMap.get(`Living Room${CATEGORY_PATH_SEPARATOR}Sofas`)).toBe("lr-sofas");
            expect(pathMap.get(`Office${CATEGORY_PATH_SEPARATOR}Sofas`)).toBe("off-sofas");
        });
    });
});
