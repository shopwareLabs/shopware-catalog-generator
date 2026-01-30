/**
 * CMS Processor - Creates CMS landing pages and category links
 *
 * 1. Creates a CMS landing page with video elements (YouTube, Vimeo)
 * 2. Creates a "CMS" top-level category
 * 3. Creates a "Video Elements" sub-category linked to the landing page
 */

import type { CmsPageFixture } from "../fixtures/index.js";
import { VIDEO_ELEMENTS_PAGE } from "../fixtures/index.js";
import { logger } from "../utils/index.js";

import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

/** Internal result type for cleanup sub-operations */
interface CleanupSubResult {
    deleted: number;
    errors: string[];
}

/**
 * CMS Processor implementation
 */
class CmsProcessorImpl implements PostProcessor {
    readonly name = "cms";
    readonly description = "Create CMS landing pages and category links";
    readonly dependsOn: string[] = []; // No dependencies

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { options } = context;

        let processed = 0;
        const skipped = 0;
        const errors: string[] = [];

        if (options.dryRun) {
            console.log(`    [DRY RUN] Would create CMS layout "Video Elements"`);
            console.log(`    [DRY RUN] Would create Landing Page "Video Elements"`);
            console.log(
                `    [DRY RUN] Would create category "CMS" > "Video Elements" linked to Landing Page`
            );
            return {
                name: this.name,
                processed: 1,
                skipped: 0,
                errors: [],
                durationMs: 0,
            };
        }

        try {
            // Step 1: Get root category for the navigation
            const rootCategoryId = await this.getRootCategoryId(context);
            if (!rootCategoryId) {
                errors.push("Could not find root category for navigation");
                return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
            }

            // Step 2: Check if "CMS" category already exists
            let cmsCategoryId = await this.findCategoryByName(context, "CMS", rootCategoryId);

            if (!cmsCategoryId) {
                // Create "CMS" top-level category
                // Note: We don't set afterCategoryId - Shopware will place it based on createdAt
                // which means it will appear at the end naturally since it's created last
                cmsCategoryId = this.generateUUID();

                const createCmsCategory = await this.apiPost(context, "_action/sync", {
                    createCmsCategory: {
                        entity: "category",
                        action: "upsert",
                        payload: [
                            {
                                id: cmsCategoryId,
                                parentId: rootCategoryId,
                                name: "CMS",
                                active: true,
                                type: "page",
                                displayNestedProducts: false,
                                visible: true,
                            },
                        ],
                    },
                });

                if (!createCmsCategory.ok) {
                    const errorText = await createCmsCategory.text();
                    logger.apiError(
                        "_action/sync (create CMS category)",
                        createCmsCategory.status,
                        { error: errorText }
                    );
                    errors.push(`Failed to create CMS category: ${createCmsCategory.status}`);
                    return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
                }
                console.log(`    ✓ Created "CMS" top-level category`);
            } else {
                console.log(`    ⊘ "CMS" category already exists`);
            }

            // Step 3: Check if CMS page (layout) already exists
            let cmsPageId = await this.findCmsPageByName(context, VIDEO_ELEMENTS_PAGE.name);

            if (!cmsPageId) {
                // Create the CMS page layout
                cmsPageId = await this.createCmsPage(context, VIDEO_ELEMENTS_PAGE);
                if (!cmsPageId) {
                    errors.push("Failed to create CMS page layout");
                    return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
                }
                console.log(`    ✓ Created CMS layout "${VIDEO_ELEMENTS_PAGE.name}"`);
            } else {
                console.log(`    ⊘ CMS layout "${VIDEO_ELEMENTS_PAGE.name}" already exists`);
            }

            // Step 4: Check if Landing Page already exists
            let landingPageId = await this.findLandingPageByName(context, VIDEO_ELEMENTS_PAGE.name);

            if (!landingPageId) {
                // Create the Landing Page that uses the CMS layout
                landingPageId = await this.createLandingPage(
                    context,
                    VIDEO_ELEMENTS_PAGE.name,
                    cmsPageId
                );
                if (!landingPageId) {
                    errors.push("Failed to create Landing Page");
                    return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
                }
                console.log(`    ✓ Created Landing Page "${VIDEO_ELEMENTS_PAGE.name}"`);
            } else {
                // Landing page exists - check if current SalesChannel is associated
                const landingPageData = await this.getLandingPageWithSalesChannels(
                    context,
                    landingPageId
                );

                if (landingPageData) {
                    const isAssociated = landingPageData.salesChannelIds.includes(
                        context.salesChannelId
                    );

                    if (!isAssociated) {
                        // Add the current SalesChannel to the landing page
                        const added = await this.addSalesChannelToLandingPage(
                            context,
                            landingPageId,
                            context.salesChannelId
                        );
                        if (added) {
                            console.log(
                                `    ✓ Added SalesChannel to Landing Page "${VIDEO_ELEMENTS_PAGE.name}"`
                            );
                        } else {
                            errors.push("Failed to add SalesChannel to existing Landing Page");
                        }
                    } else {
                        console.log(
                            `    ⊘ Landing Page "${VIDEO_ELEMENTS_PAGE.name}" already includes SalesChannel`
                        );
                    }
                } else {
                    console.log(`    ⊘ Landing Page "${VIDEO_ELEMENTS_PAGE.name}" already exists`);
                }
            }

            // Step 5: Check if "Video Elements" sub-category already exists
            let videoElementsCategoryId = await this.findCategoryByName(
                context,
                "Video Elements",
                cmsCategoryId
            );

            if (!videoElementsCategoryId) {
                // Create "Video Elements" sub-category with link to Landing Page
                videoElementsCategoryId = this.generateUUID();
                const createVideoCategory = await this.apiPost(context, "_action/sync", {
                    createVideoCategory: {
                        entity: "category",
                        action: "upsert",
                        payload: [
                            {
                                id: videoElementsCategoryId,
                                parentId: cmsCategoryId,
                                name: "Video Elements",
                                active: true,
                                type: "link",
                                linkType: "landing_page", // Shopware uses snake_case for entity type
                                internalLink: landingPageId,
                                linkNewTab: false,
                                displayNestedProducts: false,
                                visible: true,
                            },
                        ],
                    },
                });

                if (!createVideoCategory.ok) {
                    const errorText = await createVideoCategory.text();
                    logger.apiError(
                        "_action/sync (create Video Elements category)",
                        createVideoCategory.status,
                        { error: errorText }
                    );
                    errors.push(
                        `Failed to create Video Elements category: ${createVideoCategory.status}`
                    );
                    return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
                }
                console.log(`    ✓ Created "Video Elements" sub-category linked to Landing Page`);
            } else {
                console.log(`    ⊘ "Video Elements" category already exists`);
            }

            processed = 1;
        } catch (error) {
            errors.push(
                `CMS processing failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        return {
            name: this.name,
            processed,
            skipped,
            errors,
            durationMs: 0,
        };
    }

    /**
     * Create a CMS landing page with sections, blocks, and slots
     */
    private async createCmsPage(
        context: PostProcessorContext,
        pageConfig: CmsPageFixture
    ): Promise<string | null> {
        const pageId = this.generateUUID();

        // Build the complete page structure
        const sections = pageConfig.sections.map((sectionConfig, sectionIndex) => {
            const sectionId = this.generateUUID();

            const blocks = sectionConfig.blocks.map((blockConfig) => {
                const blockId = this.generateUUID();

                const slots = blockConfig.slots.map((slotConfig) => ({
                    id: this.generateUUID(),
                    blockId,
                    type: slotConfig.type,
                    slot: slotConfig.slot,
                    config: slotConfig.config,
                }));

                return {
                    id: blockId,
                    sectionId,
                    type: blockConfig.type,
                    position: blockConfig.position,
                    sectionPosition: blockConfig.sectionPosition,
                    marginTop: blockConfig.marginTop,
                    marginBottom: blockConfig.marginBottom,
                    visibility: { mobile: true, desktop: true, tablet: true },
                    slots,
                };
            });

            return {
                id: sectionId,
                pageId,
                type: sectionConfig.type,
                sizingMode: sectionConfig.sizingMode,
                mobileBehavior: sectionConfig.mobileBehavior,
                position: sectionIndex,
                visibility: { mobile: true, desktop: true, tablet: true },
                blocks,
            };
        });

        // Create the CMS page with nested structure
        const response = await this.apiPost(context, "_action/sync", {
            createCmsPage: {
                entity: "cms_page",
                action: "upsert",
                payload: [
                    {
                        id: pageId,
                        name: pageConfig.name,
                        type: pageConfig.type,
                        sections,
                    },
                ],
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.apiError("_action/sync (create CMS page)", response.status, {
                error: errorText,
            });
            return null;
        }

        return pageId;
    }

    /**
     * Get the SalesChannel's navigation root category ID
     * This is the root category for the specific SalesChannel, not the global "Home"
     */
    private async getRootCategoryId(context: PostProcessorContext): Promise<string | null> {
        // Get the navigation category from the sales channel
        try {
            // Shopware Admin API returns data in attributes format
            interface SalesChannelResponse {
                data?: Array<{
                    id: string;
                    attributes?: {
                        navigationCategoryId?: string;
                    };
                    // Also support flat structure
                    navigationCategoryId?: string;
                }>;
            }

            const response = await this.apiPost(context, "search/sales-channel", {
                ids: [context.salesChannelId],
            });

            if (response.ok) {
                const data = (await response.json()) as SalesChannelResponse;
                const salesChannel = data.data?.[0];

                // Handle both nested (Admin API) and flat response structures
                const navigationCategoryId =
                    salesChannel?.attributes?.navigationCategoryId ||
                    salesChannel?.navigationCategoryId;

                if (navigationCategoryId) {
                    logger.debug("Found SalesChannel navigation category", {
                        salesChannelId: context.salesChannelId,
                        navigationCategoryId,
                    });
                    return navigationCategoryId;
                }
            }
        } catch (error) {
            logger.warn("Failed to get navigation category from sales channel", { error });
        }

        // No fallback - we specifically need the SalesChannel's root, not global root
        logger.warn("Could not find navigation category for SalesChannel", {
            salesChannelId: context.salesChannelId,
        });
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

            const response = await this.apiPost(context, "search/category", {
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
     * Find a CMS page by name
     */
    private async findCmsPageByName(
        context: PostProcessorContext,
        name: string
    ): Promise<string | null> {
        try {
            interface CmsPageResponse {
                data?: Array<{ id: string }>;
            }

            const response = await this.apiPost(context, "search/cms-page", {
                filter: [{ type: "equals", field: "name", value: name }],
                limit: 1,
            });

            if (response.ok) {
                const data = (await response.json()) as CmsPageResponse;
                return data.data?.[0]?.id || null;
            }
        } catch (error) {
            logger.warn(`Failed to find CMS page "${name}"`, { error });
        }

        return null;
    }

    /**
     * Find a Landing Page by name
     */
    private async findLandingPageByName(
        context: PostProcessorContext,
        name: string
    ): Promise<string | null> {
        try {
            interface LandingPageResponse {
                data?: Array<{ id: string }>;
            }

            const response = await this.apiPost(context, "search/landing-page", {
                filter: [{ type: "equals", field: "name", value: name }],
                limit: 1,
            });

            if (response.ok) {
                const data = (await response.json()) as LandingPageResponse;
                return data.data?.[0]?.id || null;
            }
        } catch (error) {
            logger.warn(`Failed to find Landing Page "${name}"`, { error });
        }

        return null;
    }

    /**
     * Get a Landing Page with its salesChannels association
     */
    private async getLandingPageWithSalesChannels(
        context: PostProcessorContext,
        landingPageId: string
    ): Promise<{ id: string; salesChannelIds: string[] } | null> {
        try {
            interface LandingPageItem {
                id: string;
                attributes?: {
                    salesChannels?: Array<{ id: string }>;
                };
                relationships?: {
                    salesChannels?: {
                        data?: Array<{ id: string }>;
                    };
                };
                // Direct format (when not using JSON:API envelope)
                salesChannels?: Array<{ id: string }>;
            }

            interface LandingPageResponse {
                data?: LandingPageItem | LandingPageItem[];
            }

            const response = await this.apiPost(context, `search/landing-page`, {
                ids: [landingPageId],
                associations: {
                    salesChannels: {},
                },
            });

            if (response.ok) {
                const responseData = (await response.json()) as LandingPageResponse;
                // Handle both array (search API) and object (single entity) formats
                const landingPage = Array.isArray(responseData.data)
                    ? responseData.data[0]
                    : responseData.data;

                if (landingPage) {
                    // Extract salesChannel IDs from the response
                    // Shopware returns associations in different formats depending on API version
                    const salesChannelIds: string[] = [];

                    // Check relationships format (JSON:API style)
                    const relData = landingPage.relationships?.salesChannels?.data;
                    if (Array.isArray(relData)) {
                        for (const sc of relData) {
                            if (sc.id) salesChannelIds.push(sc.id);
                        }
                    }

                    // Check attributes format (alternative)
                    const attrData = landingPage.attributes?.salesChannels;
                    if (Array.isArray(attrData)) {
                        for (const sc of attrData) {
                            if (sc.id && !salesChannelIds.includes(sc.id)) {
                                salesChannelIds.push(sc.id);
                            }
                        }
                    }

                    // Check direct format (when using associations without JSON:API envelope)
                    if (Array.isArray(landingPage.salesChannels)) {
                        for (const sc of landingPage.salesChannels) {
                            if (sc.id && !salesChannelIds.includes(sc.id)) {
                                salesChannelIds.push(sc.id);
                            }
                        }
                    }

                    return { id: landingPage.id, salesChannelIds };
                }
            }
        } catch (error) {
            logger.warn(`Failed to get Landing Page with associations`, { error });
        }

        return null;
    }

    /**
     * Add a SalesChannel to an existing Landing Page
     */
    private async addSalesChannelToLandingPage(
        context: PostProcessorContext,
        landingPageId: string,
        salesChannelId: string
    ): Promise<boolean> {
        try {
            const response = await this.apiPost(context, "_action/sync", {
                updateLandingPage: {
                    entity: "landing_page",
                    action: "upsert",
                    payload: [
                        {
                            id: landingPageId,
                            // Adding to the many-to-many - Shopware merges with existing
                            salesChannels: [{ id: salesChannelId }],
                        },
                    ],
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.apiError("_action/sync (add SalesChannel to Landing Page)", response.status, {
                    error: errorText,
                });
                return false;
            }

            return true;
        } catch (error) {
            logger.warn(`Failed to add SalesChannel to Landing Page`, { error });
            return false;
        }
    }

    /**
     * Remove a SalesChannel from a Landing Page
     */
    private async removeSalesChannelFromLandingPage(
        context: PostProcessorContext,
        landingPageId: string,
        salesChannelId: string
    ): Promise<boolean> {
        try {
            // Use the pivot table directly to remove the association
            const response = await this.apiPost(context, "_action/sync", {
                removeSalesChannelAssociation: {
                    entity: "landing_page_sales_channel",
                    action: "delete",
                    payload: [
                        {
                            landingPageId: landingPageId,
                            salesChannelId: salesChannelId,
                        },
                    ],
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.apiError(
                    "_action/sync (remove SalesChannel from Landing Page)",
                    response.status,
                    { error: errorText }
                );
                return false;
            }

            return true;
        } catch (error) {
            logger.warn(`Failed to remove SalesChannel from Landing Page`, { error });
            return false;
        }
    }

    /**
     * Create a Landing Page that uses a CMS layout
     *
     * Note: The landing_page_sales_channel many-to-many association requires
     * referencing the existing sales channel by "id", not "salesChannelId"
     */
    private async createLandingPage(
        context: PostProcessorContext,
        name: string,
        cmsPageId: string
    ): Promise<string | null> {
        const landingPageId = this.generateUUID();

        const response = await this.apiPost(context, "_action/sync", {
            createLandingPage: {
                entity: "landing_page",
                action: "upsert",
                payload: [
                    {
                        id: landingPageId,
                        name: name,
                        url: name.toLowerCase().replace(/\s+/g, "-"), // "Video Elements" -> "video-elements"
                        active: true,
                        cmsPageId: cmsPageId,
                        // Link to existing sales channel via many-to-many relationship
                        salesChannels: [{ id: context.salesChannelId }],
                    },
                ],
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.apiError("_action/sync (create Landing Page)", response.status, {
                error: errorText,
            });
            return null;
        }

        return landingPageId;
    }

    // =========================================================================
    // Cleanup
    // =========================================================================

    /** Internal result type for cleanup sub-operations */
    private createCleanupResult(deleted = 0, errors: string[] = []): CleanupSubResult {
        return { deleted, errors };
    }

    /**
     * Cleanup all CMS entities created by this processor
     */
    async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        if (context.options.dryRun) {
            return this.cleanupDryRun();
        }

        const rootCategoryId = await this.getRootCategoryId(context);
        if (!rootCategoryId) {
            return {
                name: this.name,
                deleted: 0,
                errors: ["Could not find root category for navigation"],
                durationMs: 0,
            };
        }

        const results = await Promise.all([
            this.cleanupCategories(context, rootCategoryId),
            this.cleanupLandingPage(context),
        ]);

        const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);
        const allErrors = results.flatMap((r) => r.errors);

        return { name: this.name, deleted: totalDeleted, errors: allErrors, durationMs: 0 };
    }

    /**
     * Dry run cleanup - just log what would be deleted
     */
    private cleanupDryRun(): PostProcessorCleanupResult {
        console.log(`    [DRY RUN] Would delete "Video Elements" category`);
        console.log(`    [DRY RUN] Would delete "CMS" category`);
        console.log(`    [DRY RUN] Would delete "Video Elements" landing page`);
        console.log(`    [DRY RUN] Would delete "Video Elements" CMS layout`);
        return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
    }

    /**
     * Cleanup CMS categories (Video Elements + CMS parent)
     */
    private async cleanupCategories(
        context: PostProcessorContext,
        rootCategoryId: string
    ): Promise<CleanupSubResult> {
        const cmsCategoryId = await this.findCategoryByName(context, "CMS", rootCategoryId);
        if (!cmsCategoryId) {
            console.log(`    ⊘ "CMS" category not found, skipping`);
            return this.createCleanupResult();
        }

        let deleted = 0;
        const errors: string[] = [];

        // Delete child first (Video Elements)
        const childResult = await this.deleteVideoElementsCategory(context, cmsCategoryId);
        deleted += childResult.deleted;
        errors.push(...childResult.errors);

        // Then delete parent (CMS)
        const parentResult = await this.deleteCategoryWithLog(context, cmsCategoryId, "CMS");
        deleted += parentResult.deleted;
        errors.push(...parentResult.errors);

        return { deleted, errors };
    }

    /**
     * Delete Video Elements sub-category if it exists
     */
    private async deleteVideoElementsCategory(
        context: PostProcessorContext,
        cmsCategoryId: string
    ): Promise<CleanupSubResult> {
        const videoElementsCategoryId = await this.findCategoryByName(
            context,
            "Video Elements",
            cmsCategoryId
        );
        if (!videoElementsCategoryId) {
            return this.createCleanupResult();
        }

        return this.deleteCategoryWithLog(context, videoElementsCategoryId, "Video Elements");
    }

    /**
     * Delete a category and log the result
     */
    private async deleteCategoryWithLog(
        context: PostProcessorContext,
        categoryId: string,
        categoryName: string
    ): Promise<CleanupSubResult> {
        const success = await this.deleteEntity(context, "category", categoryId);
        if (!success) {
            return this.createCleanupResult(0, [`Failed to delete ${categoryName} category`]);
        }

        console.log(`    ✓ Deleted "${categoryName}" category`);
        return this.createCleanupResult(1);
    }

    /**
     * Cleanup landing page - remove SalesChannel association or delete if last
     */
    private async cleanupLandingPage(context: PostProcessorContext): Promise<CleanupSubResult> {
        const landingPageId = await this.findLandingPageByName(context, VIDEO_ELEMENTS_PAGE.name);
        if (!landingPageId) {
            console.log(`    ⊘ "${VIDEO_ELEMENTS_PAGE.name}" landing page not found, skipping`);
            return this.createCleanupResult();
        }

        const landingPageData = await this.getLandingPageWithSalesChannels(context, landingPageId);
        if (!landingPageData) {
            return this.deleteLandingPageDirectly(context, landingPageId);
        }

        const isAssociated = landingPageData.salesChannelIds.includes(context.salesChannelId);
        if (!isAssociated) {
            console.log(
                `    ⊘ SalesChannel not associated with "${VIDEO_ELEMENTS_PAGE.name}" landing page`
            );
            return this.createCleanupResult();
        }

        return this.removeSalesChannelAndCleanup(context, landingPageId, landingPageData);
    }

    /**
     * Fallback: delete landing page directly without checking associations
     */
    private async deleteLandingPageDirectly(
        context: PostProcessorContext,
        landingPageId: string
    ): Promise<CleanupSubResult> {
        const success = await this.deleteEntity(context, "landing-page", landingPageId);
        if (!success) {
            return this.createCleanupResult(0, ["Failed to delete landing page"]);
        }

        console.log(`    ✓ Deleted "${VIDEO_ELEMENTS_PAGE.name}" landing page`);
        return this.createCleanupResult(1);
    }

    /**
     * Remove SalesChannel from landing page and cleanup orphaned entities
     */
    private async removeSalesChannelAndCleanup(
        context: PostProcessorContext,
        landingPageId: string,
        landingPageData: { salesChannelIds: string[] }
    ): Promise<CleanupSubResult> {
        const removed = await this.removeSalesChannelFromLandingPage(
            context,
            landingPageId,
            context.salesChannelId
        );
        if (!removed) {
            return this.createCleanupResult(0, ["Failed to remove SalesChannel from landing page"]);
        }

        console.log(
            `    ✓ Removed SalesChannel from "${VIDEO_ELEMENTS_PAGE.name}" landing page`
        );

        const isLastSalesChannel = landingPageData.salesChannelIds.length === 1;
        if (!isLastSalesChannel) {
            const remaining = landingPageData.salesChannelIds.length - 1;
            console.log(`    ⊘ Landing page still used by ${remaining} other SalesChannel(s)`);
            return this.createCleanupResult(1);
        }

        // This was the last SalesChannel - delete the landing page and CMS page
        return this.deleteOrphanedLandingPageAndCms(context, landingPageId);
    }

    /**
     * Delete landing page and its CMS layout when no SalesChannels remain
     */
    private async deleteOrphanedLandingPageAndCms(
        context: PostProcessorContext,
        landingPageId: string
    ): Promise<CleanupSubResult> {
        let deleted = 1; // Already counted the SC removal
        const errors: string[] = [];

        // Delete landing page
        const lpSuccess = await this.deleteEntity(context, "landing-page", landingPageId);
        if (lpSuccess) {
            console.log(
                `    ✓ Deleted "${VIDEO_ELEMENTS_PAGE.name}" landing page (no more SalesChannels)`
            );
            deleted++;
        }
        if (!lpSuccess) {
            errors.push("Failed to delete landing page after removing last SalesChannel");
        }

        // Delete CMS page
        const cmsPageId = await this.findCmsPageByName(context, VIDEO_ELEMENTS_PAGE.name);
        if (!cmsPageId) {
            return { deleted, errors };
        }

        const cmsSuccess = await this.deleteEntity(context, "cms-page", cmsPageId);
        if (cmsSuccess) {
            console.log(
                `    ✓ Deleted "${VIDEO_ELEMENTS_PAGE.name}" CMS layout (no more SalesChannels)`
            );
            deleted++;
        }
        if (!cmsSuccess) {
            errors.push("Failed to delete CMS page");
        }

        return { deleted, errors };
    }

    /**
     * Delete an entity by ID
     */
    private async deleteEntity(
        context: PostProcessorContext,
        entityType: string,
        entityId: string
    ): Promise<boolean> {
        try {
            // Use context.api if available
            if (context.api) {
                return await context.api.deleteEntity(entityType, entityId);
            }

            // Fallback to raw fetch
            const accessToken = await context.getAccessToken();
            const url = `${context.shopwareUrl}/api/${entityType}/${entityId}`;
            const response = await fetch(url, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            return response.ok || response.status === 204;
        } catch (error) {
            logger.warn(`Failed to delete ${entityType}/${entityId}`, { error });
            return false;
        }
    }

    /**
     * Make a POST request to Shopware API
     */
    private async apiPost(
        context: PostProcessorContext,
        endpoint: string,
        body: unknown
    ): Promise<Response> {
        // Use context.api if available
        if (context.api) {
            const result = await context.api.post(endpoint, body);
            // Create a Response-like object for compatibility
            return new Response(JSON.stringify(result), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        // Fallback to raw fetch
        const accessToken = await context.getAccessToken();
        const url = `${context.shopwareUrl}/api/${endpoint}`;
        return fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify(body),
        });
    }

    private generateUUID(): string {
        // Use context.api if it has createUUID, otherwise generate locally
        const hex = "0123456789abcdef";
        let uuid = "";
        for (let i = 0; i < 32; i++) {
            uuid += hex[Math.floor(Math.random() * 16)];
        }
        return uuid;
    }
}

/** CMS processor singleton */
export const CmsProcessor = new CmsProcessorImpl();
