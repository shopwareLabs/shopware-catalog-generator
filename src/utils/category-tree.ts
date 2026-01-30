/**
 * Category tree manipulation utilities
 */

import type { BlueprintCategory, CategoryNode } from "../types/index.js";

/**
 * Flattened category with parent reference
 */
export interface FlatCategory {
    id?: string;
    name: string;
    description: string;
    parentName: string | null;
    productCount: number;
    hasImage: boolean;
}

/**
 * Flattened category with full path for unique identification
 */
export interface FlatCategoryWithPath extends FlatCategory {
    /** Full path from root, e.g., "Living Room > Sofas > Leather" */
    path: string;
}

/** Separator used for category paths */
export const CATEGORY_PATH_SEPARATOR = " > ";

/**
 * Build a full category path from parent path and category name
 *
 * @param parentPath - The parent category's path (null for root categories)
 * @param name - The current category's name
 * @returns Full path like "Living Room > Sofas > Leather"
 */
export function buildCategoryPath(parentPath: string | null, name: string): string {
    if (parentPath === null || parentPath === "") {
        return name;
    }
    return `${parentPath}${CATEGORY_PATH_SEPARATOR}${name}`;
}

/** Tree node with children (works with CategoryNode, BlueprintCategory, etc.) */
interface TreeNode {
    children: TreeNode[];
}

/**
 * Count total categories in a tree
 *
 * @param nodes - Array of tree nodes with children
 * @returns Total count of categories including children
 */
export function countCategories<T extends TreeNode>(nodes: T[]): number {
    return nodes.reduce((acc, node) => acc + 1 + countCategories(node.children as T[]), 0);
}

/**
 * Count total products allocated across all categories
 *
 * @param nodes - Array of category nodes
 * @returns Total product count
 */
export function countProducts(nodes: CategoryNode[]): number {
    return nodes.reduce((acc, node) => acc + node.productCount + countProducts(node.children), 0);
}

/**
 * Get all leaf categories (categories with no children)
 *
 * @param nodes - Array of category nodes
 * @returns Array of leaf categories
 */
export function getLeafCategories(nodes: CategoryNode[]): CategoryNode[] {
    const leaves: CategoryNode[] = [];
    for (const node of nodes) {
        if (node.children.length === 0) {
            leaves.push(node);
        } else {
            leaves.push(...getLeafCategories(node.children));
        }
    }
    return leaves;
}

/**
 * Get leaf categories that have products allocated
 *
 * @param nodes - Array of category nodes
 * @returns Array of leaf categories with productCount > 0
 */
export function getLeafCategoriesWithProducts(nodes: CategoryNode[]): CategoryNode[] {
    return getLeafCategories(nodes).filter((node) => node.productCount > 0);
}

/**
 * Redistribute products across leaf categories.
 * First leaf gets 25 products (for pagination), rest distributed evenly.
 * Modifies the tree in place.
 *
 * @param nodes - Array of category nodes to modify
 * @param totalProducts - Total number of products to distribute
 */
export function redistributeProductsToTree(nodes: CategoryNode[], totalProducts: number): void {
    const MIN_PRODUCTS_FOR_PAGINATION = 25;

    // Reset all product counts
    resetProductCounts(nodes);

    // Get leaf categories
    const leaves = getLeafCategories(nodes);

    const firstLeaf = leaves[0];
    if (!firstLeaf) {
        return;
    }

    if (leaves.length === 1) {
        firstLeaf.productCount = totalProducts;
        return;
    }

    // First category gets at least MIN_PRODUCTS_FOR_PAGINATION for pagination testing
    const firstCategoryProducts = Math.min(totalProducts, MIN_PRODUCTS_FOR_PAGINATION);
    firstLeaf.productCount = firstCategoryProducts;

    // Distribute remaining products across other categories
    const remainingProducts = totalProducts - firstCategoryProducts;
    const otherLeaves = leaves.slice(1);

    if (remainingProducts > 0 && otherLeaves.length > 0) {
        const perCategory = Math.floor(remainingProducts / otherLeaves.length);
        let remainder = remainingProducts % otherLeaves.length;

        for (const leaf of otherLeaves) {
            leaf.productCount = perCategory + (remainder > 0 ? 1 : 0);
            if (remainder > 0) remainder--;
        }
    }
}

/**
 * Reset all product counts to 0 in a category tree
 */
function resetProductCounts(nodes: CategoryNode[]): void {
    for (const node of nodes) {
        node.productCount = 0;
        if (node.children.length > 0) {
            resetProductCounts(node.children);
        }
    }
}

/**
 * Flatten a category tree into an array with parent references
 *
 * @param nodes - Array of category nodes
 * @param parentName - Name of parent category (null for root)
 * @returns Flattened array of categories
 */
export function flattenCategoryTree(
    nodes: CategoryNode[],
    parentName: string | null = null
): FlatCategory[] {
    const result: FlatCategory[] = [];

    for (const node of nodes) {
        result.push({
            id: node.id,
            name: node.name,
            description: node.description,
            parentName,
            productCount: node.productCount,
            hasImage: node.hasImage,
        });

        if (node.children.length > 0) {
            result.push(...flattenCategoryTree(node.children, node.name));
        }
    }

    return result;
}

/**
 * Flatten a category tree into an array with full paths for unique identification.
 * Use this instead of flattenCategoryTree when duplicate names across branches
 * need to be distinguished.
 *
 * @param nodes - Array of category nodes
 * @param parentPath - Full path of parent category (null for root)
 * @returns Flattened array of categories with unique paths
 */
export function flattenCategoryTreeWithPath(
    nodes: CategoryNode[],
    parentPath: string | null = null
): FlatCategoryWithPath[] {
    const result: FlatCategoryWithPath[] = [];

    for (const node of nodes) {
        const path = buildCategoryPath(parentPath, node.name);
        result.push({
            id: node.id,
            name: node.name,
            description: node.description,
            parentName: parentPath
                ? (parentPath.split(CATEGORY_PATH_SEPARATOR).pop() ?? null)
                : null,
            productCount: node.productCount,
            hasImage: node.hasImage,
            path,
        });

        if (node.children.length > 0) {
            result.push(...flattenCategoryTreeWithPath(node.children, path));
        }
    }

    return result;
}

/**
 * Collect all category IDs from a tree into a Map of name -> id
 *
 * @deprecated Use collectCategoryIdsByPath for unique identification
 * @param nodes - Array of category nodes
 * @returns Map of category names to their IDs
 */
export function collectCategoryIds(nodes: CategoryNode[]): Map<string, string> {
    const idMap = new Map<string, string>();

    const collect = (categories: CategoryNode[]): void => {
        for (const node of categories) {
            if (node.id) {
                idMap.set(node.name, node.id);
            }
            if (node.children.length > 0) {
                collect(node.children);
            }
        }
    };

    collect(nodes);
    return idMap;
}

/**
 * Collect all category IDs from a tree into a Map of path -> id
 * Uses full paths like "Living Room > Sofas" to avoid collisions
 * when categories with the same name exist in different branches.
 *
 * @param nodes - Array of category nodes
 * @param parentPath - Parent category path (null for root)
 * @returns Map of category paths to their IDs
 */
export function collectCategoryIdsByPath(
    nodes: CategoryNode[],
    parentPath: string | null = null
): Map<string, string> {
    const idMap = new Map<string, string>();

    for (const node of nodes) {
        const path = buildCategoryPath(parentPath, node.name);
        if (node.id) {
            idMap.set(path, node.id);
        }
        if (node.children.length > 0) {
            const childIds = collectCategoryIdsByPath(node.children, path);
            for (const [childPath, childId] of childIds) {
                idMap.set(childPath, childId);
            }
        }
    }

    return idMap;
}

/**
 * Find a category by name in the tree
 *
 * @param nodes - Array of category nodes
 * @param name - Name to search for
 * @returns The found category node or undefined
 */
export function findCategoryByName(nodes: CategoryNode[], name: string): CategoryNode | undefined {
    for (const node of nodes) {
        if (node.name === name) {
            return node;
        }
        if (node.children.length > 0) {
            const found = findCategoryByName(node.children, name);
            if (found) return found;
        }
    }
    return undefined;
}

/**
 * Calculate the depth of a category tree
 *
 * @param nodes - Array of category nodes
 * @returns Maximum depth of the tree (0 for empty, 1 for flat)
 */
export function getTreeDepth(nodes: CategoryNode[]): number {
    if (nodes.length === 0) return 0;

    let maxDepth = 1;
    for (const node of nodes) {
        if (node.children.length > 0) {
            const childDepth = 1 + getTreeDepth(node.children);
            maxDepth = Math.max(maxDepth, childDepth);
        }
    }
    return maxDepth;
}

// =============================================================================
// Blueprint Category Utilities
// =============================================================================

/**
 * Convert BlueprintCategory array to CategoryNode array.
 * Used for Shopware sync operations.
 *
 * @param categories - Array of blueprint categories
 * @returns Array of CategoryNode compatible with Shopware operations
 */
export function convertBlueprintCategories(categories: BlueprintCategory[]): CategoryNode[] {
    return categories.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        children: convertBlueprintCategories(c.children),
        productCount: 0,
        hasImage: c.hasImage,
    }));
}

/**
 * Find category path by ID in a blueprint category tree.
 * Returns the full path string for a given category ID.
 *
 * @param categories - Array of blueprint categories
 * @param targetId - Category ID to find
 * @param parentPath - Parent category path (null for root)
 * @returns Full path string or null if not found
 */
export function findCategoryPathById(
    categories: BlueprintCategory[],
    targetId: string,
    parentPath: string | null = null
): string | null {
    for (const cat of categories) {
        const path = buildCategoryPath(parentPath, cat.name);
        if (cat.id === targetId) {
            return path;
        }
        if (cat.children.length > 0) {
            const found = findCategoryPathById(cat.children, targetId, path);
            if (found) return found;
        }
    }
    return null;
}

/**
 * Build a path-to-ID map from blueprint categories.
 * Used to map product category assignments to Shopware category IDs.
 *
 * @param categories - Array of blueprint categories
 * @param parentPath - Parent category path (null for root)
 * @returns Map of category paths to their IDs
 */
export function buildBlueprintCategoryPathMap(
    categories: BlueprintCategory[],
    parentPath: string | null = null
): Map<string, string> {
    const pathMap = new Map<string, string>();

    for (const cat of categories) {
        const path = buildCategoryPath(parentPath, cat.name);
        if (cat.id) {
            pathMap.set(path, cat.id);
        }
        if (cat.children.length > 0) {
            const childMap = buildBlueprintCategoryPathMap(cat.children, path);
            for (const [childPath, childId] of childMap) {
                pathMap.set(childPath, childId);
            }
        }
    }

    return pathMap;
}
