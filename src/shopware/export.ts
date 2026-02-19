/**
 * Shopware data export - fetches and validates existing data from Shopware.
 * Uses the official @shopware/api-client invoke() for all API calls.
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
import type { Schemas } from "./admin-client.js";
import type { SearchResult } from "./api-types.js";

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

/**
 * Normalize display type to valid enum value
 */
function normalizeDisplayType(displayType: string): "color" | "text" | "image" {
    const normalized = displayType.toLowerCase();
    if (normalized === "color") return "color";
    if (normalized === "image") return "image";
    return "text";
}

/**
 * Shopware data exporter - fetches and validates existing data
 */
export class ShopwareExporter extends ShopwareClient {
    /**
     * Export all data from an existing SalesChannel.
     */
    async exportSalesChannel(salesChannel: SalesChannelFull): Promise<ExportResult> {
        logger.info(`Syncing existing data from SalesChannel "${salesChannel.name}"...`, {
            cli: true,
        });

        const validation = createEmptyValidation();

        const categories = await this.exportCategories(
            salesChannel.navigationCategoryId,
            validation
        );
        logger.info(`  Fetched ${countCategories(categories)} categories`, { cli: true });

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
        logger.info(`  Fetched ${productCount} products`, { cli: true });

        const propertyGroups = await this.exportPropertyGroups(validation);
        logger.info(`  Fetched ${propertyGroups.length} property groups`, { cli: true });

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
        const { data: searchData } = await this.getClient().invoke(
            "searchCategory post /search/category",
            {
                body: {
                    limit: 500,
                    filter: [
                        {
                            type: "contains",
                            field: "path",
                            value: rootCategoryId,
                        },
                    ],
                    sort: [{ field: "level", order: "ASC" }],
                },
            }
        );
        const result = searchData as SearchResult<Schemas["Category"]>;

        const flatCategories = result.data ?? [];

        // Build tree structure with validation
        const categoryMap = new Map<string, CategoryNode>();
        const rootChildren: CategoryNode[] = [];

        // First pass: create all nodes with validation
        for (const cat of flatCategories) {
            let description = cat.description || "";
            if (!description.trim()) {
                description = generateCategoryPlaceholder(cat.name ?? "");
                validation.categoriesWithoutDescription++;
            }

            const hasImage = cat.mediaId !== null && cat.mediaId !== undefined;
            if (hasImage) {
                validation.categoriesWithImages++;
            }

            categoryMap.set(cat.id, {
                id: cat.id,
                name: normalizeString(cat.name ?? ""),
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
        const { data: productSearchData } = await this.getClient().invoke(
            "searchProduct post /search/product",
            {
                body: {
                    limit: 500,
                    filter: [
                        {
                            type: "equals",
                            field: "categories.id",
                            value: categoryId,
                        },
                    ],
                    associations: { options: {} },
                },
            }
        );
        const productResult = productSearchData as SearchResult<Schemas["Product"]>;

        return (productResult.data ?? []).map((p) => {
            let description = p.description || "";
            if (!description.trim()) {
                description = generateProductPlaceholder(p.name ?? "", categoryName);
                validation.productsWithoutDescription++;
            }

            let price = p.price?.[0]?.gross ?? 0;
            if (price <= 0) {
                price = DEFAULT_PRODUCT_PRICE;
                validation.productsWithDefaultPrice++;
            }

            const stock = Math.max(0, p.stock || 0);

            const options = (p.options ?? []).map((o) => ({
                id: o.id,
                name: normalizeString(o.name),
                colorHexCode: o.colorHexCode,
            }));

            return {
                id: p.id,
                name: normalizeString(p.name ?? ""),
                description: normalizeDescription(description),
                stock,
                price: Math.round(price * 100) / 100,
                options: options.length > 0 ? options : undefined,
            };
        });
    }

    /**
     * Get existing property groups from Shopware with IDs for reuse.
     */
    async getExistingPropertyGroups(): Promise<ExistingProperty[]> {
        const { data: propGroupData } = await this.getClient().invoke(
            "searchPropertyGroup post /search/property-group",
            {
                body: {
                    limit: 100,
                    associations: {
                        options: {
                            sort: [{ field: "position", order: "ASC" }],
                        },
                    },
                },
            }
        );
        const propGroupResult = propGroupData as SearchResult<Schemas["PropertyGroup"]>;

        return (propGroupResult.data ?? [])
            .filter((g) => (g.options ?? []).length > 0)
            .map((g) => {
                const displayType = normalizeDisplayType(g.displayType ?? "text");
                return {
                    id: g.id,
                    name: normalizeString(g.name ?? ""),
                    displayType,
                    options: (g.options ?? []).map((o) => ({
                        id: o.id,
                        name: normalizeString(o.name),
                        colorHexCode: o.colorHexCode,
                    })),
                };
            });
    }

    /**
     * Export all property groups with validation
     */
    async exportPropertyGroups(validation: ExportValidation): Promise<PropertyGroup[]> {
        const { data: exportPropData } = await this.getClient().invoke(
            "searchPropertyGroup post /search/property-group",
            {
                body: {
                    limit: 100,
                    associations: {
                        options: {
                            sort: [{ field: "position", order: "ASC" }],
                        },
                    },
                },
            }
        );
        const exportPropResult = exportPropData as SearchResult<Schemas["PropertyGroup"]>;

        const validGroups: PropertyGroup[] = [];

        for (const g of exportPropResult.data ?? []) {
            const options = g.options ?? [];

            if (options.length === 0) {
                validation.propertyGroupsWithoutOptions++;
                continue;
            }

            const displayType = normalizeDisplayType(g.displayType ?? "text");

            const normalizedOptions = options.map((o) => ({
                id: o.id,
                name: normalizeString(o.name),
                colorHexCode: displayType === "color" ? o.colorHexCode || "#000000" : undefined,
            }));

            validGroups.push({
                id: g.id,
                name: normalizeString(g.name ?? ""),
                description: g.description || generatePropertyGroupPlaceholder(g.name ?? ""),
                displayType,
                options: normalizedOptions,
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
            logger.warn("  ⚠️  Data quality warnings:", { cli: true });
            for (const warning of warnings) {
                logger.warn(`     - ${warning}`, { cli: true });
            }
        }

        if (validation.categoriesWithImages > 0) {
            logger.info(
                `  ℹ️  ${validation.categoriesWithImages} categories have images (will be preserved)`,
                { cli: true }
            );
        }
    }
}
