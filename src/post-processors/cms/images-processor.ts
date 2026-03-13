/**
 * Images Elements Processor - Creates the Images demo page
 *
 * Generates AI images matching the store's topic for
 * image-slider and image-gallery blocks.
 */

import type { CmsPageFixture } from "../../fixtures/index.js";
import type { PostProcessorContext, PostProcessorResult } from "../index.js";

import { IMAGES_ELEMENTS_PAGE } from "../../fixtures/index.js";
import { cloneDeep, logger } from "../../utils/index.js";
import { BaseCmsProcessor } from "./base-processor.js";

class ImagesProcessorImpl extends BaseCmsProcessor {
    readonly name = "cms-images";
    readonly description = "Create Image Elements demo page (image, gallery, slider)";
    readonly pageFixture = IMAGES_ELEMENTS_PAGE;

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
            const mediaIds = await this.uploadCmsImages(context);

            if (mediaIds.length === 0) {
                logger.warn(`    ⚠ No CMS images generated, image blocks will be empty`, {
                    cli: true,
                });
            }

            // Apply hydrated CMS text if available, then populate media IDs
            const hydratedPage = this.getHydratedCmsPage(context);
            const textFixture = this.applyHydratedText(this.pageFixture, hydratedPage);
            const populatedFixture = this.populateMediaIds(textFixture, mediaIds);

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
     * Upload pre-cached CMS images for slider and gallery blocks.
     * Images are pre-generated during blueprint hydration.
     */
    private async uploadCmsImages(context: PostProcessorContext): Promise<string[]> {
        const mediaIds: string[] = [];

        for (let i = 0; i < 5; i++) {
            const id = await this.getOrCreateCmsMedia(context, `img-slider-${i}`);
            if (id) mediaIds.push(id);
        }

        for (let i = 0; i < 6; i++) {
            const id = await this.getOrCreateCmsMedia(context, `img-gallery-${i}`);
            if (id) mediaIds.push(id);
        }

        return mediaIds;
    }

    private populateMediaIds(fixture: CmsPageFixture, mediaIds: string[]): CmsPageFixture {
        if (mediaIds.length === 0) return fixture;

        const cloned = cloneDeep(fixture);
        const sliderMediaIds = mediaIds.slice(0, 5);
        const galleryMediaIds = mediaIds.slice(5, 11);

        for (const section of cloned.sections) {
            for (const block of section.blocks) {
                for (const slot of block.slots) {
                    if (slot.type === "image-slider" && slot.config.sliderItems) {
                        slot.config.sliderItems = {
                            source: "static",
                            value: sliderMediaIds.map((mediaId) => ({
                                mediaId,
                                url: null,
                                newTab: false,
                            })),
                        };
                    }

                    if (slot.type === "image-gallery" && slot.config.sliderItems) {
                        slot.config.sliderItems = {
                            source: "static",
                            value: galleryMediaIds.map((mediaId) => ({
                                mediaId,
                                url: null,
                                newTab: false,
                            })),
                        };
                    }
                }
            }
        }

        return cloned;
    }
}

export const ImagesProcessor = new ImagesProcessorImpl();
