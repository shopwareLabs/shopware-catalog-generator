/**
 * Testing Processor - Orchestrator that creates the Testing category hierarchy
 *
 * Creates:
 * 1. Testing category with placeholder landing page
 * 2. CMS sub-category with showcase landing page
 * 3. CMS element sub-categories (Text, Images, Video, etc.)
 * 4. Products sub-category (navigation)
 * 5. Product type sub-categories (Simple, Variant, Digital)
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { CmsPageFixture } from "../../fixtures/index.js";
import { TESTING_PLACEHOLDER_PAGE, WELCOME_PAGE } from "../../fixtures/index.js";
import { apiPost, generateUUID, logger } from "../../utils/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "../index.js";

import { BaseCmsProcessor } from "./base-processor.js";

/** CMS element category configuration matching Shopware admin block categories */
const CMS_CATEGORIES = [
    { name: "Text", processor: "cms-text" },
    { name: "Images", processor: "cms-images" },
    { name: "Video", processor: "cms-video" },
    { name: "Text & Images", processor: "cms-text-images" },
    { name: "Commerce", processor: "cms-commerce" },
    { name: "Form", processor: "cms-form" },
];

/** Product type categories linking to specific products */
const PRODUCT_CATEGORIES = [
    { name: "Simple Product", type: "simple" },
    { name: "Variant Product", type: "variant" },
    { name: "Digital Product", type: "digital" },
];

/** Cache file for digital product info */
const DIGITAL_PRODUCT_CACHE_FILE = "digital-product.json";

/**
 * Testing Processor - Orchestrator for CMS demo pages and product demos
 */
class TestingProcessorImpl extends BaseCmsProcessor implements PostProcessor {
    readonly name = "cms-testing";
    readonly description = "Create Testing category hierarchy with CMS and Products sub-sections";
    readonly pageFixture = TESTING_PLACEHOLDER_PAGE;

    /** Dependencies - all element processors and digital product must run first */
    override readonly dependsOn = [
        ...CMS_CATEGORIES.map((c) => c.processor),
        "digital-product",
    ];

    /**
     * Override process to create full hierarchy
     */
    override async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { options } = context;
        const errors: string[] = [];

        if (options.dryRun) {
            logger.cli(`    [DRY RUN] Would create Testing category hierarchy`);
            logger.cli(`    [DRY RUN] Would create CMS sub-section with ${CMS_CATEGORIES.length} pages`);
            logger.cli(`    [DRY RUN] Would create Products sub-section with ${PRODUCT_CATEGORIES.length} links`);
            return { name: this.name, processed: 1, skipped: 0, errors: [], durationMs: 0 };
        }

        try {
            // Step 1: Get root category for the navigation
            const rootCategoryId = await this.getRootCategoryId(context);
            if (!rootCategoryId) {
                errors.push("Could not find root category for navigation");
                return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
            }

            // Step 2: Create Testing placeholder CMS page and landing page
            const testingLandingPageId = await this.createTestingLandingPage(context, errors);
            if (!testingLandingPageId) {
                return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
            }

            // Step 3: Create "Testing" main category
            const testingCategoryId = await this.ensureCategory(
                context,
                "Testing",
                rootCategoryId,
                testingLandingPageId,
                errors
            );
            if (!testingCategoryId) {
                return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
            }

            // Step 4: Create CMS showcase landing page
            const cmsLandingPageId = await this.createCmsShowcaseLandingPage(context, errors);
            if (!cmsLandingPageId) {
                return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
            }

            // Step 5: Create "CMS" sub-category under Testing
            const cmsCategoryId = await this.ensureCategory(
                context,
                "CMS",
                testingCategoryId,
                cmsLandingPageId,
                errors
            );
            if (!cmsCategoryId) {
                return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
            }

            // Step 6: Create CMS element sub-categories under CMS
            await this.createCmsElementCategories(context, cmsCategoryId, errors);

            // Step 7: Create "Products" navigation category (no landing page)
            const productsCategoryId = await this.ensureNavigationCategory(
                context,
                "Products",
                testingCategoryId,
                errors
            );
            if (!productsCategoryId) {
                return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
            }

            // Step 8: Create product type sub-categories under Products
            await this.createProductCategories(context, productsCategoryId, errors);
        } catch (error) {
            errors.push(
                `Testing processor failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        return {
            name: this.name,
            processed: errors.length === 0 ? 1 : 0,
            skipped: 0,
            errors,
            durationMs: 0,
        };
    }

    /**
     * Cleanup: Remove Testing category hierarchy
     */
    override async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        if (context.options.dryRun) {
            logger.cli(`    [DRY RUN] Would delete "Testing" category hierarchy`);
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        let deleted = 0;
        const errors: string[] = [];

        try {
            const rootCategoryId = await this.getRootCategoryId(context);
            if (!rootCategoryId) {
                return { name: this.name, deleted: 0, errors: ["Could not find root category"], durationMs: 0 };
            }

            const testingCategoryId = await this.findCategoryByName(context, "Testing", rootCategoryId);
            if (!testingCategoryId) {
                logger.cli(`    ⊘ "Testing" category not found`);
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            // Find CMS and Products sub-categories
            const cmsCategoryId = await this.findCategoryByName(context, "CMS", testingCategoryId);
            const productsCategoryId = await this.findCategoryByName(context, "Products", testingCategoryId);

            // Delete CMS element categories (deepest first)
            if (cmsCategoryId) {
                for (const cat of [...CMS_CATEGORIES].reverse()) {
                    deleted += await this.deleteSubCategory(context, cat.name, cmsCategoryId);
                }
                // Delete CMS category
                deleted += await this.deleteCategoryById(context, cmsCategoryId, "CMS");
            }

            // Delete Product type categories
            if (productsCategoryId) {
                for (const cat of [...PRODUCT_CATEGORIES].reverse()) {
                    deleted += await this.deleteSubCategory(context, cat.name, productsCategoryId);
                }
                // Delete Products category
                deleted += await this.deleteCategoryById(context, productsCategoryId, "Products");
            }

            // Delete Testing category
            deleted += await this.deleteCategoryById(context, testingCategoryId, "Testing");

            // Cleanup landing pages and CMS layouts (using store-scoped names)
            await this.cleanupLandingPage(context, TESTING_PLACEHOLDER_PAGE.name, errors);
            await this.cleanupLandingPage(context, WELCOME_PAGE.name, errors);
        } catch (error) {
            errors.push(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        }

        return { name: this.name, deleted, errors, durationMs: 0 };
    }

    // =========================================================================
    // Landing Page Creation
    // =========================================================================

    /**
     * Create Testing placeholder landing page (store-scoped)
     */
    private async createTestingLandingPage(
        context: PostProcessorContext,
        errors: string[]
    ): Promise<string | null> {
        const fixture = TESTING_PLACEHOLDER_PAGE;
        const cmsPageName = this.getStoreScopedName(context, fixture.name);
        const landingPageName = this.getStoreScopedName(context, fixture.name);
        const url = this.fixtureNameToUrl(fixture.name);

        // Create CMS page
        let cmsPageId = await this.findCmsPageByName(context, cmsPageName);
        if (!cmsPageId) {
            cmsPageId = await this.createCmsPage(context, fixture, cmsPageName);
            if (!cmsPageId) {
                errors.push("Failed to create Testing CMS page");
                return null;
            }
            logger.cli(`    ✓ Created Testing CMS layout "${fixture.name}"`);
        } else {
            logger.cli(`    ⊘ Testing CMS layout "${fixture.name}" already exists`);
        }

        // Create landing page
        let landingPageId = await this.findLandingPageByName(context, landingPageName);
        if (!landingPageId) {
            landingPageId = await this.createLandingPage(context, landingPageName, cmsPageId, url);
            if (!landingPageId) {
                errors.push("Failed to create Testing landing page");
                return null;
            }
            logger.cli(`    ✓ Created Testing landing page "${fixture.name}"`);
        } else {
            await this.ensureSalesChannelAssociated(context, landingPageId, fixture.name, errors);
        }

        return landingPageId;
    }

    /**
     * Create CMS showcase landing page (with product slider, store-scoped)
     */
    private async createCmsShowcaseLandingPage(
        context: PostProcessorContext,
        errors: string[]
    ): Promise<string | null> {
        // Get products for the product slider
        const productIds = await this.getProductIds(context);
        const populatedFixture = this.populateProductIds(WELCOME_PAGE, productIds);
        const cmsPageName = this.getStoreScopedName(context, populatedFixture.name);
        const landingPageName = this.getStoreScopedName(context, populatedFixture.name);
        const url = this.fixtureNameToUrl(populatedFixture.name);

        // Create CMS page
        let cmsPageId = await this.findCmsPageByName(context, cmsPageName);
        if (!cmsPageId) {
            cmsPageId = await this.createCmsPage(context, populatedFixture, cmsPageName);
            if (!cmsPageId) {
                errors.push("Failed to create CMS showcase page");
                return null;
            }
            logger.cli(`    ✓ Created CMS showcase layout "${populatedFixture.name}"`);
        } else {
            logger.cli(`    ⊘ CMS showcase layout "${populatedFixture.name}" already exists`);
        }

        // Create landing page
        let landingPageId = await this.findLandingPageByName(context, landingPageName);
        if (!landingPageId) {
            landingPageId = await this.createLandingPage(context, landingPageName, cmsPageId, url);
            if (!landingPageId) {
                errors.push("Failed to create CMS showcase landing page");
                return null;
            }
            logger.cli(`    ✓ Created CMS showcase landing page "${populatedFixture.name}"`);
        } else {
            await this.ensureSalesChannelAssociated(context, landingPageId, populatedFixture.name, errors);
        }

        return landingPageId;
    }

    // =========================================================================
    // Category Operations
    // =========================================================================

    /**
     * Ensure a category exists with landing page link
     */
    private async ensureCategory(
        context: PostProcessorContext,
        name: string,
        parentId: string,
        landingPageId: string,
        errors: string[]
    ): Promise<string | null> {
        let categoryId = await this.findCategoryByName(context, name, parentId);

        if (!categoryId) {
            categoryId = await this.createLinkedCategory(context, name, parentId, landingPageId);
            if (!categoryId) {
                errors.push(`Failed to create "${name}" category`);
                return null;
            }
            logger.cli(`    ✓ Created "${name}" category`);
        } else {
            logger.cli(`    ⊘ "${name}" category already exists`);
        }

        return categoryId;
    }

    /**
     * Ensure a navigation category exists (no landing page)
     */
    private async ensureNavigationCategory(
        context: PostProcessorContext,
        name: string,
        parentId: string,
        errors: string[]
    ): Promise<string | null> {
        let categoryId = await this.findCategoryByName(context, name, parentId);

        if (!categoryId) {
            categoryId = await this.createNavigationCategory(context, name, parentId);
            if (!categoryId) {
                errors.push(`Failed to create "${name}" navigation category`);
                return null;
            }
            logger.cli(`    ✓ Created "${name}" category`);
        } else {
            logger.cli(`    ⊘ "${name}" category already exists`);
        }

        return categoryId;
    }

    /**
     * Create CMS element sub-categories
     */
    private async createCmsElementCategories(
        context: PostProcessorContext,
        cmsCategoryId: string,
        errors: string[]
    ): Promise<void> {
        const landingPages = this.getLandingPageIds(context);

        for (const cat of CMS_CATEGORIES) {
            const landingPageId = landingPages[cat.processor];
            if (!landingPageId) {
                logger.cli(`    ⚠ No landing page found for "${cat.name}" (processor: ${cat.processor})`);
                continue;
            }

            let subCategoryId = await this.findCategoryByName(context, cat.name, cmsCategoryId);
            if (!subCategoryId) {
                subCategoryId = await this.createLinkedCategory(context, cat.name, cmsCategoryId, landingPageId);
                if (subCategoryId) {
                    logger.cli(`    ✓ Created "${cat.name}" CMS sub-category`);
                } else {
                    errors.push(`Failed to create "${cat.name}" sub-category`);
                }
            } else {
                logger.cli(`    ⊘ "${cat.name}" CMS sub-category already exists`);
            }
        }
    }

    /**
     * Create product type sub-categories with product links
     */
    private async createProductCategories(
        context: PostProcessorContext,
        productsCategoryId: string,
        errors: string[]
    ): Promise<void> {
        for (const cat of PRODUCT_CATEGORIES) {
            const productId = await this.getProductByType(context, cat.type);
            if (!productId) {
                logger.cli(`    ⚠ No ${cat.type} product found for "${cat.name}"`);
                continue;
            }

            let subCategoryId = await this.findCategoryByName(context, cat.name, productsCategoryId);
            if (!subCategoryId) {
                subCategoryId = await this.createProductLinkCategory(context, cat.name, productsCategoryId, productId);
                if (subCategoryId) {
                    logger.cli(`    ✓ Created "${cat.name}" product link`);
                } else {
                    errors.push(`Failed to create "${cat.name}" product link`);
                }
            } else {
                logger.cli(`    ⊘ "${cat.name}" product link already exists`);
            }
        }
    }

    /**
     * Get the SalesChannel's navigation root category ID
     */
    private async getRootCategoryId(context: PostProcessorContext): Promise<string | null> {
        try {
            interface SalesChannelResponse {
                data?: Array<{
                    id: string;
                    attributes?: { navigationCategoryId?: string };
                    navigationCategoryId?: string;
                }>;
            }

            const response = await apiPost(context, "search/sales-channel", {
                ids: [context.salesChannelId],
            });

            if (response.ok) {
                const data = (await response.json()) as SalesChannelResponse;
                const salesChannel = data.data?.[0];
                return salesChannel?.attributes?.navigationCategoryId || salesChannel?.navigationCategoryId || null;
            }
        } catch (error) {
            logger.warn("Failed to get navigation category from sales channel", { error });
        }

        return null;
    }

    /**
     * Find a category by name under a parent
     */
    private async findCategoryByName(
        context: PostProcessorContext,
        name: string,
        parentId: string
    ): Promise<string | null> {
        try {
            interface CategoryResponse {
                data?: Array<{ id: string }>;
            }

            const response = await apiPost(context, "search/category", {
                filter: [
                    { type: "equals", field: "name", value: name },
                    { type: "equals", field: "parentId", value: parentId },
                ],
                limit: 1,
            });

            if (response.ok) {
                const data = (await response.json()) as CategoryResponse;
                return data.data?.[0]?.id || null;
            }
        } catch (error) {
            logger.warn(`Failed to find category "${name}"`, { error });
        }

        return null;
    }

    /**
     * Create a category linked to a landing page
     */
    private async createLinkedCategory(
        context: PostProcessorContext,
        name: string,
        parentId: string,
        landingPageId: string
    ): Promise<string | null> {
        const categoryId = generateUUID();

        const response = await apiPost(context, "_action/sync", {
            createCategory: {
                entity: "category",
                action: "upsert",
                payload: [
                    {
                        id: categoryId,
                        parentId,
                        name,
                        active: true,
                        type: "link",
                        linkType: "landing_page",
                        internalLink: landingPageId,
                        linkNewTab: false,
                        displayNestedProducts: false,
                        visible: true,
                    },
                ],
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.apiError("_action/sync (create linked category)", response.status, { error: errorText });
            return null;
        }

        return categoryId;
    }

    /**
     * Create a navigation category (no landing page link)
     */
    private async createNavigationCategory(
        context: PostProcessorContext,
        name: string,
        parentId: string
    ): Promise<string | null> {
        const categoryId = generateUUID();

        const response = await apiPost(context, "_action/sync", {
            createCategory: {
                entity: "category",
                action: "upsert",
                payload: [
                    {
                        id: categoryId,
                        parentId,
                        name,
                        active: true,
                        type: "page",
                        displayNestedProducts: false,
                        visible: true,
                    },
                ],
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.apiError("_action/sync (create navigation category)", response.status, { error: errorText });
            return null;
        }

        return categoryId;
    }

    /**
     * Create a category that links to a product
     */
    private async createProductLinkCategory(
        context: PostProcessorContext,
        name: string,
        parentId: string,
        productId: string
    ): Promise<string | null> {
        const categoryId = generateUUID();

        const response = await apiPost(context, "_action/sync", {
            createCategory: {
                entity: "category",
                action: "upsert",
                payload: [
                    {
                        id: categoryId,
                        parentId,
                        name,
                        active: true,
                        type: "link",
                        linkType: "product",
                        internalLink: productId,
                        linkNewTab: false,
                        displayNestedProducts: false,
                        visible: true,
                    },
                ],
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.apiError("_action/sync (create product link category)", response.status, { error: errorText });
            return null;
        }

        return categoryId;
    }

    /**
     * Delete a sub-category by name
     */
    private async deleteSubCategory(
        context: PostProcessorContext,
        name: string,
        parentId: string
    ): Promise<number> {
        const categoryId = await this.findCategoryByName(context, name, parentId);
        if (categoryId) {
            const success = await this.deleteEntity(context, "category", categoryId);
            if (success) {
                logger.cli(`    ✓ Deleted "${name}" sub-category`);
                return 1;
            }
        }
        return 0;
    }

    /**
     * Delete a category by ID
     */
    private async deleteCategoryById(
        context: PostProcessorContext,
        categoryId: string,
        name: string
    ): Promise<number> {
        const success = await this.deleteEntity(context, "category", categoryId);
        if (success) {
            logger.cli(`    ✓ Deleted "${name}" category`);
            return 1;
        }
        return 0;
    }

    /**
     * Cleanup a landing page and its CMS layout
     */
    /**
     * Cleanup landing page and CMS layout using store-scoped names
     */
    private async cleanupLandingPage(
        context: PostProcessorContext,
        fixturePageName: string,
        errors: string[]
    ): Promise<void> {
        const scopedName = this.getStoreScopedName(context, fixturePageName);

        const landingPageId = await this.findLandingPageByName(context, scopedName);
        if (landingPageId) {
            const success = await this.deleteEntity(context, "landing-page", landingPageId);
            if (success) {
                logger.cli(`    ✓ Deleted "${fixturePageName}" landing page`);
            } else {
                errors.push(`Failed to delete "${fixturePageName}" landing page`);
            }
        }

        const cmsPageId = await this.findCmsPageByName(context, scopedName);
        if (cmsPageId) {
            const success = await this.deleteEntity(context, "cms-page", cmsPageId);
            if (success) {
                logger.cli(`    ✓ Deleted "${fixturePageName}" CMS layout`);
            } else {
                errors.push(`Failed to delete "${fixturePageName}" CMS layout`);
            }
        }
    }

    // =========================================================================
    // Product Operations
    // =========================================================================

    /**
     * Get product IDs for the welcome page product slider
     */
    private async getProductIds(context: PostProcessorContext): Promise<string[]> {
        try {
            interface ProductResponse {
                data?: Array<{ id: string }>;
            }

            const response = await apiPost(context, "search/product", {
                filter: [
                    {
                        type: "equals",
                        field: "visibilities.salesChannelId",
                        value: context.salesChannelId,
                    },
                ],
                limit: 8,
            });

            if (response.ok) {
                const data = (await response.json()) as ProductResponse;
                return data.data?.map((p) => p.id) || [];
            }
        } catch (error) {
            logger.warn("Failed to get products for welcome page", { error });
        }

        return [];
    }

    /**
     * Get a product by type (simple, variant, digital)
     */
    private async getProductByType(
        context: PostProcessorContext,
        type: string
    ): Promise<string | null> {
        // For digital products, check the cache
        if (type === "digital") {
            return this.getDigitalProductId(context);
        }

        // For variant products, find a parent product with children
        if (type === "variant") {
            return this.getVariantProductId(context);
        }

        // For simple products, find a product without children and not a child
        return this.getSimpleProductId(context);
    }

    /**
     * Get digital product ID from cache
     */
    private getDigitalProductId(context: PostProcessorContext): string | null {
        const cacheDir = context.cache.getSalesChannelDir(context.salesChannelName);
        const filePath = path.join(cacheDir, DIGITAL_PRODUCT_CACHE_FILE);

        if (!fs.existsSync(filePath)) {
            return null;
        }

        try {
            const content = fs.readFileSync(filePath, "utf-8");
            const data = JSON.parse(content) as { productId: string };
            return data.productId;
        } catch {
            return null;
        }
    }

    /**
     * Get a variant product (parent with children)
     */
    private async getVariantProductId(context: PostProcessorContext): Promise<string | null> {
        try {
            interface ProductResponse {
                data?: Array<{ id: string; childCount?: number }>;
            }

            const response = await apiPost(context, "search/product", {
                filter: [
                    {
                        type: "equals",
                        field: "visibilities.salesChannelId",
                        value: context.salesChannelId,
                    },
                    {
                        type: "range",
                        field: "childCount",
                        parameters: { gt: 0 },
                    },
                ],
                limit: 1,
            });

            if (response.ok) {
                const data = (await response.json()) as ProductResponse;
                return data.data?.[0]?.id || null;
            }
        } catch (error) {
            logger.warn("Failed to find variant product", { error });
        }

        return null;
    }

    /**
     * Get a simple product (no parent, no children)
     */
    private async getSimpleProductId(context: PostProcessorContext): Promise<string | null> {
        try {
            interface ProductResponse {
                data?: Array<{ id: string }>;
            }

            const response = await apiPost(context, "search/product", {
                filter: [
                    {
                        type: "equals",
                        field: "visibilities.salesChannelId",
                        value: context.salesChannelId,
                    },
                    {
                        type: "equals",
                        field: "parentId",
                        value: null,
                    },
                    {
                        type: "equals",
                        field: "childCount",
                        value: 0,
                    },
                ],
                limit: 1,
            });

            if (response.ok) {
                const data = (await response.json()) as ProductResponse;
                return data.data?.[0]?.id || null;
            }
        } catch (error) {
            logger.warn("Failed to find simple product", { error });
        }

        return null;
    }

    /**
     * Populate product IDs in the fixture
     */
    private populateProductIds(fixture: CmsPageFixture, productIds: string[]): CmsPageFixture {
        const cloned = JSON.parse(JSON.stringify(fixture)) as CmsPageFixture;

        for (const section of cloned.sections) {
            for (const block of section.blocks) {
                for (const slot of block.slots) {
                    if (slot.type === "product-slider" && slot.config.products) {
                        slot.config.products = { source: "static", value: productIds };
                    }
                }
            }
        }

        return cloned;
    }

    // =========================================================================
    // Naming Helpers
    // =========================================================================

    /**
     * Get store-scoped name for CMS page or landing page
     * Format: "Page Name [storeName]"
     */
    private getStoreScopedName(context: PostProcessorContext, name: string): string {
        return `${name} [${context.salesChannelName}]`;
    }

    /**
     * Convert fixture name to URL-safe slug
     */
    private fixtureNameToUrl(name: string): string {
        return name.toLowerCase().replace(/\s+/g, "-").replace(/&/g, "and");
    }
}

export const TestingProcessor = new TestingProcessorImpl();
