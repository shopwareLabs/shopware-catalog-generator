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
import { BaseCmsProcessor, fixtureSlots, toSliderItems } from "./base-processor.js";

const SLIDER_IMAGE_COUNT = 5;
const GALLERY_IMAGE_COUNT = 6;

class ImagesProcessorImpl extends BaseCmsProcessor {
    readonly name = "cms-images";
    readonly description = "Create Image Elements demo page (image, gallery, slider)";
    readonly pageFixture = IMAGES_ELEMENTS_PAGE;

    override async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        if (context.options.dryRun) {
            return this.dryRunResult(this.pageFixture.name, this.pageFixture.name);
        }

        return this.processPage(context, async () => {
            const mediaIds = await this.uploadCmsImages(context);
            if (mediaIds.length === 0) {
                logger.warn(`    ⚠ No CMS images generated, image blocks will be empty`, {
                    cli: true,
                });
            }

            // Apply hydrated CMS text if available, then populate media IDs
            const hydratedPage = this.getHydratedCmsPage(context);
            const textFixture = this.applyHydratedText(this.pageFixture, hydratedPage);
            return {
                fixture: this.populateMediaIds(textFixture, mediaIds),
                logs: this.layoutLogs(`with ${mediaIds.length} images`),
            };
        });
    }

    /**
     * Upload pre-cached CMS images for slider and gallery blocks.
     * Images are pre-generated during blueprint hydration.
     */
    private async uploadCmsImages(context: PostProcessorContext): Promise<string[]> {
        const keys = [
            ...Array.from({ length: SLIDER_IMAGE_COUNT }, (_, i) => `img-slider-${i}`),
            ...Array.from({ length: GALLERY_IMAGE_COUNT }, (_, i) => `img-gallery-${i}`),
        ];

        const mediaIds: string[] = [];
        for (const key of keys) {
            const id = await this.getOrCreateCmsMedia(context, key);
            if (id) mediaIds.push(id);
        }
        return mediaIds;
    }

    /** Slider slots get the first images, gallery slots the next ones */
    private populateMediaIds(fixture: CmsPageFixture, mediaIds: string[]): CmsPageFixture {
        if (mediaIds.length === 0) return fixture;

        const galleryEnd = SLIDER_IMAGE_COUNT + GALLERY_IMAGE_COUNT;
        const mediaIdsBySlotType = new Map<string, string[]>([
            ["image-slider", mediaIds.slice(0, SLIDER_IMAGE_COUNT)],
            ["image-gallery", mediaIds.slice(SLIDER_IMAGE_COUNT, galleryEnd)],
        ]);

        const cloned = cloneDeep(fixture);
        fixtureSlots(cloned).forEach((slot) => {
            const slotMediaIds = mediaIdsBySlotType.get(slot.type);
            if (!slotMediaIds || !slot.config.sliderItems) return;
            slot.config.sliderItems = { source: "static", value: toSliderItems(slotMediaIds) };
        });
        return cloned;
    }
}

export const ImagesProcessor = new ImagesProcessorImpl();
