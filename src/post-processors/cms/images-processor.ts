/**
 * Images Elements Processor - Creates the Images demo page
 *
 * Fetches media from products in the SalesChannel to populate
 * image-slider and image-gallery blocks with real images.
 */

import type { CmsPageFixture } from "../../fixtures/index.js";
import { IMAGES_ELEMENTS_PAGE } from "../../fixtures/index.js";
import { apiPost, logger } from "../../utils/index.js";
import type { PostProcessorContext, PostProcessorResult } from "../index.js";

import { BaseCmsProcessor } from "./base-processor.js";

class ImagesProcessorImpl extends BaseCmsProcessor {
    readonly name = "cms-images";
    readonly description = "Create Image Elements demo page (image, gallery, slider)";
    readonly pageFixture = IMAGES_ELEMENTS_PAGE;

    /**
     * Override process to populate media IDs before creating the page
     */
    override async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { options } = context;
        const errors: string[] = [];
        const cmsPageName = this.getCmsPageName(context);
        const landingPageName = this.getLandingPageName(context);

        if (options.dryRun) {
            logger.cli(`    [DRY RUN] Would create CMS layout "${this.pageFixture.name}"`);
            logger.cli(`    [DRY RUN] Would create Landing Page "${this.pageFixture.name}"`);
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
                logger.cli(`    ⚠ No media found in SalesChannel, image blocks will be empty`);
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
                logger.cli(
                    `    ✓ Created CMS layout "${this.pageFixture.name}" with ${mediaIds.length} images`
                );
            } else {
                logger.cli(`    ⊘ CMS layout "${this.pageFixture.name}" already exists`);
            }

            // Step 2: Check if Landing Page already exists for this SalesChannel
            let landingPageId = await this.findLandingPageByName(context, landingPageName);

            if (!landingPageId) {
                landingPageId = await this.createLandingPage(context, landingPageName, cmsPageId);
                if (!landingPageId) {
                    errors.push(`Failed to create Landing Page "${landingPageName}"`);
                    return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
                }
                logger.cli(`    ✓ Created Landing Page "${this.pageFixture.name}"`);
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

        // First, try to get media from products
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
                limit: 10,
            });

            if (response.ok) {
                const data = (await response.json()) as ProductResponse;

                for (const product of data.data || []) {
                    // Get cover media ID (product_media.media.id or product_media.mediaId)
                    const coverMediaId = product.cover?.media?.id || product.cover?.mediaId;
                    if (coverMediaId && !mediaIds.includes(coverMediaId)) {
                        mediaIds.push(coverMediaId);
                    }

                    // Get additional media IDs from product_media entries
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
            logger.warn("Failed to get product media for images page", { error });
        }

        // If we don't have enough media, query the media endpoint directly
        if (mediaIds.length < 5) {
            try {
                interface MediaResponse {
                    data?: Array<{ id: string }>;
                }

                const response = await apiPost(context, "search/media", {
                    filter: [{ type: "contains", field: "mimeType", value: "image/" }],
                    limit: 10,
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
                logger.warn("Failed to get media from media endpoint", { error });
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

        for (const section of cloned.sections) {
            for (const block of section.blocks) {
                for (const slot of block.slots) {
                    // Image slider slot
                    if (slot.type === "image-slider" && slot.config.sliderItems) {
                        const sliderItems = mediaIds.slice(0, 5).map((mediaId) => ({
                            mediaId,
                            url: null,
                            newTab: false,
                        }));
                        slot.config.sliderItems = { source: "static", value: sliderItems };
                    }

                    // Image gallery slot
                    if (slot.type === "image-gallery" && slot.config.sliderItems) {
                        const sliderItems = mediaIds.slice(0, 6).map((mediaId) => ({
                            mediaId,
                            url: null,
                            newTab: false,
                        }));
                        slot.config.sliderItems = { source: "static", value: sliderItems };
                    }
                }
            }
        }

        return cloned;
    }
}

export const ImagesProcessor = new ImagesProcessorImpl();
