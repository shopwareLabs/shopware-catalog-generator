/**
 * Blueprint Validation
 *
 * Validates hydrated blueprints before syncing to Shopware.
 * Can auto-fix common issues like duplicate names.
 */

import type { HydratedBlueprint } from "../types/index.js";

import { logger } from "./logger.js";

// =============================================================================
// Types
// =============================================================================

export interface BlueprintValidationIssue {
    type: "error" | "warning";
    code: string;
    message: string;
    field?: string;
    /** IDs of affected entities */
    affectedIds?: string[];
}

export interface BlueprintValidationResult {
    valid: boolean;
    issues: BlueprintValidationIssue[];
    /** Number of auto-fixes applied */
    fixesApplied: number;
}

export interface BlueprintValidationOptions {
    /** Attempt to auto-fix issues (default: false) */
    autoFix?: boolean;
    /** Log fixes to console (default: true) */
    logFixes?: boolean;
}

// =============================================================================
// Placeholder Patterns (exported for reuse in E2E verification)
// =============================================================================

/** Patterns that indicate placeholder names (not hydrated by AI) */
export const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
    /^Top Category \d+$/,
    /^Category L\d+-\d+$/,
    /^Product \d+$/,
    /^(First |Second |Third |Fourth |Fifth )?Top Level Category$/,
    /^Subcategory [A-Z]$/,
    /^Placeholder/i,
];

/** Check if a name is a placeholder (not hydrated by AI) */
export function isPlaceholder(name: string): boolean {
    return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(name));
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Find duplicate product names in the blueprint
 */
function findDuplicateProductNames(blueprint: HydratedBlueprint): Map<string, string[]> {
    const nameToIds = new Map<string, string[]>();

    for (const product of blueprint.products) {
        const name = product.name;
        const existing = nameToIds.get(name) || [];
        existing.push(product.id);
        nameToIds.set(name, existing);
    }

    // Return only duplicates
    const duplicates = new Map<string, string[]>();
    for (const [name, ids] of nameToIds) {
        if (ids.length > 1) {
            duplicates.set(name, ids);
        }
    }
    return duplicates;
}

/**
 * Find duplicate category names at the same level
 */
function findDuplicateCategoryNames(blueprint: HydratedBlueprint): Map<string, string[]> {
    const nameToIds = new Map<string, string[]>();

    function collectCategories(categories: HydratedBlueprint["categories"], parentPath = ""): void {
        for (const cat of categories) {
            const key = `${parentPath}/${cat.name}`;
            const existing = nameToIds.get(key) || [];
            existing.push(cat.id);
            nameToIds.set(key, existing);

            if (cat.children && cat.children.length > 0) {
                collectCategories(cat.children, key);
            }
        }
    }

    collectCategories(blueprint.categories);

    // Return only duplicates
    const duplicates = new Map<string, string[]>();
    for (const [name, ids] of nameToIds) {
        if (ids.length > 1) {
            // Extract just the category name from the path
            const catName = name.split("/").pop() || name;
            duplicates.set(catName, ids);
        }
    }
    return duplicates;
}

/**
 * Find placeholder product names
 */
function findPlaceholderProducts(blueprint: HydratedBlueprint): string[] {
    return blueprint.products.filter((p) => isPlaceholder(p.name)).map((p) => p.id);
}

/**
 * Find placeholder category names
 */
function findPlaceholderCategories(blueprint: HydratedBlueprint): string[] {
    const placeholders: string[] = [];

    function checkCategories(categories: HydratedBlueprint["categories"]): void {
        for (const cat of categories) {
            if (isPlaceholder(cat.name)) {
                placeholders.push(cat.id);
            }
            if (cat.children && cat.children.length > 0) {
                checkCategories(cat.children);
            }
        }
    }

    checkCategories(blueprint.categories);
    return placeholders;
}

// =============================================================================
// Auto-Fix Functions
// =============================================================================

/**
 * Fix duplicate product names by appending a suffix
 */
function fixDuplicateProductNames(
    blueprint: HydratedBlueprint,
    duplicates: Map<string, string[]>,
    logFixes: boolean
): number {
    let fixCount = 0;

    for (const [name, ids] of duplicates) {
        // Keep the first one as-is, rename the rest
        for (let i = 1; i < ids.length; i++) {
            const product = blueprint.products.find((p) => p.id === ids[i]);
            if (product) {
                const newName = `${name} (${i + 1})`;
                if (logFixes) {
                    logger.info(`  Fixed duplicate: "${name}" → "${newName}"`, { cli: true });
                }
                product.name = newName;
                fixCount++;
            }
        }
    }

    return fixCount;
}

// =============================================================================
// Focused Validation Functions
// =============================================================================

/**
 * Validate product-related issues
 */
function validateProducts(
    blueprint: HydratedBlueprint,
    autoFix: boolean,
    logFixes: boolean
): { issues: BlueprintValidationIssue[]; fixesApplied: number } {
    const issues: BlueprintValidationIssue[] = [];
    let fixesApplied = 0;

    // Check for duplicate product names
    const duplicateProducts = findDuplicateProductNames(blueprint);
    if (duplicateProducts.size > 0) {
        if (autoFix) {
            fixesApplied = fixDuplicateProductNames(blueprint, duplicateProducts, logFixes);
            if (logFixes) {
                logger.info(`  ✓ Fixed ${fixesApplied} duplicate product names`, { cli: true });
            }
        } else {
            for (const [name, ids] of duplicateProducts) {
                issues.push({
                    type: "error",
                    code: "DUPLICATE_PRODUCT_NAME",
                    message: `Duplicate product name: "${name}" (${ids.length} products)`,
                    field: "products[].name",
                    affectedIds: ids,
                });
            }
        }
    }

    // Check for placeholder products
    const placeholderProducts = findPlaceholderProducts(blueprint);
    if (placeholderProducts.length > 0) {
        issues.push({
            type: "error",
            code: "PLACEHOLDER_PRODUCT_NAME",
            message: `Found ${placeholderProducts.length} placeholder product names (not hydrated by AI)`,
            field: "products[].name",
            affectedIds: placeholderProducts,
        });
    }

    // Check for empty products
    if (blueprint.products.length === 0) {
        issues.push({
            type: "error",
            code: "NO_PRODUCTS",
            message: "Blueprint has no products",
            field: "products",
        });
    }

    return { issues, fixesApplied };
}

/**
 * Validate category-related issues
 */
function validateCategories(blueprint: HydratedBlueprint): BlueprintValidationIssue[] {
    const issues: BlueprintValidationIssue[] = [];

    // Check for duplicate category names
    const duplicateCategories = findDuplicateCategoryNames(blueprint);
    for (const [name, ids] of duplicateCategories) {
        issues.push({
            type: "warning",
            code: "DUPLICATE_CATEGORY_NAME",
            message: `Duplicate category name at same level: "${name}" (${ids.length} categories)`,
            field: "categories[].name",
            affectedIds: ids,
        });
    }

    // Check for placeholder categories
    const placeholderCategories = findPlaceholderCategories(blueprint);
    if (placeholderCategories.length > 0) {
        issues.push({
            type: "error",
            code: "PLACEHOLDER_CATEGORY_NAME",
            message: `Found ${placeholderCategories.length} placeholder category names (not hydrated by AI)`,
            field: "categories[].name",
            affectedIds: placeholderCategories,
        });
    }

    // Check for empty categories
    if (blueprint.categories.length === 0) {
        issues.push({
            type: "error",
            code: "NO_CATEGORIES",
            message: "Blueprint has no categories",
            field: "categories",
        });
    }

    return issues;
}

/**
 * Validate blueprint metadata
 */
function validateBlueprintMeta(blueprint: HydratedBlueprint): BlueprintValidationIssue[] {
    if (!blueprint.salesChannel?.name) {
        return [
            {
                type: "error",
                code: "MISSING_SALES_CHANNEL_NAME",
                message: "Blueprint is missing sales channel name",
                field: "salesChannel.name",
            },
        ];
    }
    return [];
}

// =============================================================================
// Category Assignment Validation Functions
// =============================================================================

/**
 * Build a set of all category IDs in the blueprint
 */
function collectAllCategoryIds(categories: HydratedBlueprint["categories"]): Set<string> {
    const ids = new Set<string>();

    function collect(cats: HydratedBlueprint["categories"]): void {
        for (const cat of cats) {
            ids.add(cat.id);
            if (cat.children && cat.children.length > 0) {
                collect(cat.children);
            }
        }
    }

    collect(categories);
    return ids;
}

/**
 * Get set of top-level category IDs
 */
function getTopLevelCategoryIds(categories: HydratedBlueprint["categories"]): Set<string> {
    return new Set(categories.map((c) => c.id));
}

/**
 * Validate product category assignments
 *
 * Checks for:
 * - Products referencing non-existent categories
 * - Products only assigned to top-level categories (should have subcategories)
 * - Products with empty categoryIds
 */
function validateCategoryAssignments(blueprint: HydratedBlueprint): BlueprintValidationIssue[] {
    const issues: BlueprintValidationIssue[] = [];

    const allCategoryIds = collectAllCategoryIds(blueprint.categories);
    const topLevelIds = getTopLevelCategoryIds(blueprint.categories);

    const productsWithInvalidCategories: string[] = [];
    const productsOnlyInTopLevel: string[] = [];
    const productsWithNoCategories: string[] = [];

    for (const product of blueprint.products) {
        // Check for empty categoryIds
        if (!product.categoryIds || product.categoryIds.length === 0) {
            productsWithNoCategories.push(product.id);
            continue;
        }

        // Check for invalid category references
        const invalidCats = product.categoryIds.filter((id) => !allCategoryIds.has(id));
        if (invalidCats.length > 0) {
            productsWithInvalidCategories.push(product.id);
        }

        // Check if product is only in top-level categories
        const hasSubcategory = product.categoryIds.some((id) => !topLevelIds.has(id));
        if (!hasSubcategory && product.categoryIds.length > 0) {
            productsOnlyInTopLevel.push(product.id);
        }
    }

    if (productsWithNoCategories.length > 0) {
        issues.push({
            type: "error",
            code: "PRODUCTS_NO_CATEGORIES",
            message: `${productsWithNoCategories.length} products have no category assignments`,
            field: "products[].categoryIds",
            affectedIds: productsWithNoCategories,
        });
    }

    if (productsWithInvalidCategories.length > 0) {
        issues.push({
            type: "error",
            code: "INVALID_CATEGORY_REFERENCE",
            message: `${productsWithInvalidCategories.length} products reference non-existent categories`,
            field: "products[].categoryIds",
            affectedIds: productsWithInvalidCategories,
        });
    }

    if (productsOnlyInTopLevel.length > 0) {
        issues.push({
            type: "warning",
            code: "PRODUCTS_ONLY_TOP_LEVEL",
            message: `${productsOnlyInTopLevel.length} products only assigned to top-level categories (missing subcategory assignment)`,
            field: "products[].categoryIds",
            affectedIds: productsOnlyInTopLevel,
        });
    }

    return issues;
}

// =============================================================================
// Image Validation Functions
// =============================================================================

/**
 * Validate product image metadata
 *
 * Checks for:
 * - Products missing imageDescriptions
 * - Products with empty image prompts
 */
function validateImageDescriptions(blueprint: HydratedBlueprint): BlueprintValidationIssue[] {
    const issues: BlueprintValidationIssue[] = [];

    const productsWithoutImages: string[] = [];
    const productsWithEmptyPrompts: string[] = [];

    for (const product of blueprint.products) {
        const imageDescs = product.metadata?.imageDescriptions;

        // Check for missing imageDescriptions
        if (!imageDescs || imageDescs.length === 0) {
            productsWithoutImages.push(product.id);
            continue;
        }

        // Check for empty prompts
        const hasEmptyPrompt = imageDescs.some((desc) => !desc.prompt || desc.prompt.trim() === "");
        if (hasEmptyPrompt) {
            productsWithEmptyPrompts.push(product.id);
        }
    }

    if (productsWithoutImages.length > 0) {
        issues.push({
            type: "warning",
            code: "PRODUCTS_NO_IMAGE_DESCRIPTIONS",
            message: `${productsWithoutImages.length} products have no image descriptions`,
            field: "products[].metadata.imageDescriptions",
            affectedIds: productsWithoutImages,
        });
    }

    if (productsWithEmptyPrompts.length > 0) {
        issues.push({
            type: "warning",
            code: "PRODUCTS_EMPTY_IMAGE_PROMPTS",
            message: `${productsWithEmptyPrompts.length} products have empty image prompts`,
            field: "products[].metadata.imageDescriptions[].prompt",
            affectedIds: productsWithEmptyPrompts,
        });
    }

    return issues;
}

/**
 * Validate product metadata completeness
 *
 * Checks for:
 * - Products missing properties
 * - Products missing manufacturer
 */
function validateProductMetadata(blueprint: HydratedBlueprint): BlueprintValidationIssue[] {
    const issues: BlueprintValidationIssue[] = [];

    const productsWithoutProperties: string[] = [];
    const productsWithoutManufacturer: string[] = [];

    for (const product of blueprint.products) {
        // Check for missing properties
        if (!product.metadata?.properties || product.metadata.properties.length === 0) {
            productsWithoutProperties.push(product.id);
        }

        // Check for missing manufacturer
        if (!product.metadata?.manufacturerName) {
            productsWithoutManufacturer.push(product.id);
        }
    }

    if (productsWithoutProperties.length > 0) {
        issues.push({
            type: "warning",
            code: "PRODUCTS_NO_PROPERTIES",
            message: `${productsWithoutProperties.length} products have no properties defined`,
            field: "products[].metadata.properties",
            affectedIds: productsWithoutProperties,
        });
    }

    if (productsWithoutManufacturer.length > 0) {
        issues.push({
            type: "warning",
            code: "PRODUCTS_NO_MANUFACTURER",
            message: `${productsWithoutManufacturer.length} products have no manufacturer assigned`,
            field: "products[].metadata.manufacturerName",
            affectedIds: productsWithoutManufacturer,
        });
    }

    return issues;
}

// =============================================================================
// Property Validation Functions
// =============================================================================

/**
 * Validate property groups in the blueprint
 *
 * Checks for:
 * - Property groups have required fields (name, options)
 * - Color properties have hex codes
 * - Product properties reference valid groups
 */
function validatePropertyGroups(blueprint: HydratedBlueprint): BlueprintValidationIssue[] {
    const issues: BlueprintValidationIssue[] = [];

    // Skip if no property groups
    if (!blueprint.propertyGroups || blueprint.propertyGroups.length === 0) {
        return issues;
    }

    // 1. Check property groups have required fields
    for (const group of blueprint.propertyGroups) {
        if (!group.name || group.name.trim() === "") {
            issues.push({
                type: "error",
                code: "MISSING_PROPERTY_GROUP_NAME",
                message: "Property group is missing name",
                field: "propertyGroups[].name",
                affectedIds: [group.id],
            });
        }

        if (!group.options || group.options.length === 0) {
            issues.push({
                type: "error",
                code: "EMPTY_PROPERTY_OPTIONS",
                message: `Property group "${group.name}" has no options`,
                field: "propertyGroups[].options",
                affectedIds: [group.id],
            });
        }
    }

    // 2. Check Color properties have hex codes (excluding image-based colors)
    const imageColorNames = [
        "multicolor",
        "multi-color",
        "rainbow",
        "assorted",
        "mixed",
        "patterned",
        "printed",
        "gradient",
    ];
    const colorGroups = blueprint.propertyGroups.filter((g) =>
        g.name.toLowerCase().includes("color")
    );
    for (const colorGroup of colorGroups) {
        const missingHex = colorGroup.options.filter(
            (o) => !o.colorHexCode && !imageColorNames.includes(o.name.toLowerCase())
        );
        if (missingHex.length > 0) {
            issues.push({
                type: "warning",
                code: "MISSING_COLOR_HEX",
                message: `Color options missing hex codes: ${missingHex.map((o) => o.name).join(", ")}`,
                field: "propertyGroups[].options[].colorHexCode",
            });
        }
    }

    // 3. Check product properties reference valid groups
    const validGroupNames = new Set(blueprint.propertyGroups.map((g) => g.name.toLowerCase()));

    for (const product of blueprint.products) {
        if (!product.metadata.properties) continue;

        for (const prop of product.metadata.properties) {
            if (!validGroupNames.has(prop.group.toLowerCase())) {
                issues.push({
                    type: "warning",
                    code: "ORPHAN_PROPERTY_REFERENCE",
                    message: `Product "${product.name}" references non-existent property group "${prop.group}"`,
                    field: "products[].metadata.properties",
                    affectedIds: [product.id],
                });
            }
        }
    }

    return issues;
}

// =============================================================================
// Main Validation Function
// =============================================================================

/**
 * Validate a hydrated blueprint before syncing to Shopware.
 *
 * Checks for:
 * - Duplicate product names (auto-fixable)
 * - Duplicate category names (at same level)
 * - Placeholder names (not hydrated)
 * - Missing required fields
 * - Property group validation (names, options, hex codes)
 * - Orphan property references
 * - Category assignment issues (no categories, invalid refs, top-level only)
 * - Image description issues (missing or empty prompts)
 * - Product metadata completeness (properties, manufacturer)
 *
 * @param blueprint - The hydrated blueprint to validate
 * @param options - Validation options
 * @returns Validation result with issues and fix count
 */
export function validateBlueprint(
    blueprint: HydratedBlueprint,
    options: BlueprintValidationOptions = {}
): BlueprintValidationResult {
    const { autoFix = false, logFixes = true } = options;

    if (logFixes && autoFix) {
        logger.info("Validating blueprint...", { cli: true });
    }

    // Run all validations
    const productValidation = validateProducts(blueprint, autoFix, logFixes);
    const categoryIssues = validateCategories(blueprint);
    const metaIssues = validateBlueprintMeta(blueprint);
    const propertyIssues = validatePropertyGroups(blueprint);
    const categoryAssignmentIssues = validateCategoryAssignments(blueprint);
    const imageIssues = validateImageDescriptions(blueprint);
    const metadataIssues = validateProductMetadata(blueprint);

    // Collect all issues
    const allIssues = [
        ...productValidation.issues,
        ...categoryIssues,
        ...metaIssues,
        ...propertyIssues,
        ...categoryAssignmentIssues,
        ...imageIssues,
        ...metadataIssues,
    ];

    // Filter out issues that were fixed
    const remainingIssues = autoFix
        ? allIssues.filter((i) => i.code !== "DUPLICATE_PRODUCT_NAME")
        : allIssues;

    const hasErrors = remainingIssues.some((i) => i.type === "error");

    return {
        valid: !hasErrors,
        issues: remainingIssues,
        fixesApplied: productValidation.fixesApplied,
    };
}

/**
 * Quick check if blueprint has any issues (without auto-fix)
 */
export function hasValidationIssues(blueprint: HydratedBlueprint): boolean {
    const result = validateBlueprint(blueprint, { autoFix: false, logFixes: false });
    return !result.valid;
}
