/**
 * Shopware data export - fetches and validates existing data from Shopware
 */

import type {
    CategoryNode,
    ExportResult,
    ExportValidation,
    ProductInput,
    PropertyGroup,
    SalesChannelFull,
} from "../types/index.js";
import type { ExistingProperty } from "../utils/index.js";

import { createEmptyValidation, getValidationWarnings } from "../types/index.js";
import {
    countCategories,
    generateCategoryPlaceholder,
    generateProductPlaceholder,
    generatePropertyGroupPlaceholder,
    getLeafCategories,
    logger,
    normalizeDescription,
    normalizeString,
} from "../utils/index.js";

import { ShopwareClient } from "./client.js";

/** Default price for products without price */
const DEFAULT_PRODUCT_PRICE = 29.99;

/** Common Shopware search response structure */
interface SearchResponse<T> {
    total: number;
    data: T[];
}

/**
 * Normalize display type to valid enum value
 */
function normalizeDisplayType(displayType: string): "color" | "text" | "image" {
    const normalized = displayType.toLowerCase();
    if (normalized === "color") return "color";
    if (normalized === "image") return "image";
    return "text"; // Default fallback
}

/**
 * Shopware data exporter - fetches and validates existing data
 */
export class ShopwareExporter extends ShopwareClient {
    /**
     * Export all data from an existing SalesChannel.
     * Returns categories, products, and property groups in cache-compatible format.
     * Validates and normalizes data to match expected schema.
     */
    async exportSalesChannel(salesChannel: SalesChannelFull): Promise<ExportResult> {
        logger.cli(`Syncing existing data from SalesChannel "${salesChannel.name}"...`);

        const validation = createEmptyValidation();

        // Fetch categories with validation
        const categories = await this.exportCategories(
            salesChannel.navigationCategoryId,
            validation
        );
        logger.cli(`  Fetched ${countCategories(categories)} categories`);

        // Fetch products for each leaf category
        const products = new Map<string, ProductInput[]>();
        let productCount = 0;
        const leafCategories = getLeafCategories(categories);

        for (const leaf of leafCategories) {
            if (leaf.id) {
                const categoryProducts = await this.exportProductsInCategory(
                    leaf.id,
                    leaf.name,
                    validation
                );
                if (categoryProducts.length > 0) {
                    products.set(leaf.name, categoryProducts);
                    leaf.productCount = categoryProducts.length;
                    productCount += categoryProducts.length;
                }
            }
        }
        logger.cli(`  Fetched ${productCount} products`);

        // Fetch property groups with validation
        const propertyGroups = await this.exportPropertyGroups(validation);
        logger.cli(`  Fetched ${propertyGroups.length} property groups`);

        // Log validation warnings
        this.logValidationWarnings(validation);

        return { categories, products, propertyGroups, productCount, validation };
    }

    /**
     * Export category tree from a root category with validation
     */
    async exportCategories(
        rootCategoryId: string,
        validation: ExportValidation
    ): Promise<CategoryNode[]> {
        // Fetch all categories under the root with media association
        const response = await this.apiClient.post<
            SearchResponse<{
                id: string;
                name: string;
                description: string | null;
                parentId: string | null;
                childCount: number;
                mediaId: string | null;
            }>
        >("search/category", {
            limit: 500,
            filter: [{ type: "contains", field: "path", value: rootCategoryId }],
            sort: [{ field: "level", order: "ASC" }],
        });

        if (!response.ok || !response.data?.data) {
            return [];
        }

        const flatCategories = response.data.data;

        // Build tree structure with validation
        const categoryMap = new Map<string, CategoryNode>();
        const rootChildren: CategoryNode[] = [];

        // First pass: create all nodes with validation
        for (const cat of flatCategories) {
            // Validate and normalize description
            let description = cat.description || "";
            if (!description.trim()) {
                description = generateCategoryPlaceholder(cat.name);
                validation.categoriesWithoutDescription++;
            }

            // Check for media
            const hasImage = cat.mediaId !== null;
            if (hasImage) {
                validation.categoriesWithImages++;
            }

            categoryMap.set(cat.id, {
                id: cat.id,
                name: normalizeString(cat.name),
                description: normalizeDescription(description),
                children: [],
                productCount: 0,
                hasImage,
            });
        }

        // Second pass: build tree
        for (const cat of flatCategories) {
            const node = categoryMap.get(cat.id);
            if (!node) continue;

            if (cat.parentId === rootCategoryId) {
                rootChildren.push(node);
            } else if (cat.parentId) {
                const parent = categoryMap.get(cat.parentId);
                if (parent) {
                    parent.children.push(node);
                }
            }
        }

        return rootChildren;
    }

    /**
     * Export products from a specific category with validation
     */
    async exportProductsInCategory(
        categoryId: string,
        categoryName: string,
        validation: ExportValidation
    ): Promise<ProductInput[]> {
        const response = await this.apiClient.post<
            SearchResponse<{
                id: string;
                name: string;
                description: string | null;
                stock: number;
                price: Array<{ gross: number; net: number }>;
                options?: Array<{ id: string; name: string; colorHexCode?: string }>;
            }>
        >("search/product", {
            limit: 500,
            filter: [{ type: "equals", field: "categories.id", value: categoryId }],
            associations: {
                options: {},
            },
        });

        if (!response.ok || !response.data?.data) {
            return [];
        }

        return response.data.data.map((p) => {
            // Validate and normalize description
            let description = p.description || "";
            if (!description.trim()) {
                description = generateProductPlaceholder(p.name, categoryName);
                validation.productsWithoutDescription++;
            }

            // Validate and normalize price
            let price = p.price?.[0]?.gross ?? 0;
            if (price <= 0) {
                price = DEFAULT_PRODUCT_PRICE;
                validation.productsWithDefaultPrice++;
            }

            // Validate and normalize stock
            const stock = Math.max(0, p.stock || 0);

            // Normalize options if present
            const options = (p.options || []).map((o) => ({
                id: o.id,
                name: normalizeString(o.name),
                colorHexCode: o.colorHexCode,
            }));

            return {
                id: p.id,
                name: normalizeString(p.name),
                description: normalizeDescription(description),
                stock,
                price: Math.round(price * 100) / 100, // Round to 2 decimals
                options: options.length > 0 ? options : undefined,
            };
        });
    }

    /**
     * Get existing property groups from Shopware with IDs for reuse.
     * Returns property groups with their IDs and option IDs so that
     * the PropertyCollector can reuse them instead of creating duplicates.
     */
    async getExistingPropertyGroups(): Promise<ExistingProperty[]> {
        const response = await this.apiClient.post<
            SearchResponse<{
                id: string;
                name: string;
                displayType: string;
                options: Array<{ id: string; name: string; colorHexCode?: string }>;
            }>
        >("search/property-group", {
            limit: 100,
            associations: {
                options: { sort: [{ field: "position", order: "ASC" }] },
            },
        });

        if (!response.ok || !response.data?.data) {
            return [];
        }

        return response.data.data
            .filter((g) => g.options && g.options.length > 0)
            .map((g) => ({
                id: g.id,
                name: normalizeString(g.name),
                displayType: normalizeDisplayType(g.displayType),
                options: g.options.map((o) => ({
                    id: o.id,
                    name: normalizeString(o.name),
                    colorHexCode: o.colorHexCode,
                })),
            }));
    }

    /**
     * Export all property groups with validation
     */
    async exportPropertyGroups(validation: ExportValidation): Promise<PropertyGroup[]> {
        const response = await this.apiClient.post<
            SearchResponse<{
                id: string;
                name: string;
                description: string | null;
                displayType: string;
                sortingType: string;
                options: Array<{
                    id: string;
                    name: string;
                    colorHexCode?: string;
                    position: number;
                }>;
            }>
        >("search/property-group", {
            limit: 100,
            associations: {
                options: { sort: [{ field: "position", order: "ASC" }] },
            },
        });

        if (!response.ok || !response.data?.data) {
            return [];
        }

        const validGroups: PropertyGroup[] = [];

        for (const g of response.data.data) {
            // Skip groups without options
            if (!g.options || g.options.length === 0) {
                validation.propertyGroupsWithoutOptions++;
                continue;
            }

            // Normalize display type
            const displayType = normalizeDisplayType(g.displayType);

            // Validate and normalize options
            const options = g.options.map((o) => ({
                id: o.id,
                name: normalizeString(o.name),
                colorHexCode: displayType === "color" ? o.colorHexCode || "#000000" : undefined,
            }));

            validGroups.push({
                id: g.id,
                name: normalizeString(g.name),
                description: g.description || generatePropertyGroupPlaceholder(g.name),
                displayType,
                options,
            });
        }

        return validGroups;
    }

    /**
     * Log validation warnings for incomplete data
     */
    private logValidationWarnings(validation: ExportValidation): void {
        const warnings = getValidationWarnings(validation);

        if (warnings.length > 0) {
            logger.cli("  ⚠️  Data quality warnings:");
            for (const warning of warnings) {
                logger.cli(`     - ${warning}`);
            }
        }

        if (validation.categoriesWithImages > 0) {
            logger.cli(
                `  ℹ️  ${validation.categoriesWithImages} categories have images (will be preserved)`
            );
        }
    }
}
