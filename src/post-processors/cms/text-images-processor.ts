/**
 * Text & Images Elements Processor - Creates the Text & Images demo page
 *
 * Generates AI images matching the store's topic for combined text/image blocks:
 * image-text, center-text, image-text-bubble, text-on-image.
 */

import type { CmsPageFixture } from "../../fixtures/index.js";
import type { PostProcessorContext, PostProcessorResult } from "../index.js";

import { TEXT_IMAGES_ELEMENTS_PAGE } from "../../fixtures/index.js";
import { logger } from "../../utils/index.js";
import { BaseCmsProcessor } from "./base-processor.js";

class TextImagesProcessorImpl extends BaseCmsProcessor {
    readonly name = "cms-text-images";
    readonly description =
        "Create Text & Images demo page (image-text, center-text, bubble, text-on-image)";
    readonly pageFixture = TEXT_IMAGES_ELEMENTS_PAGE;

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
            const imageMap = await this.uploadCmsImages(context);

            // Apply hydrated CMS text if available, then populate media IDs
            const hydratedPage = this.getHydratedCmsPage(context);
            const textFixture = this.applyHydratedText(this.pageFixture, hydratedPage);
            const populatedFixture = this.populateMediaIds(textFixture, imageMap);

            let cmsPageId = await this.findCmsPageByName(context, cmsPageName);

            if (!cmsPageId) {
                cmsPageId = await this.createCmsPage(context, populatedFixture, cmsPageName);
                if (!cmsPageId) {
                    errors.push(`Failed to create CMS page layout "${cmsPageName}"`);
                    return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
                }
                const imageCount = Object.values(imageMap).filter(Boolean).length;
                logger.info(
                    `    ✓ Created CMS layout "${this.pageFixture.name}" with ${imageCount} images`,
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
     * Upload pre-cached CMS images for all text-image blocks.
     * Images are pre-generated during blueprint hydration.
     */
    private async uploadCmsImages(
        context: PostProcessorContext
    ): Promise<Record<string, string | null>> {
        const keys = [
            "ti-left",
            "ti-right",
            "ct-left",
            "ct-right",
            "bubble-left",
            "bubble-center",
            "bubble-right",
            "toi-bg",
        ];

        const images: Record<string, string | null> = {};
        for (const key of keys) {
            images[key] = await this.getOrCreateCmsMedia(context, key);
        }
        return images;
    }

    private populateMediaIds(
        fixture: CmsPageFixture,
        imageMap: Record<string, string | null>
    ): CmsPageFixture {
        const cloned = JSON.parse(JSON.stringify(fixture)) as CmsPageFixture;

        // Map: block index -> slot assignments
        const slotAssignments: Record<number, Record<string, string | null>> = {
            1: { left: imageMap["ti-left"] ?? null },
            2: { right: imageMap["ti-right"] ?? null },
            3: {
                left: imageMap["ct-left"] ?? null,
                right: imageMap["ct-right"] ?? null,
            },
            4: {
                "left-image": imageMap["bubble-left"] ?? null,
                "center-image": imageMap["bubble-center"] ?? null,
                "right-image": imageMap["bubble-right"] ?? null,
            },
        };

        for (const section of cloned.sections) {
            for (const block of section.blocks) {
                // text-on-image background
                if (block.type === "text-on-image" && imageMap["toi-bg"]) {
                    block.backgroundMediaId = imageMap["toi-bg"];
                }

                const assignments = slotAssignments[block.position];
                if (!assignments) continue;

                for (const slot of block.slots) {
                    if (slot.type !== "image") continue;
                    const mediaId = assignments[slot.slot];
                    if (mediaId && slot.config.media) {
                        slot.config.media = { source: "static", value: mediaId };
                    }
                }
            }
        }

        return cloned;
    }
}

export const TextImagesProcessor = new TextImagesProcessorImpl();
