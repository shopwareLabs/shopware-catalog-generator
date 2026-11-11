/**
 * Testing Processor - Orchestrator that creates the Testing category hierarchy
 *
 * Creates:
 * 1. Testing category with placeholder landing page
 * 2. CMS sub-category with showcase landing page
 * 3. CMS element sub-categories (Text, Images, Video, etc.)
 * 4. Products sub-category (navigation)
 * 5. Product type sub-categories (Simple, Variant, Digital, Media)
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { CmsPageFixture, ShopwareFeature } from "../../fixtures/index.js";
import type { BlueprintProduct, CategorySyncPayload } from "../../types/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "../index.js";

import { TESTING_PLACEHOLDER_PAGE, WELCOME_PAGE } from "../../fixtures/index.js";
import {
    findCategoryIdByName,
    getSalesChannelNavigationCategoryId,
} from "../../shopware/api-helpers.js";
import {
    apiPost,
    generateUUID,
    cloneDeep,
    logger,
    toFixtureUrlSlug,
    toStoreScopedName,
} from "../../utils/index.js";
import { MEDIA_SHOWCASE_PRODUCT_ID } from "../media-product-processor.js";
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
const PRODUCT_CATEGORIES: ReadonlyArray<{
    name: string;
    type: string;
    /** Only created when the shop supports this feature */
    requires?: ShopwareFeature;
}> = [
    { name: "Simple Product", type: "simple" },
    { name: "Variant Product", type: "variant" },
    { name: "Digital Product", type: "digital" },
    { name: "Media Product", type: "media", requires: "spatialMedia" },
];

/** Cache file for digital product info */
const DIGITAL_PRODUCT_CACHE_FILE = "digital-product.json";

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Testing Processor - Orchestrator for CMS demo pages and product demos
 */
/**
 * First blueprint product whose isVariant flag matches. The blueprint decides which products
 * get variants, so this works before the variant processor ran and does not depend on
 * Shopware's childCount, which is 0 until the children exist and are indexed.
 */
export function findProductIdByVariantFlag(
    products: BlueprintProduct[],
    isVariant: boolean
): string | null {
    return products.find((p) => p.metadata.isVariant === isVariant)?.id ?? null;
}

class TestingProcessorImpl extends BaseCmsProcessor implements PostProcessor {
    readonly name = "cms-testing";
    readonly description = "Create Testing category hierarchy with CMS and Products sub-sections";
    readonly pageFixture = TESTING_PLACEHOLDER_PAGE;

    /** Dependencies - all element processors and the demo products must run first */
    override readonly dependsOn = [
        ...CMS_CATEGORIES.map((c) => c.processor),
        "digital-product",
        "media-product",
    ];

    /**
     * Override process to create full hierarchy
     */
    override async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        if (context.options.dryRun) {
            return this.dryRunHierarchy();
        }

        const errors: string[] = [];
        let completed = false;
        try {
            completed = await this.createHierarchy(context, errors);
        } catch (error) {
            errors.push(`Testing processor failed: ${errorMessage(error)}`);
        }

        const processed = completed && errors.length === 0 ? 1 : 0;
        return { name: this.name, processed, skipped: 0, errors, durationMs: 0 };
    }

    /**
     * Cleanup: Remove Testing category hierarchy
     */
    override async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        if (context.options.dryRun) {
            logger.info(`    [DRY RUN] Would delete "Testing" category hierarchy`, { cli: true });
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        const result: PostProcessorCleanupResult = {
            name: this.name,
            deleted: 0,
            errors: [],
            durationMs: 0,
        };
        try {
            await this.deleteHierarchy(context, result);
        } catch (error) {
            result.errors.push(`Cleanup failed: ${errorMessage(error)}`);
        }
        return result;
    }

    // =========================================================================
    // Hierarchy Steps
    // =========================================================================

    private dryRunHierarchy(): PostProcessorResult {
        logger.info(`    [DRY RUN] Would create Testing category hierarchy`, { cli: true });
        logger.info(
            `    [DRY RUN] Would create CMS sub-section with ${CMS_CATEGORIES.length} pages`,
            { cli: true }
        );
        logger.info(
            `    [DRY RUN] Would create Products sub-section with ${PRODUCT_CATEGORIES.length} links`,
            { cli: true }
        );
        logger.info(`    [DRY RUN] Would create Cookie settings external link category`, {
            cli: true,
        });
        return { name: this.name, processed: 1, skipped: 0, errors: [], durationMs: 0 };
    }

    /**
     * Create Testing → CMS → Products → Cookie settings in order.
     * Returns false when a step could not create its category (later steps need its ID).
     */
    private async createHierarchy(
        context: PostProcessorContext,
        errors: string[]
    ): Promise<boolean> {
        const rootCategoryId = await this.getRootCategoryId(context);
        if (!rootCategoryId) {
            errors.push("Could not find root category for navigation");
            return false;
        }

        const testingCategoryId = await this.createTestingCategory(context, rootCategoryId, errors);
        if (!testingCategoryId) return false;

        const cmsCategoryId = await this.createCmsSection(context, testingCategoryId, errors);
        if (!cmsCategoryId) return false;

        const productsCategoryId = await this.createProductsSection(
            context,
            testingCategoryId,
            cmsCategoryId,
            errors
        );
        if (!productsCategoryId) return false;

        // "Cookie settings" external link (after Products)
        await this.ensureCookieSettingsCategory(
            context,
            testingCategoryId,
            productsCategoryId,
            errors
        );

        // Validate all expected sub-categories exist
        await this.validateHierarchy(context, cmsCategoryId, productsCategoryId, errors);
        return true;
    }

    /** "Testing" main category with its placeholder landing page (last among root children) */
    private async createTestingCategory(
        context: PostProcessorContext,
        rootCategoryId: string,
        errors: string[]
    ): Promise<string | null> {
        const testingLandingPageId = await this.createTestingLandingPage(context, errors);
        if (!testingLandingPageId) return null;

        const lastRootChildId = await this.getLastRootChildId(context, rootCategoryId);
        return this.ensureCategory(
            context,
            "Testing",
            rootCategoryId,
            testingLandingPageId,
            errors,
            lastRootChildId ?? undefined
        );
    }

    /** "CMS" sub-category (first child of Testing) with showcase page and element categories */
    private async createCmsSection(
        context: PostProcessorContext,
        testingCategoryId: string,
        errors: string[]
    ): Promise<string | null> {
        const cmsLandingPageId = await this.createCmsShowcaseLandingPage(context, errors);
        if (!cmsLandingPageId) return null;

        const cmsCategoryId = await this.ensureCategory(
            context,
            "CMS",
            testingCategoryId,
            cmsLandingPageId,
            errors,
            undefined
        );
        if (!cmsCategoryId) return null;

        await this.createCmsElementCategories(context, cmsCategoryId, errors);
        return cmsCategoryId;
    }

    /** "Products" navigation category (after CMS) with the product type links */
    private async createProductsSection(
        context: PostProcessorContext,
        testingCategoryId: string,
        cmsCategoryId: string,
        errors: string[]
    ): Promise<string | null> {
        const productsCategoryId = await this.ensureNavigationCategory(
            context,
            "Products",
            testingCategoryId,
            errors,
            cmsCategoryId
        );
        if (!productsCategoryId) return null;

        await this.createProductCategories(context, productsCategoryId, errors);
        return productsCategoryId;
    }

    /** Delete the Testing tree (children first), then its landing pages and CMS layouts */
    private async deleteHierarchy(
        context: PostProcessorContext,
        result: PostProcessorCleanupResult
    ): Promise<void> {
        const rootCategoryId = await this.getRootCategoryId(context);
        if (!rootCategoryId) {
            result.errors.push("Could not find root category");
            return;
        }

        const testingCategoryId = await findCategoryIdByName(context, "Testing", rootCategoryId);
        if (!testingCategoryId) {
            logger.info(`    ⊘ "Testing" category not found`, { cli: true });
            return;
        }

        await this.deleteTestingChildren(context, testingCategoryId, result);
        result.deleted += await this.deleteCategoryById(context, testingCategoryId, "Testing");

        // Cleanup landing pages and CMS layouts (using store-scoped names)
        await this.cleanupLandingPage(context, TESTING_PLACEHOLDER_PAGE.name, result.errors);
        await this.cleanupLandingPage(context, WELCOME_PAGE.name, result.errors);
    }

    /** Delete Cookie settings, the CMS tree and the Products tree under Testing */
    private async deleteTestingChildren(
        context: PostProcessorContext,
        testingCategoryId: string,
        result: PostProcessorCleanupResult
    ): Promise<void> {
        const cmsCategoryId = await findCategoryIdByName(context, "CMS", testingCategoryId);
        const productsCategoryId = await findCategoryIdByName(
            context,
            "Products",
            testingCategoryId
        );
        const cookieSettingsCategoryId = await findCategoryIdByName(
            context,
            "Cookie settings",
            testingCategoryId
        );

        if (cookieSettingsCategoryId) {
            result.deleted += await this.deleteCategoryById(
                context,
                cookieSettingsCategoryId,
                "Cookie settings"
            );
        }
        await this.deleteCategoryTree(context, cmsCategoryId, "CMS", CMS_CATEGORIES, result);
        await this.deleteCategoryTree(
            context,
            productsCategoryId,
            "Products",
            PRODUCT_CATEGORIES,
            result
        );
    }

    /** Delete the sub-categories (last first), then the category itself */
    private async deleteCategoryTree(
        context: PostProcessorContext,
        categoryId: string | null,
        name: string,
        children: ReadonlyArray<{ name: string }>,
        result: PostProcessorCleanupResult
    ): Promise<void> {
        if (!categoryId) return;

        for (const child of [...children].reverse()) {
            result.deleted += await this.deleteSubCategory(context, child.name, categoryId);
        }
        result.deleted += await this.deleteCategoryById(context, categoryId, name);
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
            logger.info(`    ✓ Created Testing CMS layout "${fixture.name}"`, { cli: true });
        } else {
            logger.info(`    ✓ Reusing existing Testing CMS layout "${fixture.name}"`, {
                cli: true,
            });
        }

        // Create landing page
        let landingPageId = await this.findLandingPageByName(context, landingPageName);
        if (!landingPageId) {
            landingPageId = await this.createLandingPage(context, landingPageName, cmsPageId, url);
            if (!landingPageId) {
                errors.push("Failed to create Testing landing page");
                return null;
            }
            logger.info(`    ✓ Created Testing landing page "${fixture.name}"`, { cli: true });
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
            logger.info(`    ✓ Created CMS showcase layout "${populatedFixture.name}"`, {
                cli: true,
            });
        } else {
            logger.info(`    ✓ Reusing CMS showcase layout "${populatedFixture.name}"`, {
                cli: true,
            });
        }

        // Create landing page
        let landingPageId = await this.findLandingPageByName(context, landingPageName);
        if (!landingPageId) {
            landingPageId = await this.createLandingPage(context, landingPageName, cmsPageId, url);
            if (!landingPageId) {
                errors.push("Failed to create CMS showcase landing page");
                return null;
            }
            logger.info(`    ✓ Created CMS showcase landing page "${populatedFixture.name}"`, {
                cli: true,
            });
        } else {
            await this.ensureSalesChannelAssociated(
                context,
                landingPageId,
                populatedFixture.name,
                errors
            );
        }

        return landingPageId;
    }

    // =========================================================================
    // Category Operations
    // =========================================================================

    /**
     * Ensure a category exists with landing page link.
     * If afterCategoryId is provided and the category already exists,
     * updates its position to maintain correct ordering.
     */
    private async ensureCategory(
        context: PostProcessorContext,
        name: string,
        parentId: string,
        landingPageId: string,
        errors: string[],
        afterCategoryId?: string
    ): Promise<string | null> {
        let categoryId = await findCategoryIdByName(context, name, parentId);

        if (!categoryId) {
            categoryId = await this.createLinkedCategory(
                context,
                name,
                parentId,
                landingPageId,
                afterCategoryId
            );
            if (!categoryId) {
                errors.push(`Failed to create "${name}" category`);
                return null;
            }
            logger.info(`    ✓ Created "${name}" category`, { cli: true });
        } else {
            if (afterCategoryId) {
                await this.updateCategoryPosition(context, categoryId, afterCategoryId);
            }
            logger.info(`    ⊘ "${name}" category already exists`, { cli: true });
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
        errors: string[],
        afterCategoryId?: string
    ): Promise<string | null> {
        let categoryId = await findCategoryIdByName(context, name, parentId);

        if (!categoryId) {
            categoryId = await this.createNavigationCategory(
                context,
                name,
                parentId,
                afterCategoryId
            );
            if (!categoryId) {
                errors.push(`Failed to create "${name}" navigation category`);
                return null;
            }
            logger.info(`    ✓ Created "${name}" category`, { cli: true });
        } else {
            logger.info(`    ⊘ "${name}" category already exists`, { cli: true });
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
                errors.push(
                    `Missing landing page for "${cat.name}" (processor: ${cat.processor} not run or failed)`
                );
                continue;
            }

            let subCategoryId = await findCategoryIdByName(context, cat.name, cmsCategoryId);
            if (!subCategoryId) {
                subCategoryId = await this.createLinkedCategory(
                    context,
                    cat.name,
                    cmsCategoryId,
                    landingPageId
                );
                if (subCategoryId) {
                    logger.info(`    ✓ Created "${cat.name}" CMS sub-category`, { cli: true });
                } else {
                    errors.push(`Failed to create "${cat.name}" sub-category`);
                }
            } else {
                logger.info(`    ⊘ "${cat.name}" CMS sub-category already exists`, { cli: true });
            }
        }
    }

    /**
     * Validate that all expected sub-categories exist in Shopware.
     * Reports missing categories as errors so the processor doesn't falsely report success.
     */
    private async validateHierarchy(
        context: PostProcessorContext,
        cmsCategoryId: string,
        productsCategoryId: string,
        errors: string[]
    ): Promise<void> {
        const missingCms: string[] = [];
        for (const cat of CMS_CATEGORIES) {
            const id = await findCategoryIdByName(context, cat.name, cmsCategoryId);
            if (!id) missingCms.push(cat.name);
        }

        const missingProducts: string[] = [];
        for (const cat of this.getSupportedProductCategories(context)) {
            const id = await findCategoryIdByName(context, cat.name, productsCategoryId);
            if (!id) missingProducts.push(cat.name);
        }

        if (missingCms.length > 0) {
            errors.push(`Missing CMS sub-categories: ${missingCms.join(", ")}`);
        }
        if (missingProducts.length > 0) {
            errors.push(`Missing Product sub-categories: ${missingProducts.join(", ")}`);
        }

        if (missingCms.length === 0 && missingProducts.length === 0) {
            logger.info(
                `    ✓ Validated: ${CMS_CATEGORIES.length} CMS + ${this.getSupportedProductCategories(context).length} Product categories`,
                { cli: true }
            );
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
        for (const cat of this.getSupportedProductCategories(context)) {
            const productId = await this.getProductByType(context, cat.type);
            if (!productId) {
                logger.warn(`    ⚠ No ${cat.type} product found for "${cat.name}"`, {
                    cli: true,
                });
                continue;
            }

            // Existing links are upserted too, so a re-run repairs a link to the wrong product
            const existingId = await findCategoryIdByName(context, cat.name, productsCategoryId);
            const saved = await this.upsertProductLinkCategory(
                context,
                { id: existingId ?? generateUUID(), name: cat.name, parentId: productsCategoryId },
                productId
            );
            if (!saved) {
                errors.push(`Failed to save "${cat.name}" product link`);
                continue;
            }
            const action = existingId ? "Updated" : "Created";
            logger.info(`    ✓ ${action} "${cat.name}" product link`, { cli: true });
        }
    }

    /** Product categories the connected shop can show (e.g. no 3D/video gallery before 6.6) */
    private getSupportedProductCategories(
        context: PostProcessorContext
    ): typeof PRODUCT_CATEGORIES {
        return PRODUCT_CATEGORIES.filter(
            (cat) => !cat.requires || context.shopware.supports(cat.requires)
        );
    }

    private async getRootCategoryId(context: PostProcessorContext): Promise<string | null> {
        return getSalesChannelNavigationCategoryId(context);
    }

    /**
     * Create a category linked to a landing page
     */
    private async createLinkedCategory(
        context: PostProcessorContext,
        name: string,
        parentId: string,
        landingPageId: string,
        afterCategoryId?: string
    ): Promise<string | null> {
        const categoryId = generateUUID();

        const payload: CategorySyncPayload = {
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
            afterCategoryId,
        };

        const response = await apiPost(context, "_action/sync", {
            createCategory: {
                entity: "category",
                action: "upsert",
                payload: [payload],
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.apiError("_action/sync (create linked category)", response.status, {
                error: errorText,
            });
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
        parentId: string,
        afterCategoryId?: string
    ): Promise<string | null> {
        const categoryId = generateUUID();

        const payload: CategorySyncPayload = {
            id: categoryId,
            parentId,
            name,
            active: true,
            type: "page",
            displayNestedProducts: false,
            visible: true,
            afterCategoryId,
        };

        const response = await apiPost(context, "_action/sync", {
            createCategory: {
                entity: "category",
                action: "upsert",
                payload: [payload],
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.apiError("_action/sync (create navigation category)", response.status, {
                error: errorText,
            });
            return null;
        }

        return categoryId;
    }

    /**
     * Create or update a category that links to a product
     */
    private async upsertProductLinkCategory(
        context: PostProcessorContext,
        category: { id: string; name: string; parentId: string },
        productId: string
    ): Promise<boolean> {
        const { id: categoryId, name, parentId } = category;
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
            logger.apiError("_action/sync (upsert product link category)", response.status, {
                error: errorText,
            });
            return false;
        }

        return true;
    }

    /**
     * Create a category that links to an external URL
     */
    private async createExternalLinkCategory(
        context: PostProcessorContext,
        name: string,
        parentId: string,
        externalLink: string,
        afterCategoryId?: string
    ): Promise<string | null> {
        const categoryId = generateUUID();

        const payload: CategorySyncPayload = {
            id: categoryId,
            parentId,
            name,
            active: true,
            type: "link",
            linkType: "external",
            externalLink,
            linkNewTab: false,
            displayNestedProducts: false,
            visible: true,
            afterCategoryId,
        };

        const response = await apiPost(context, "_action/sync", {
            createCategory: {
                entity: "category",
                action: "upsert",
                payload: [payload],
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.apiError("_action/sync (create external link category)", response.status, {
                error: errorText,
            });
            return null;
        }

        return categoryId;
    }

    /**
     * Ensure Cookie settings external link category exists (after Products)
     */
    private async ensureCookieSettingsCategory(
        context: PostProcessorContext,
        parentId: string,
        afterCategoryId: string,
        errors: string[]
    ): Promise<void> {
        const name = "Cookie settings";

        const categoryId = await findCategoryIdByName(context, name, parentId);
        if (categoryId) {
            logger.info(`    ⊘ "${name}" category already exists`, { cli: true });
            return;
        }

        const newId = await this.createExternalLinkCategory(
            context,
            name,
            parentId,
            "/cookie/offcanvas",
            afterCategoryId
        );
        if (newId) {
            logger.info(`    ✓ Created "${name}" category`, { cli: true });
        } else {
            errors.push(`Failed to create "${name}" category`);
        }
    }

    /**
     * Get the last (rightmost) root child ID for afterCategoryId chaining.
     * Excludes the "Testing" category itself so it can be placed after the last blueprint category.
     */
    private async getLastRootChildId(
        context: PostProcessorContext,
        rootCategoryId: string
    ): Promise<string | null> {
        try {
            interface CategoryItem {
                id: string;
                name?: string;
                afterCategoryId?: string | null;
            }

            interface CategoryResponse {
                data?: CategoryItem[];
            }

            const response = await apiPost(context, "search/category", {
                filter: [{ type: "equals", field: "parentId", value: rootCategoryId }],
                limit: 500,
            });

            if (!response.ok) {
                return null;
            }

            const data = (await response.json()) as CategoryResponse;
            const allChildren = data.data ?? [];
            if (allChildren.length === 0) {
                return null;
            }

            // Exclude Testing category to find the last *blueprint* category
            const children = allChildren.filter((c) => c.name !== "Testing");
            if (children.length === 0) {
                return null;
            }

            const afterIds = new Set(
                children.map((c) => c.afterCategoryId).filter((id): id is string => id != null)
            );
            const last = children.find((c) => !afterIds.has(c.id));
            return last?.id ?? null;
        } catch (error) {
            logger.warn("Failed to get last root child for category ordering", { data: error });
            return null;
        }
    }

    /**
     * Update a category's afterCategoryId to fix ordering
     */
    private async updateCategoryPosition(
        context: PostProcessorContext,
        categoryId: string,
        afterCategoryId: string
    ): Promise<void> {
        const response = await apiPost(context, "_action/sync", {
            updateCategory: {
                entity: "category",
                action: "upsert",
                payload: [{ id: categoryId, afterCategoryId }],
            },
        });

        if (!response.ok) {
            logger.warn(`Failed to update category position for ${categoryId}`);
        }
    }

    /**
     * Delete a sub-category by name
     */
    private async deleteSubCategory(
        context: PostProcessorContext,
        name: string,
        parentId: string
    ): Promise<number> {
        const categoryId = await findCategoryIdByName(context, name, parentId);
        if (categoryId) {
            const success = await this.deleteEntity(context, "category", categoryId);
            if (success) {
                logger.info(`    ✓ Deleted "${name}" sub-category`, { cli: true });
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
            logger.info(`    ✓ Deleted "${name}" category`, { cli: true });
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

        try {
            const landingPageId = await this.findLandingPageByName(context, scopedName);
            if (landingPageId) {
                const success = await this.deleteEntity(context, "landing-page", landingPageId);
                if (success) {
                    logger.info(`    ✓ Deleted "${fixturePageName}" landing page`, { cli: true });
                } else {
                    errors.push(`Failed to delete "${fixturePageName}" landing page`);
                }
            }
        } catch (error) {
            errors.push(
                `Landing page lookup failed for "${fixturePageName}": ${errorMessage(error)}`
            );
        }

        try {
            const cmsPageId = await this.findCmsPageByName(context, scopedName);
            if (cmsPageId) {
                const success = await this.deleteEntity(context, "cms-page", cmsPageId);
                if (success) {
                    logger.info(`    ✓ Deleted "${fixturePageName}" CMS layout`, { cli: true });
                } else {
                    errors.push(`Failed to delete "${fixturePageName}" CMS layout`);
                }
            }
        } catch (error) {
            errors.push(`CMS page lookup failed for "${fixturePageName}": ${errorMessage(error)}`);
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
            logger.warn("Failed to get products for welcome page", { data: error });
        }

        return [];
    }

    /**
     * Get a product by type (simple, variant, digital, media)
     */
    private async getProductByType(
        context: PostProcessorContext,
        type: string
    ): Promise<string | null> {
        // For digital products, check the cache
        if (type === "digital") {
            return this.getDigitalProductId(context);
        }

        if (type === "media") {
            return this.getMediaProductId(context);
        }

        return this.getBlueprintProductId(context, type === "variant");
    }

    /** Media showcase product (deterministic ID), if the media-product processor created it */
    private async getMediaProductId(context: PostProcessorContext): Promise<string | null> {
        const found = await context.api.searchEntities<{ id: string }>("product", [], {
            ids: [MEDIA_SHOWCASE_PRODUCT_ID],
            limit: 1,
        });
        return found.length > 0 ? MEDIA_SHOWCASE_PRODUCT_ID : null;
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

    /** First blueprint product with (variant) or without (simple) variants */
    private getBlueprintProductId(context: PostProcessorContext, variant: boolean): string | null {
        return findProductIdByVariantFlag(context.blueprint.products, variant);
    }

    /**
     * Populate product IDs in the fixture
     */
    private populateProductIds(fixture: CmsPageFixture, productIds: string[]): CmsPageFixture {
        const cloned = cloneDeep(fixture);

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
        return toStoreScopedName(name, context.salesChannelName);
    }

    /**
     * Convert fixture name to URL-safe slug
     */
    private fixtureNameToUrl(name: string): string {
        return toFixtureUrlSlug(name);
    }
}

export const TestingProcessor = new TestingProcessorImpl();
