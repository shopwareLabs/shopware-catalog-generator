/**
 * Types for data export/sync operations
 */

import type { CategoryNode, ProductInput, PropertyGroup } from "./shopware.js";

/**
 * Validation statistics for exported data
 * Tracks data quality issues found during export
 */
export interface ExportValidation {
    /** Categories with empty or missing descriptions */
    categoriesWithoutDescription: number;
    /** Categories that have associated media/images */
    categoriesWithImages: number;
    /** Products with empty or missing descriptions */
    productsWithoutDescription: number;
    /** Products with zero or missing prices (default applied) */
    productsWithDefaultPrice: number;
    /** Property groups without any options (skipped) */
    propertyGroupsWithoutOptions: number;
}

/**
 * Result of exporting a SalesChannel's data
 */
export interface ExportResult {
    /** Exported category tree */
    categories: CategoryNode[];
    /** Products grouped by category name */
    products: Map<string, ProductInput[]>;
    /** Exported property groups */
    propertyGroups: PropertyGroup[];
    /** Total number of products exported */
    productCount: number;
    /** Validation statistics */
    validation: ExportValidation;
}

/**
 * Create an empty ExportValidation object
 */
export function createEmptyValidation(): ExportValidation {
    return {
        categoriesWithoutDescription: 0,
        categoriesWithImages: 0,
        productsWithoutDescription: 0,
        productsWithDefaultPrice: 0,
        propertyGroupsWithoutOptions: 0,
    };
}

/**
 * Get validation warning messages
 */
export function getValidationWarnings(validation: ExportValidation): string[] {
    const warnings: string[] = [];

    if (validation.categoriesWithoutDescription > 0) {
        warnings.push(
            `${validation.categoriesWithoutDescription} categories without descriptions (placeholder added)`
        );
    }
    if (validation.productsWithoutDescription > 0) {
        warnings.push(
            `${validation.productsWithoutDescription} products without descriptions (placeholder added)`
        );
    }
    if (validation.productsWithDefaultPrice > 0) {
        warnings.push(
            `${validation.productsWithDefaultPrice} products with missing/zero price (default applied)`
        );
    }
    if (validation.propertyGroupsWithoutOptions > 0) {
        warnings.push(
            `${validation.propertyGroupsWithoutOptions} property groups without options (skipped)`
        );
    }

    return warnings;
}
