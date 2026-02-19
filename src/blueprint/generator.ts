/**
 * Blueprint Generator - Creates a complete blueprint structure without AI calls
 *
 * This generator creates the "skeleton" of a webshop with:
 * - SalesChannel configuration
 * - Category tree (3 top-level, 3 levels deep)
 * - Products with random metadata (90 total, 30 per top-level branch)
 * - Cross-category assignments for realistic distribution
 */

import type {
    Blueprint,
    BlueprintCategory,
    BlueprintConfig,
    BlueprintProduct,
    ImageView,
    ProductMetadata,
    ReviewCount,
} from "../types/index.js";

import { DEFAULT_BLUEPRINT_CONFIG } from "../types/index.js";
import { generateUUID, randomPick } from "../utils/index.js";

/**
 * Generate a random number in a range
 */
function randomInRange(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a random price between min and max
 */
function randomPrice(min: number = 9.99, max: number = 299.99): number {
    const price = min + Math.random() * (max - min);
    return Math.round(price * 100) / 100;
}

/**
 * Shuffle an array (Fisher-Yates)
 */
function shuffle<T>(arr: readonly T[]): T[] {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = result[i];
        result[i] = result[j] as T;
        result[j] = temp as T;
    }
    return result;
}

/**
 * Blueprint Generator class
 */
export class BlueprintGenerator {
    private readonly config: BlueprintConfig;

    constructor(config: Partial<BlueprintConfig> = {}) {
        this.config = { ...DEFAULT_BLUEPRINT_CONFIG, ...config };
    }

    /**
     * Generate a complete blueprint for a sales channel
     */
    generateBlueprint(salesChannelName: string, description: string): Blueprint {
        // Generate category tree
        const categories = this.generateCategoryTree();

        // Generate products for each top-level branch
        // AI will assign appropriate subcategories during hydration
        const products = this.generateProducts(categories);

        return {
            version: "1.0",
            salesChannel: {
                name: salesChannelName,
                description: description || `${salesChannelName} webshop`,
                baseUrl: `http://${salesChannelName.toLowerCase()}.localhost:8000`,
            },
            categories,
            products,
            createdAt: new Date().toISOString(),
        };
    }

    /**
     * Generate the category tree structure
     */
    private generateCategoryTree(): BlueprintCategory[] {
        const topLevelCategories: BlueprintCategory[] = [];

        for (let i = 0; i < this.config.topLevelCategories; i++) {
            const topCategory = this.createCategory(1, `Top Category ${i + 1}`);
            topCategory.children = this.generateSubcategories(topCategory.id, 2);
            topLevelCategories.push(topCategory);
        }

        return topLevelCategories;
    }

    /**
     * Recursively generate subcategories
     */
    private generateSubcategories(parentId: string, level: number): BlueprintCategory[] {
        if (level > this.config.maxDepth) {
            return [];
        }

        const { min, max } = this.config.subcategoriesPerCategory;
        const count = randomInRange(min, max);
        const subcategories: BlueprintCategory[] = [];

        for (let i = 0; i < count; i++) {
            const category = this.createCategory(level, `Category L${level}-${i + 1}`, parentId);

            // Only add children if not at max depth
            if (level < this.config.maxDepth) {
                category.children = this.generateSubcategories(category.id, level + 1);
            }

            subcategories.push(category);
        }

        return subcategories;
    }

    /**
     * Create a single category
     */
    private createCategory(
        level: number,
        placeholderName: string,
        parentId?: string
    ): BlueprintCategory {
        return {
            id: generateUUID(),
            name: placeholderName,
            description: `Placeholder description for ${placeholderName}`,
            parentId,
            level,
            hasImage: Math.random() < this.config.categoryImagePercentage,
            imageDescription: undefined, // Filled during hydration
            children: [],
        };
    }

    /**
     * Generate products for each top-level branch.
     * AI will assign appropriate subcategories during hydration.
     * Respects totalProducts as a limit, distributing evenly across categories.
     */
    private generateProducts(topLevelCategories: BlueprintCategory[]): BlueprintProduct[] {
        const products: BlueprintProduct[] = [];
        let remaining = this.config.totalProducts;

        for (const topCategory of topLevelCategories) {
            if (remaining <= 0) break;
            const branchProducts = this.generateBranchProducts(topCategory, remaining);
            products.push(...branchProducts);
            remaining -= branchProducts.length;
        }

        return products;
    }

    /**
     * Generate products for a single branch (top-level category)
     */
    private generateBranchProducts(
        topCategory: BlueprintCategory,
        maxProducts: number
    ): BlueprintProduct[] {
        const products: BlueprintProduct[] = [];
        const count = Math.min(this.config.productsPerBranch, maxProducts);

        for (let i = 0; i < count; i++) {
            const product = this.createProduct(i + 1, topCategory);
            products.push(product);
        }

        return products;
    }

    /**
     * Create a single product with initial branch assignment.
     * AI will assign appropriate subcategories during hydration based on product name.
     */
    private createProduct(index: number, topCategory: BlueprintCategory): BlueprintProduct {
        const metadata = this.generateProductMetadata();

        return {
            id: generateUUID(),
            name: `Product ${index}`,
            description: `Placeholder description for Product ${index}`,
            price: randomPrice(),
            stock: randomInRange(0, 100),
            primaryCategoryId: topCategory.id,
            categoryIds: [topCategory.id],
            metadata,
        };
    }

    /**
     * Generate random product metadata
     *
     * Note: variantConfigs is intentionally left undefined here.
     * The AI suggests appropriate property groups during hydration,
     * and the PropertyCache + variant processor handle the actual options.
     */
    private generateProductMetadata(): ProductMetadata {
        const imageCount = randomPick([1, 2, 3]) as 1 | 2 | 3;
        const isVariant = Math.random() < this.config.variantPercentage;
        const hasSalesPrice = Math.random() < this.config.salePercentage;

        // Review count distribution: 0 (17%), 1-2 (28%), 3-5 (33%), 8-10 (22%)
        const reviewCountOptions: ReviewCount[] = [
            ...Array(17).fill(0),
            ...Array(14).fill(1),
            ...Array(14).fill(2),
            ...Array(11).fill(3),
            ...Array(11).fill(5),
            ...Array(11).fill(8),
            ...Array(11).fill(10),
        ] as ReviewCount[];
        const reviewCount = randomPick(reviewCountOptions);

        // Generate image description placeholders
        const imageViews: ImageView[] = ["front", "lifestyle", "detail", "side", "packaging"];
        const selectedViews = shuffle(imageViews).slice(0, imageCount);
        const imageDescriptions = selectedViews.map((view) => ({
            view,
            prompt: "", // Filled during hydration
        }));

        return {
            imageCount,
            imageDescriptions,
            isVariant,
            // variantConfigs is filled during hydration based on AI-suggested property groups
            variantConfigs: undefined,
            properties: [], // Filled during hydration
            manufacturerName: undefined, // Filled during hydration
            reviewCount,
            hasSalesPrice,
            salePercentage: hasSalesPrice ? randomPick([0.1, 0.15, 0.2, 0.25, 0.3]) : undefined,
        };
    }
}
