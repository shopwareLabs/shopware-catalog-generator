/**
 * Base CMS Processor - Shared logic for CMS page/landing page creation
 *
 * Element processors extend this class to create specific demo pages.
 */

import fs from "node:fs";
import path from "node:path";

import type {
    CmsBlockConfig,
    CmsPageFixture,
    CmsSectionConfig,
    CmsSlotConfig,
} from "../../fixtures/index.js";
import type {
    CmsBlueprintBlock,
    CmsBlueprintPage,
    CmsBlueprintSection,
} from "../../types/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "../index.js";

import {
    detectImageFormat,
    apiPost,
    cloneDeep,
    generateUUID,
    logger,
    toFixtureUrlSlug,
    toStoreScopedName,
} from "../../utils/index.js";
import { uploadImageWithRetry } from "../image-utils.js";

/** Filename for storing CMS landing page IDs */
const CMS_LANDING_PAGES_FILE = "cms-landing-pages.json";

/** Log lines for a created or reused CMS layout */
export interface CmsLayoutLogs {
    created: string;
    reused: string;
}

/** Fixture to create the CMS layout from, with its log lines */
export interface PreparedCmsPage {
    fixture: CmsPageFixture;
    logs: CmsLayoutLogs;
}

/** Image slider or gallery item that shows a media entity */
export interface CmsSliderItem {
    mediaId: string;
    url: null;
    newTab: boolean;
}

/** One store-scoped page that cleanup deletes */
interface StorePageDeletion {
    entity: "landing-page" | "cms-page";
    findId: () => Promise<string | null>;
    deletedLog: string;
    failedError: string;
    lookupLabel: string;
    missingLog?: string;
}

interface LandingPageItem {
    id: string;
    attributes?: { salesChannels?: Array<{ id: string }> };
    relationships?: { salesChannels?: { data?: Array<{ id: string }> } };
    salesChannels?: Array<{ id: string }>;
}

interface LandingPageResponse {
    data?: LandingPageItem | LandingPageItem[];
}

/** Slider items (image-slider, image-gallery) for the given media IDs */
export function toSliderItems(mediaIds: string[]): CmsSliderItem[] {
    return mediaIds.map((mediaId) => ({ mediaId, url: null, newTab: false }));
}

/** All blocks of a fixture, in page order */
export function fixtureBlocks(fixture: CmsPageFixture): CmsBlockConfig[] {
    return fixture.sections.flatMap((section) => section.blocks);
}

/** All slots of a fixture, in page order */
export function fixtureSlots(fixture: CmsPageFixture): CmsSlotConfig[] {
    return fixtureBlocks(fixture).flatMap((block) => block.slots);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Copy hydrated text into the block's text slots that have content, in slot order */
function applyHydratedBlockText(block: CmsBlockConfig, hydratedBlock: CmsBlueprintBlock): void {
    block.slots
        .filter((slot) => slot.type === "text" && slot.config.content)
        .forEach((slot, index) => {
            const textContent = hydratedBlock.slots[index]?.textContent;
            if (!textContent) return;
            slot.config.content = { source: "static", value: textContent };
        });
}

/** Apply hydrated text block by block (matched by position in the section) */
function applyHydratedSectionText(
    section: CmsSectionConfig,
    hydratedSection: CmsBlueprintSection
): void {
    section.blocks.forEach((block, index) => {
        const hydratedBlock = hydratedSection.blocks[index];
        if (hydratedBlock) applyHydratedBlockText(block, hydratedBlock);
    });
}

/** IDs of the entities that have one (non-arrays count as empty) */
function entityIds(entities: Array<{ id: string }> | undefined): string[] {
    if (!Array.isArray(entities)) return [];
    return entities.map((entity) => entity.id).filter((id) => Boolean(id));
}

/**
 * SalesChannel IDs of a landing page: relationship data first, then the unique
 * IDs from attributes and the entity itself (the API returns any of these shapes)
 */
function landingPageSalesChannelIds(landingPage: LandingPageItem): string[] {
    const relationIds = entityIds(landingPage.relationships?.salesChannels?.data);
    const otherIds = [
        ...entityIds(landingPage.attributes?.salesChannels),
        ...entityIds(landingPage.salesChannels),
    ];
    return otherIds.reduce((ids, id) => (ids.includes(id) ? ids : [...ids, id]), relationIds);
}

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
        return toStoreScopedName(this.pageFixture.name, context.salesChannelName);
    }

    /**
     * Get store-scoped landing page name (unique per SalesChannel)
     * Format: "Page Name [storeName]"
     */
    protected getLandingPageName(context: PostProcessorContext): string {
        return toStoreScopedName(this.pageFixture.name, context.salesChannelName);
    }

    /**
     * Get the landing page URL (uses fixture name without prefix for clean URLs)
     */
    protected getLandingPageUrl(): string {
        return toFixtureUrlSlug(this.pageFixture.name);
    }

    /**
     * Get the hydrated CMS page from cached CMS blueprint (if available).
     * Returns null if no CMS blueprint is cached or page not found.
     */
    protected getHydratedCmsPage(context: PostProcessorContext): CmsBlueprintPage | null {
        const cmsBlueprint = context.cache.loadCmsBlueprint(context.salesChannelName);
        if (!cmsBlueprint) return null;
        return cmsBlueprint.pages.find((p) => p.name === this.pageFixture.name) ?? null;
    }

    /**
     * Apply hydrated CMS text to a fixture, returning a new fixture with AI text.
     * Falls back to original fixture text if no hydrated content is found.
     */
    protected applyHydratedText(
        fixture: CmsPageFixture,
        hydratedPage: CmsBlueprintPage | null
    ): CmsPageFixture {
        if (!hydratedPage) return fixture;

        const cloned = cloneDeep(fixture);
        cloned.sections.forEach((section, index) => {
            const hydratedSection = hydratedPage.sections[index];
            if (hydratedSection) applyHydratedSectionText(section, hydratedSection);
        });
        return cloned;
    }

    /**
     * Process: Create CMS page and landing page
     */
    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        if (context.options.dryRun) {
            return this.dryRunResult(
                this.getCmsPageName(context),
                this.getLandingPageName(context)
            );
        }

        return this.processPage(context, async () => ({
            fixture: this.applyHydratedText(this.pageFixture, this.getHydratedCmsPage(context)),
            logs: {
                created: `    ✓ Created CMS layout "${this.pageFixture.name}"`,
                reused: `    ✓ Reusing CMS layout "${this.pageFixture.name}"`,
            },
        }));
    }

    /** Log lines for processors that report what they put into a new layout */
    protected layoutLogs(createdDetail: string): CmsLayoutLogs {
        return {
            created: `    ✓ Created CMS layout "${this.pageFixture.name}" ${createdDetail}`,
            reused: `    ⊘ CMS layout "${this.pageFixture.name}" already exists`,
        };
    }

    /** Log the pages a dry run would create. The page counts as processed */
    protected dryRunResult(cmsPageLabel: string, landingPageLabel: string): PostProcessorResult {
        logger.info(`    [DRY RUN] Would create CMS layout "${cmsPageLabel}"`, { cli: true });
        logger.info(`    [DRY RUN] Would create Landing Page "${landingPageLabel}"`, { cli: true });
        return { name: this.name, processed: 1, skipped: 0, errors: [], durationMs: 0 };
    }

    /**
     * Prepare the fixture, create or reuse the CMS layout and landing page,
     * then store the landing page ID. A thrown error fails the page.
     */
    protected async processPage(
        context: PostProcessorContext,
        prepare: () => Promise<PreparedCmsPage>
    ): Promise<PostProcessorResult> {
        const errors: string[] = [];
        try {
            const { fixture, logs } = await prepare();
            await this.createOrReusePages(context, fixture, logs, errors);
        } catch (error) {
            errors.push(`CMS processing failed: ${errorMessage(error)}`);
        }

        return {
            name: this.name,
            processed: errors.length === 0 ? 1 : 0,
            skipped: 0,
            errors,
            durationMs: 0,
        };
    }

    private async createOrReusePages(
        context: PostProcessorContext,
        fixture: CmsPageFixture,
        logs: CmsLayoutLogs,
        errors: string[]
    ): Promise<void> {
        const cmsPageId = await this.ensureCmsPage(context, fixture, logs, errors);
        if (!cmsPageId) return;

        const landingPageId = await this.ensureLandingPage(context, cmsPageId, errors);
        if (!landingPageId) return;

        // Store landing page ID for the orchestrator
        await this.storeLandingPageId(context, landingPageId);
    }

    /** Reuse the store's CMS layout or create it from the fixture. Returns its ID */
    private async ensureCmsPage(
        context: PostProcessorContext,
        fixture: CmsPageFixture,
        logs: CmsLayoutLogs,
        errors: string[]
    ): Promise<string | null> {
        const cmsPageName = this.getCmsPageName(context);
        const existingId = await this.findCmsPageByName(context, cmsPageName);
        if (existingId) {
            logger.info(logs.reused, { cli: true });
            return existingId;
        }

        const cmsPageId = await this.createCmsPage(context, fixture, cmsPageName);
        if (!cmsPageId) {
            errors.push(`Failed to create CMS page layout "${cmsPageName}"`);
            return null;
        }
        logger.info(logs.created, { cli: true });
        return cmsPageId;
    }

    /** Reuse the store's landing page (and link the SalesChannel) or create it. Returns its ID */
    private async ensureLandingPage(
        context: PostProcessorContext,
        cmsPageId: string,
        errors: string[]
    ): Promise<string | null> {
        const landingPageName = this.getLandingPageName(context);
        const existingId = await this.findLandingPageByName(context, landingPageName);
        if (existingId) {
            await this.ensureSalesChannelAssociated(
                context,
                existingId,
                this.pageFixture.name,
                errors
            );
            return existingId;
        }

        const landingPageId = await this.createLandingPage(context, landingPageName, cmsPageId);
        if (!landingPageId) {
            errors.push(`Failed to create Landing Page "${landingPageName}"`);
            return null;
        }
        logger.info(`    ✓ Created Landing Page "${this.pageFixture.name}"`, { cli: true });
        return landingPageId;
    }

    /**
     * Cleanup: Delete store-scoped landing page and CMS page
     *
     * Since pages are now unique per SalesChannel, we can safely delete them
     * without checking for other SalesChannel associations.
     */
    async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        const pageName = this.pageFixture.name;
        if (context.options.dryRun) {
            logger.info(`    [DRY RUN] Would delete "${pageName}" landing page`, { cli: true });
            logger.info(`    [DRY RUN] Would delete "${pageName}" CMS layout`, { cli: true });
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        const errors: string[] = [];
        const landingPageName = this.getLandingPageName(context);
        const deletedLandingPages = await this.deleteStorePage(
            context,
            {
                entity: "landing-page",
                findId: () => this.findLandingPageByName(context, landingPageName),
                deletedLog: `    ✓ Deleted "${pageName}" landing page`,
                failedError: `Failed to delete landing page "${landingPageName}"`,
                lookupLabel: "Landing page",
                missingLog: `    ⊘ "${pageName}" landing page not found, skipping`,
            },
            errors
        );

        const cmsPageName = this.getCmsPageName(context);
        const deletedCmsPages = await this.deleteStorePage(
            context,
            {
                entity: "cms-page",
                findId: () => this.findCmsPageByName(context, cmsPageName),
                deletedLog: `    ✓ Deleted "${pageName}" CMS layout`,
                failedError: `Failed to delete CMS page "${cmsPageName}"`,
                lookupLabel: "CMS page",
            },
            errors
        );

        return {
            name: this.name,
            deleted: deletedLandingPages + deletedCmsPages,
            errors,
            durationMs: 0,
        };
    }

    /** Find and delete one store-scoped page. Returns the number of deleted pages (0 or 1) */
    private async deleteStorePage(
        context: PostProcessorContext,
        page: StorePageDeletion,
        errors: string[]
    ): Promise<number> {
        try {
            const pageId = await page.findId();
            if (!pageId) {
                if (page.missingLog) logger.info(page.missingLog, { cli: true });
                return 0;
            }

            const deleted = await this.deleteEntity(context, page.entity, pageId);
            if (!deleted) {
                errors.push(page.failedError);
                return 0;
            }
            logger.info(page.deletedLog, { cli: true });
            return 1;
        } catch (error) {
            const message = errorMessage(error);
            errors.push(`${page.lookupLabel} lookup failed: ${message}`);
            logger.error(`    ✗ ${message}`, { cli: true });
            return 0;
        }
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
            const landingPage = await this.searchLandingPageWithSalesChannels(
                context,
                landingPageId
            );
            if (!landingPage) return null;
            return { id: landingPage.id, salesChannelIds: landingPageSalesChannelIds(landingPage) };
        } catch (error) {
            logger.warn(`Failed to get Landing Page with associations`, { data: error });
            return null;
        }
    }

    private async searchLandingPageWithSalesChannels(
        context: PostProcessorContext,
        landingPageId: string
    ): Promise<LandingPageItem | null> {
        const response = await apiPost(context, `search/landing-page`, {
            ids: [landingPageId],
            associations: { salesChannels: {} },
        });
        if (!response.ok) return null;

        const responseData = (await response.json()) as LandingPageResponse;
        const landingPage = Array.isArray(responseData.data)
            ? responseData.data[0]
            : responseData.data;
        return landingPage ?? null;
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
    // CMS Media Operations
    // =========================================================================

    private cmsMediaFolderId: string | null = null;

    /**
     * Get the "CMS Media" folder ID in Shopware (cached per instance)
     */
    protected async getCmsMediaFolderId(context: PostProcessorContext): Promise<string | null> {
        if (this.cmsMediaFolderId) return this.cmsMediaFolderId;

        interface FolderResponse {
            data?: Array<{ id: string }>;
        }

        const response = await apiPost(context, "search/media-default-folder", {
            filter: [{ type: "equals", field: "entity", value: "cms_page" }],
            associations: { folder: {} },
            limit: 1,
        });

        if (!response.ok) return null;

        const data = (await response.json()) as {
            data?: Array<{ id: string; folder?: { id: string } }>;
        };
        const defaultFolder = data.data?.[0];
        if (defaultFolder?.folder?.id) {
            this.cmsMediaFolderId = defaultFolder.folder.id;
            return this.cmsMediaFolderId;
        }

        // Fallback: search by folder name
        const folderResponse = await apiPost(context, "search/media-folder", {
            filter: [{ type: "equals", field: "name", value: "CMS Media" }],
            limit: 1,
        });

        if (!folderResponse.ok) return null;

        const folderData = (await folderResponse.json()) as FolderResponse;
        this.cmsMediaFolderId = folderData.data?.[0]?.id ?? null;
        return this.cmsMediaFolderId;
    }

    /**
     * Upload a pre-cached CMS image to Shopware's CMS Media folder.
     * Images must be pre-generated during blueprint hydration.
     * Returns the Shopware media ID or null if not cached / upload fails.
     */
    protected async generateAndUploadCmsImage(
        context: PostProcessorContext,
        imageKey: string
    ): Promise<string | null> {
        const base64 = context.cache.images.loadImageForSalesChannel(
            context.salesChannelName,
            imageKey,
            "cms_media"
        );

        if (!base64) {
            logger.warn(`CMS image "${imageKey}" not in cache (run blueprint hydrate first)`);
            return null;
        }

        // Upload to Shopware
        const folderId = await this.getCmsMediaFolderId(context);
        const mediaId = generateUUID();
        const imageBuffer = Buffer.from(base64, "base64");
        const format = detectImageFormat(imageBuffer);
        const fileName = `cms-${context.salesChannelName}-${imageKey}`;

        // Create media entity
        const createResponse = await apiPost(context, "_action/sync", {
            createMedia: {
                entity: "media",
                action: "upsert",
                payload: [{ id: mediaId, mediaFolderId: folderId }],
            },
        });

        if (!createResponse.ok) {
            logger.warn(`Failed to create CMS media entity for ${imageKey}`);
            return null;
        }

        // Upload binary
        const uploadResponse = await uploadImageWithRetry(
            context,
            mediaId,
            fileName,
            imageBuffer,
            format
        );

        if (!uploadResponse.ok) {
            logger.warn(`Failed to upload CMS image for ${imageKey}`);
            return null;
        }

        return mediaId;
    }

    /**
     * Get or create a CMS media entity (idempotent - checks Shopware first, then uploads from cache)
     */
    protected async getOrCreateCmsMedia(
        context: PostProcessorContext,
        imageKey: string
    ): Promise<string | null> {
        const fileName = `cms-${context.salesChannelName}-${imageKey}`;

        interface MediaResponse {
            data?: Array<{ id: string }>;
        }

        const searchResponse = await apiPost(context, "search/media", {
            filter: [{ type: "contains", field: "fileName", value: fileName }],
            limit: 1,
        });

        if (searchResponse.ok) {
            const data = (await searchResponse.json()) as MediaResponse;
            if (data.data?.[0]?.id) return data.data[0].id;
        }

        return this.generateAndUploadCmsImage(context, imageKey);
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
            return await context.api.deleteEntity(entityType, entityId);
        } catch (error) {
            logger.warn(`Failed to delete ${entityType}/${entityId}`, { data: error });
            return false;
        }
    }
}
