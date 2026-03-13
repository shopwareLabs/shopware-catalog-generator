/**
 * Shared test fixtures for HydratedBlueprint, products, and categories.
 *
 * Replaces the per-file createMockBlueprint() / createMockProduct() helpers
 * that were duplicated across 11+ post-processor test files.
 */

import type {
    BlueprintCategory,
    BlueprintProduct,
    HydratedBlueprint,
    ProductMetadata,
} from "../../src/types/index.js";

import { createMockProductMetadata } from "../mocks/index.js";

type TestProductOverrides = Omit<Partial<BlueprintProduct>, "metadata"> & {
    metadata?: Partial<ProductMetadata>;
};

export function createTestProduct(overrides: TestProductOverrides = {}): BlueprintProduct {
    const { metadata: metadataOverrides, ...rest } = overrides;
    return {
        id: "prod-1",
        name: "Test Product",
        description: "Test description",
        price: 29.99,
        stock: 10,
        primaryCategoryId: "cat-1",
        categoryIds: ["cat-1"],
        metadata: createMockProductMetadata(metadataOverrides),
        ...rest,
    };
}

export function createTestCategory(overrides: Partial<BlueprintCategory> = {}): BlueprintCategory {
    return {
        id: "cat-1",
        name: "Test Category",
        description: "Test category description",
        level: 1,
        hasImage: false,
        children: [],
        ...overrides,
    };
}

export function createTestBlueprint(
    overrides: Partial<HydratedBlueprint> & {
        products?: BlueprintProduct[];
        categories?: BlueprintCategory[];
    } = {}
): HydratedBlueprint {
    return {
        version: "1.0",
        salesChannel: { name: "test-store", description: "Test store" },
        categories: overrides.categories ?? [],
        products: overrides.products ?? [],
        propertyGroups: [],
        createdAt: new Date().toISOString(),
        hydratedAt: new Date().toISOString(),
        ...overrides,
    };
}
