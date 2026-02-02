/**
 * Blueprint Validation
 *
 * Validates hydrated blueprints before syncing to Shopware.
 * Can auto-fix common issues like duplicate names.
 */

import type { HydratedBlueprint } from "../types/index.js";

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
function findDuplicateProductNames(
    blueprint: HydratedBlueprint
): Map<string, string[]> {
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
function findDuplicateCategoryNames(
    blueprint: HydratedBlueprint
): Map<string, string[]> {
    const nameToIds = new Map<string, string[]>();

    function collectCategories(
        categories: HydratedBlueprint["categories"],
        parentPath = ""
    ): void {
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
    return blueprint.products
        .filter((p) => isPlaceholder(p.name))
        .map((p) => p.id);
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
                    console.log(`  Fixed duplicate: "${name}" → "${newName}"`);
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
                console.log(`  ✓ Fixed ${fixesApplied} duplicate product names`);
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
        return [{
            type: "error",
            code: "MISSING_SALES_CHANNEL_NAME",
            message: "Blueprint is missing sales channel name",
            field: "salesChannel.name",
        }];
    }
    return [];
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

    // 2. Check Color properties have hex codes
    const colorGroups = blueprint.propertyGroups.filter(
        (g) => g.name.toLowerCase().includes("color")
    );
    for (const colorGroup of colorGroups) {
        const missingHex = colorGroup.options.filter((o) => !o.colorHexCode);
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
    const validGroupNames = new Set(
        blueprint.propertyGroups.map((g) => g.name.toLowerCase())
    );

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
 * - Duplicate product names
 * - Duplicate category names (at same level)
 * - Placeholder names (not hydrated)
 * - Missing required fields
 * - Property group validation (names, options, hex codes)
 * - Orphan property references
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
        console.log("Validating blueprint...");
    }

    // Run all validations
    const productValidation = validateProducts(blueprint, autoFix, logFixes);
    const categoryIssues = validateCategories(blueprint);
    const metaIssues = validateBlueprintMeta(blueprint);
    const propertyIssues = validatePropertyGroups(blueprint);

    // Collect all issues
    const allIssues = [
        ...productValidation.issues,
        ...categoryIssues,
        ...metaIssues,
        ...propertyIssues,
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
