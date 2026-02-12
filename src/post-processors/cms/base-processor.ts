/**
 * Base CMS Processor - Shared logic for CMS page/landing page creation
 *
 * Element processors extend this class to create specific demo pages.
 */

import fs from "node:fs";
import path from "node:path";

import type { CmsPageFixture } from "../../fixtures/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "../index.js";

import { apiPost, generateUUID, logger } from "../../utils/index.js";

/** Filename for storing CMS landing page IDs */
const CMS_LANDING_PAGES_FILE = "cms-landing-pages.json";

/**
 * Abstract base class for CMS element processors
 *
 * Each element processor creates:
 * 1. A CMS page (layout with sections/blocks/slots) - unique per SalesChannel
 * 2. A Landing page (entity that uses the CMS page, linked to SalesChannel)
 *
 * CMS pages are named with SalesChannel prefix to ensure each store gets
 * its own page with store-specific product/media data.
 *
 * The landing page ID is stored in cache for the orchestrator to retrieve.
 */
export abstract class BaseCmsProcessor implements PostProcessor {
    abstract readonly name: string;
    abstract readonly description: string;
    abstract readonly pageFixture: CmsPageFixture;
    readonly dependsOn: string[] = [];

    /**
     * Get store-scoped CMS page name (unique per SalesChannel)
     * Format: "Page Name [storeName]"
     */
    protected getCmsPageName(context: PostProcessorContext): string {
        return `${this.pageFixture.name} [${context.salesChannelName}]`;
    }

    /**
     * Get store-scoped landing page name (unique per SalesChannel)
     * Format: "Page Name [storeName]"
     */
    protected getLandingPageName(context: PostProcessorContext): string {
        return `${this.pageFixture.name} [${context.salesChannelName}]`;
    }

    /**
     * Get the landing page URL (uses fixture name without prefix for clean URLs)
     */
    protected getLandingPageUrl(): string {
        return this.pageFixture.name.toLowerCase().replace(/\s+/g, "-").replace(/&/g, "and");
    }

    /**
     * Process: Create CMS page and landing page
     */
    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { options } = context;
        const errors: string[] = [];
        const cmsPageName = this.getCmsPageName(context);
        const landingPageName = this.getLandingPageName(context);

        if (options.dryRun) {
            logger.info(`    [DRY RUN] Would create CMS layout "${cmsPageName}"`, { cli: true });
            logger.info(`    [DRY RUN] Would create Landing Page "${landingPageName}"`, {
                cli: true,
            });
            return {
                name: this.name,
                processed: 1,
                skipped: 0,
                errors: [],
                durationMs: 0,
            };
        }

        try {
            // Step 1: Check if CMS page already exists for this SalesChannel
            let cmsPageId = await this.findCmsPageByName(context, cmsPageName);

            if (!cmsPageId) {
                // Create the CMS page layout with store-scoped name
                cmsPageId = await this.createCmsPage(context, this.pageFixture, cmsPageName);
                if (!cmsPageId) {
                    errors.push(`Failed to create CMS page layout "${cmsPageName}"`);
                    return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
                }
                logger.info(`    ✓ Created CMS layout "${this.pageFixture.name}"`, { cli: true });
            } else {
                logger.info(`    ⊘ CMS layout "${this.pageFixture.name}" already exists`, {
                    cli: true,
                });
            }

            // Step 2: Check if Landing Page already exists for this SalesChannel
            let landingPageId = await this.findLandingPageByName(context, landingPageName);

            if (!landingPageId) {
                // Create the Landing Page with store-scoped name
                landingPageId = await this.createLandingPage(context, landingPageName, cmsPageId);
                if (!landingPageId) {
                    errors.push(`Failed to create Landing Page "${landingPageName}"`);
                    return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
                }
                logger.info(`    ✓ Created Landing Page "${this.pageFixture.name}"`, {
                    cli: true,
                });
            } else {
                await this.ensureSalesChannelAssociated(
                    context,
                    landingPageId,
                    this.pageFixture.name,
                    errors
                );
            }

            // Step 3: Store landing page ID for orchestrator
            await this.storeLandingPageId(context, landingPageId);
        } catch (error) {
            errors.push(
                `CMS processing failed: ${error instanceof Error ? error.message : String(error)}`
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
     * Cleanup: Delete store-scoped landing page and CMS page
     *
     * Since pages are now unique per SalesChannel, we can safely delete them
     * without checking for other SalesChannel associations.
     */
    async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        const landingPageName = this.getLandingPageName(context);
        const cmsPageName = this.getCmsPageName(context);

        if (context.options.dryRun) {
            logger.info(`    [DRY RUN] Would delete "${this.pageFixture.name}" landing page`, {
                cli: true,
            });
            logger.info(`    [DRY RUN] Would delete "${this.pageFixture.name}" CMS layout`, {
                cli: true,
            });
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        let deleted = 0;
        const errors: string[] = [];

        // Delete the store-scoped landing page
        try {
            const landingPageId = await this.findLandingPageByName(context, landingPageName);
            if (landingPageId) {
                const lpSuccess = await this.deleteEntity(context, "landing-page", landingPageId);
                if (lpSuccess) {
                    logger.info(`    ✓ Deleted "${this.pageFixture.name}" landing page`, {
                        cli: true,
                    });
                    deleted++;
                } else {
                    errors.push(`Failed to delete landing page "${landingPageName}"`);
                }
            } else {
                logger.info(`    ⊘ "${this.pageFixture.name}" landing page not found, skipping`, {
                    cli: true,
                });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`Landing page lookup failed: ${message}`);
            logger.error(`    ✗ ${message}`, { cli: true });
        }

        // Delete the store-scoped CMS page
        try {
            const cmsPageId = await this.findCmsPageByName(context, cmsPageName);
            if (cmsPageId) {
                const cmsSuccess = await this.deleteEntity(context, "cms-page", cmsPageId);
                if (cmsSuccess) {
                    logger.info(`    ✓ Deleted "${this.pageFixture.name}" CMS layout`, {
                        cli: true,
                    });
                    deleted++;
                } else {
                    errors.push(`Failed to delete CMS page "${cmsPageName}"`);
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`CMS page lookup failed: ${message}`);
            logger.error(`    ✗ ${message}`, { cli: true });
        }

        return { name: this.name, deleted, errors, durationMs: 0 };
    }

    // =========================================================================
    // CMS Page Operations
    // =========================================================================

    /**
     * Create a CMS page with sections, blocks, and slots
     * @param context - The processor context
     * @param pageConfig - The page fixture configuration
     * @param customName - Optional custom name (defaults to fixture name)
     */
    protected async createCmsPage(
        context: PostProcessorContext,
        pageConfig: CmsPageFixture,
        customName?: string
    ): Promise<string | null> {
        const pageId = generateUUID();
        const pageName = customName || pageConfig.name;

        const sections = pageConfig.sections.map((sectionConfig, sectionIndex) => {
            const sectionId = generateUUID();

            const blocks = sectionConfig.blocks.map((blockConfig) => {
                const blockId = generateUUID();

                const slots = blockConfig.slots.map((slotConfig) => ({
                    id: generateUUID(),
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
                    backgroundMediaId: blockConfig.backgroundMediaId,
                    backgroundMediaMode: blockConfig.backgroundMediaMode,
                    cssClass: blockConfig.cssClass,
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

        const response = await apiPost(context, "_action/sync", {
            createCmsPage: {
                entity: "cms_page",
                action: "upsert",
                payload: [
                    {
                        id: pageId,
                        name: pageName,
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
     * Find a CMS page by name
     */
    protected async findCmsPageByName(
        context: PostProcessorContext,
        name: string
    ): Promise<string | null> {
        interface CmsPageResponse {
            data?: Array<{ id: string }>;
        }

        const response = await apiPost(context, "search/cms-page", {
            filter: [{ type: "equals", field: "name", value: name }],
            limit: 1,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
                `Search for CMS page "${name}" failed: ${response.status} - ${errorText}`
            );
        }

        const data = (await response.json()) as CmsPageResponse;
        return data.data?.[0]?.id || null;
    }

    // =========================================================================
    // Landing Page Operations
    // =========================================================================

    /**
     * Create a Landing Page that uses a CMS layout
     * @param context - The processor context
     * @param name - The landing page name (can include store prefix)
     * @param cmsPageId - The CMS page ID to link
     * @param customUrl - Optional custom URL (defaults to fixture-based URL)
     */
    protected async createLandingPage(
        context: PostProcessorContext,
        name: string,
        cmsPageId: string,
        customUrl?: string
    ): Promise<string | null> {
        const landingPageId = generateUUID();
        const url = customUrl || this.getLandingPageUrl();

        const response = await apiPost(context, "_action/sync", {
            createLandingPage: {
                entity: "landing_page",
                action: "upsert",
                payload: [
                    {
                        id: landingPageId,
                        name: name,
                        url: url,
                        active: true,
                        cmsPageId: cmsPageId,
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

    /**
     * Find a Landing Page by name
     */
    protected async findLandingPageByName(
        context: PostProcessorContext,
        name: string
    ): Promise<string | null> {
        interface LandingPageResponse {
            data?: Array<{ id: string }>;
        }

        const response = await apiPost(context, "search/landing-page", {
            filter: [{ type: "equals", field: "name", value: name }],
            limit: 1,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
                `Search for Landing Page "${name}" failed: ${response.status} - ${errorText}`
            );
        }

        const data = (await response.json()) as LandingPageResponse;
        return data.data?.[0]?.id || null;
    }

    /**
     * Get a Landing Page with its salesChannels association
     */
    protected async getLandingPageWithSalesChannels(
        context: PostProcessorContext,
        landingPageId: string
    ): Promise<{ id: string; salesChannelIds: string[] } | null> {
        try {
            interface LandingPageItem {
                id: string;
                attributes?: { salesChannels?: Array<{ id: string }> };
                relationships?: { salesChannels?: { data?: Array<{ id: string }> } };
                salesChannels?: Array<{ id: string }>;
            }

            interface LandingPageResponse {
                data?: LandingPageItem | LandingPageItem[];
            }

            const response = await apiPost(context, `search/landing-page`, {
                ids: [landingPageId],
                associations: { salesChannels: {} },
            });

            if (response.ok) {
                const responseData = (await response.json()) as LandingPageResponse;
                const landingPage = Array.isArray(responseData.data)
                    ? responseData.data[0]
                    : responseData.data;

                if (landingPage) {
                    const salesChannelIds: string[] = [];

                    const relData = landingPage.relationships?.salesChannels?.data;
                    if (Array.isArray(relData)) {
                        for (const sc of relData) {
                            if (sc.id) salesChannelIds.push(sc.id);
                        }
                    }

                    const attrData = landingPage.attributes?.salesChannels;
                    if (Array.isArray(attrData)) {
                        for (const sc of attrData) {
                            if (sc.id && !salesChannelIds.includes(sc.id)) {
                                salesChannelIds.push(sc.id);
                            }
                        }
                    }

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
            logger.warn(`Failed to get Landing Page with associations`, { data: error });
        }

        return null;
    }

    /**
     * Add a SalesChannel to an existing Landing Page
     */
    protected async addSalesChannelToLandingPage(
        context: PostProcessorContext,
        landingPageId: string,
        salesChannelId: string
    ): Promise<boolean> {
        try {
            const response = await apiPost(context, "_action/sync", {
                updateLandingPage: {
                    entity: "landing_page",
                    action: "upsert",
                    payload: [{ id: landingPageId, salesChannels: [{ id: salesChannelId }] }],
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.apiError(
                    "_action/sync (add SalesChannel to Landing Page)",
                    response.status,
                    { error: errorText }
                );
                return false;
            }

            return true;
        } catch (error) {
            logger.warn(`Failed to add SalesChannel to Landing Page`, { data: error });
            return false;
        }
    }

    /**
     * Ensure SalesChannel is associated with landing page
     * Uses early returns - no else statements
     */
    protected async ensureSalesChannelAssociated(
        context: PostProcessorContext,
        landingPageId: string,
        pageName: string,
        errors: string[]
    ): Promise<void> {
        const landingPageData = await this.getLandingPageWithSalesChannels(context, landingPageId);

        if (!landingPageData) {
            logger.info(`    ⊘ Landing Page "${pageName}" already exists`, { cli: true });
            return;
        }

        if (landingPageData.salesChannelIds.includes(context.salesChannelId)) {
            logger.info(`    ⊘ Landing Page "${pageName}" already includes SalesChannel`, {
                cli: true,
            });
            return;
        }

        const added = await this.addSalesChannelToLandingPage(
            context,
            landingPageId,
            context.salesChannelId
        );
        if (!added) {
            errors.push("Failed to add SalesChannel to existing Landing Page");
            return;
        }

        logger.info(`    ✓ Added SalesChannel to Landing Page "${pageName}"`, { cli: true });
    }

    /**
     * Remove a SalesChannel from a Landing Page
     */
    protected async removeSalesChannelFromLandingPage(
        context: PostProcessorContext,
        landingPageId: string,
        salesChannelId: string
    ): Promise<boolean> {
        try {
            const response = await apiPost(context, "_action/sync", {
                removeSalesChannelAssociation: {
                    entity: "landing_page_sales_channel",
                    action: "delete",
                    payload: [{ landingPageId, salesChannelId }],
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
            logger.warn(`Failed to remove SalesChannel from Landing Page`, { data: error });
            return false;
        }
    }

    // =========================================================================
    // Cache Operations
    // =========================================================================

    /**
     * Store landing page ID in cache for orchestrator to retrieve
     */
    protected storeLandingPageId(context: PostProcessorContext, landingPageId: string): void {
        const filePath = this.getCmsLandingPagesFilePath(context);
        const cmsLandingPages = this.getLandingPageIds(context);
        cmsLandingPages[this.name] = landingPageId;

        // Ensure directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(filePath, JSON.stringify(cmsLandingPages, null, 2));
    }

    /**
     * Get stored landing page IDs from cache
     */
    protected getLandingPageIds(context: PostProcessorContext): Record<string, string> {
        const filePath = this.getCmsLandingPagesFilePath(context);
        if (!fs.existsSync(filePath)) {
            return {};
        }
        try {
            const data = fs.readFileSync(filePath, "utf-8");
            return JSON.parse(data) as Record<string, string>;
        } catch {
            return {};
        }
    }

    /**
     * Get the path to the CMS landing pages cache file
     */
    private getCmsLandingPagesFilePath(context: PostProcessorContext): string {
        const scDir = context.cache.getSalesChannelDir(context.salesChannelName);
        return path.join(scDir, CMS_LANDING_PAGES_FILE);
    }

    // =========================================================================
    // Entity Operations
    // =========================================================================

    /**
     * Delete an entity by ID
     */
    protected async deleteEntity(
        context: PostProcessorContext,
        entityType: string,
        entityId: string
    ): Promise<boolean> {
        try {
            if (context.api) {
                return await context.api.deleteEntity(entityType, entityId);
            }

            const accessToken = await context.getAccessToken();
            const url = `${context.shopwareUrl}/api/${entityType}/${entityId}`;
            const response = await fetch(url, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            return response.ok || response.status === 204;
        } catch (error) {
            logger.warn(`Failed to delete ${entityType}/${entityId}`, { data: error });
            return false;
        }
    }
}
