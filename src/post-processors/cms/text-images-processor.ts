/**
 * Text & Images Elements Processor - Creates the Text & Images demo page
 *
 * Generates AI images matching the store's topic for combined text/image blocks:
 * image-text, center-text, image-text-bubble, text-on-image.
 */

import type { CmsBlockConfig, CmsPageFixture } from "../../fixtures/index.js";
import type { PostProcessorContext, PostProcessorResult } from "../index.js";

import { TEXT_IMAGES_ELEMENTS_PAGE } from "../../fixtures/index.js";
import { cloneDeep } from "../../utils/index.js";
import { BaseCmsProcessor, fixtureBlocks } from "./base-processor.js";

/** Cached CMS image keys used by this page */
const TEXT_IMAGE_KEYS = [
    "ti-left",
    "ti-right",
    "ct-left",
    "ct-right",
    "bubble-left",
    "bubble-center",
    "bubble-right",
    "toi-bg",
];

/** Background image of the text-on-image block */
const TEXT_ON_IMAGE_BACKGROUND_KEY = "toi-bg";

/** Block position → (image slot name → image key) */
const SLOT_IMAGE_KEYS = new Map<number, Map<string, string>>([
    [1, new Map([["left", "ti-left"]])],
    [2, new Map([["right", "ti-right"]])],
    [
        3,
        new Map([
            ["left", "ct-left"],
            ["right", "ct-right"],
        ]),
    ],
    [
        4,
        new Map([
            ["left-image", "bubble-left"],
            ["center-image", "bubble-center"],
            ["right-image", "bubble-right"],
        ]),
    ],
]);

type ImageMap = Record<string, string | null>;

/** Set the media of the block's image slots that have an image for their slot name */
function assignBlockImages(block: CmsBlockConfig, imageMap: ImageMap): void {
    const slotKeys = SLOT_IMAGE_KEYS.get(block.position);
    if (!slotKeys) return;

    block.slots
        .filter((slot) => slot.type === "image" && slot.config.media)
        .forEach((slot) => {
            const key = slotKeys.get(slot.slot);
            const mediaId = key ? imageMap[key] : null;
            if (!mediaId) return;
            slot.config.media = { source: "static", value: mediaId };
        });
}

class TextImagesProcessorImpl extends BaseCmsProcessor {
    readonly name = "cms-text-images";
    readonly description =
        "Create Text & Images demo page (image-text, center-text, bubble, text-on-image)";
    readonly pageFixture = TEXT_IMAGES_ELEMENTS_PAGE;

    override async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        if (context.options.dryRun) {
            return this.dryRunResult(this.pageFixture.name, this.pageFixture.name);
        }

        return this.processPage(context, async () => {
            const imageMap = await this.uploadCmsImages(context);

            // Apply hydrated CMS text if available, then populate media IDs
            const hydratedPage = this.getHydratedCmsPage(context);
            const textFixture = this.applyHydratedText(this.pageFixture, hydratedPage);
            const imageCount = Object.values(imageMap).filter(Boolean).length;
            return {
                fixture: this.populateMediaIds(textFixture, imageMap),
                logs: this.layoutLogs(`with ${imageCount} images`),
            };
        });
    }

    /**
     * Upload pre-cached CMS images for all text-image blocks.
     * Images are pre-generated during blueprint hydration.
     */
    private async uploadCmsImages(context: PostProcessorContext): Promise<ImageMap> {
        const images: ImageMap = {};
        for (const key of TEXT_IMAGE_KEYS) {
            images[key] = await this.getOrCreateCmsMedia(context, key);
        }
        return images;
    }

    private populateMediaIds(fixture: CmsPageFixture, imageMap: ImageMap): CmsPageFixture {
        const cloned = cloneDeep(fixture);
        const background = imageMap[TEXT_ON_IMAGE_BACKGROUND_KEY];

        fixtureBlocks(cloned).forEach((block) => {
            if (block.type === "text-on-image" && background) {
                block.backgroundMediaId = background;
            }
            assignBlockImages(block, imageMap);
        });
        return cloned;
    }
}

export const TextImagesProcessor = new TextImagesProcessorImpl();
