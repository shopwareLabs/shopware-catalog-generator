/**
 * Text & Images Elements Processor - Creates the Text & Images demo page
 *
 * Fetches media from products in the SalesChannel to populate
 * image slots in combined text/image blocks.
 */

import type { CmsPageFixture } from "../../fixtures/index.js";
import type { PostProcessorContext, PostProcessorResult } from "../index.js";

import { TEXT_IMAGES_ELEMENTS_PAGE } from "../../fixtures/index.js";
import { apiPost, logger } from "../../utils/index.js";

import { BaseCmsProcessor } from "./base-processor.js";

class TextImagesProcessorImpl extends BaseCmsProcessor {
    readonly name = "cms-text-images";
    readonly description =
        "Create Text & Images demo page (image-text, center-text, bubble, text-on-image)";
    readonly pageFixture = TEXT_IMAGES_ELEMENTS_PAGE;

    /**
     * Override process to populate media IDs before creating the page
     */
    override async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { options } = context;
        const errors: string[] = [];
        const cmsPageName = this.getCmsPageName(context);
        const landingPageName = this.getLandingPageName(context);

        if (options.dryRun) {
            logger.info(`    [DRY RUN] Would create CMS layout "${this.pageFixture.name}"`, {
                cli: true,
            });
            logger.info(`    [DRY RUN] Would create Landing Page "${this.pageFixture.name}"`, {
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
            // Get media IDs from products in this SalesChannel
            const mediaIds = await this.getMediaIds(context);
            if (mediaIds.length === 0) {
                logger.warn(
                    `    ⚠ No media found in SalesChannel, image blocks will be empty`,
                    { cli: true }
                );
            }

            // Create a modified fixture with media IDs populated
            const populatedFixture = this.populateMediaIds(this.pageFixture, mediaIds);

            // Step 1: Check if CMS page already exists for this SalesChannel
            let cmsPageId = await this.findCmsPageByName(context, cmsPageName);

            if (!cmsPageId) {
                cmsPageId = await this.createCmsPage(context, populatedFixture, cmsPageName);
                if (!cmsPageId) {
                    errors.push(`Failed to create CMS page layout "${cmsPageName}"`);
                    return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
                }
                logger.info(
                    `    ✓ Created CMS layout "${this.pageFixture.name}" with ${mediaIds.length} images`,
                    { cli: true }
                );
            } else {
                logger.info(`    ⊘ CMS layout "${this.pageFixture.name}" already exists`, {
                    cli: true,
                });
            }

            // Step 2: Check if Landing Page already exists for this SalesChannel
            let landingPageId = await this.findLandingPageByName(context, landingPageName);

            if (!landingPageId) {
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
     * Get media IDs from products in the SalesChannel
     */
    private async getMediaIds(context: PostProcessorContext): Promise<string[]> {
        const mediaIds: string[] = [];

        try {
            interface ProductResponse {
                data?: Array<{
                    id: string;
                    coverId?: string;
                    cover?: { id?: string; mediaId?: string; media?: { id?: string } };
                    media?: Array<{ id?: string; mediaId?: string; media?: { id?: string } }>;
                }>;
            }

            const response = await apiPost(context, "search/product", {
                filter: [
                    {
                        type: "equals",
                        field: "visibilities.salesChannelId",
                        value: context.salesChannelId,
                    },
                ],
                associations: {
                    cover: { associations: { media: {} } },
                    media: { associations: { media: {} } },
                },
                limit: 15,
            });

            if (response.ok) {
                const data = (await response.json()) as ProductResponse;

                for (const product of data.data || []) {
                    // Get cover media ID
                    const coverMediaId = product.cover?.media?.id || product.cover?.mediaId;
                    if (coverMediaId && !mediaIds.includes(coverMediaId)) {
                        mediaIds.push(coverMediaId);
                    }

                    // Get additional media IDs
                    if (product.media) {
                        for (const pm of product.media) {
                            const mediaId = pm.media?.id || pm.mediaId;
                            if (mediaId && !mediaIds.includes(mediaId)) {
                                mediaIds.push(mediaId);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            logger.warn("Failed to get product media for text-images page", { data: error });
        }

        // Fallback to media endpoint if we don't have enough
        if (mediaIds.length < 8) {
            try {
                interface MediaResponse {
                    data?: Array<{ id: string }>;
                }

                const response = await apiPost(context, "search/media", {
                    filter: [{ type: "contains", field: "mimeType", value: "image/" }],
                    limit: 15,
                });

                if (response.ok) {
                    const data = (await response.json()) as MediaResponse;
                    for (const media of data.data || []) {
                        if (!mediaIds.includes(media.id)) {
                            mediaIds.push(media.id);
                        }
                    }
                }
            } catch (error) {
                logger.warn("Failed to get media from media endpoint", { data: error });
            }
        }

        return mediaIds;
    }

    /**
     * Populate media IDs in the fixture
     */
    private populateMediaIds(fixture: CmsPageFixture, mediaIds: string[]): CmsPageFixture {
        if (mediaIds.length === 0) {
            return fixture;
        }

        // Deep clone the fixture
        const cloned = JSON.parse(JSON.stringify(fixture)) as CmsPageFixture;
        let mediaIndex = 0;

        const getNextMediaId = (): string | null => {
            if (mediaIndex >= mediaIds.length) {
                mediaIndex = 0; // Wrap around if we run out
            }
            return mediaIds[mediaIndex++] || null;
        };

        for (const section of cloned.sections) {
            for (const block of section.blocks) {
                // Handle text-on-image block (needs backgroundMediaId)
                if (block.type === "text-on-image") {
                    block.backgroundMediaId = getNextMediaId() || undefined;
                }

                // Handle image slots in regular blocks
                for (const slot of block.slots) {
                    if (slot.type === "image" && slot.config.media) {
                        slot.config.media = { source: "static", value: getNextMediaId() };
                    }
                }
            }
        }

        return cloned;
    }
}

export const TextImagesProcessor = new TextImagesProcessorImpl();
