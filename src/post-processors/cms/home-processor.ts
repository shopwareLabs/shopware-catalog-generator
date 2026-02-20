/**
 * Home Processor - Creates the homepage CMS layout for the root category
 *
 * Unlike other CMS processors, this creates a product_list page (not a landing page)
 * and assigns it directly to the root category via cmsPageId. The text content is
 * template-based with dynamic values from the blueprint (no AI hydration needed).
 *
 * The hero image is pre-generated during blueprint hydration (not in the post-processor)
 * via preGenerateHomeHeroImage(). The post-processor reads from cache and only uploads.
 */

import type { CmsPageFixture } from "../../fixtures/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "../index.js";

import { HOME_LISTING_PAGE } from "../../fixtures/index.js";
import { getSalesChannelNavigationCategoryId } from "../../shopware/api-helpers.js";
import { apiPost, capitalizeString, countCategories, logger } from "../../utils/index.js";
import { BaseCmsProcessor } from "./base-processor.js";

/**
 * Build the homepage welcome text with dynamic store data.
 *
 * Exported for testing.
 */
export function buildHomePageText(
    storeName: string,
    description: string,
    productCount: number,
    categoryCount: number
): string {
    const displayName = capitalizeString(storeName);
    return [
        `<h2>Welcome to the ${displayName} Demo-Store!</h2>`,
        `<p>This store was generated with the&nbsp;`,
        `<a target="_blank" href="https://github.com/shopwareLabs/shopware-catalog-generator" rel="noopener">shopware-catalog-generator</a>.&nbsp;</p>`,
        `<p>The prompt to <b>generate</b> this store was:</p>`,
        `<blockquote>${description}</blockquote>`,
        `<p>It includes ${productCount} Products and ${categoryCount} Categories.</p>`,
        `<h4>Supported Features:</h4>`,
        `<ul>`,
        `<li>Simple Products,&nbsp;Variant Products and&nbsp;Digital Product</li>`,
        `<li>Product have Properties and multiple different Images</li>`,
        `<li>CMS-Pages and all CMS-Elements for Testing</li>`,
        `<li>Both default Category-Layouts with Pagination</li>`,
        `</ul>`,
        `<p>We have different reusable templates you can find here:<br>`,
        `<a target="_blank" href="https://github.com/shopwareLabs/shopware-catalog-templates" rel="noopener">shopware-catalog-templates</a></p>`,
        `<p>All the technical details can be found in the README.</p>`,
        `<p>Enjoy this ${storeName.toLowerCase()} demo-store.&nbsp;\u{1F607}</p>`,
    ].join("");
}

const HOME_HERO_IMAGE_KEY = "home-hero";

class HomeProcessorImpl extends BaseCmsProcessor implements PostProcessor {
    readonly name = "cms-home";
    readonly description = "Create homepage layout with welcome text and product listing";
    readonly pageFixture = HOME_LISTING_PAGE;
    override readonly dependsOn: string[] = [];

    override async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { options } = context;
        const errors: string[] = [];
        const cmsPageName = this.getCmsPageName(context);

        if (options.dryRun) {
            logger.info(`    [DRY RUN] Would create homepage CMS layout "${cmsPageName}"`, {
                cli: true,
            });
            logger.info(`    [DRY RUN] Would assign CMS page to root category`, { cli: true });
            return { name: this.name, processed: 1, skipped: 0, errors: [], durationMs: 0 };
        }

        try {
            const rootCategoryId = await this.getRootCategoryId(context);
            if (!rootCategoryId) {
                errors.push("Could not find root category for SalesChannel");
                return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
            }

            // Check if CMS page already exists
            let cmsPageId = await this.findCmsPageByName(context, cmsPageName);

            if (!cmsPageId) {
                const populatedFixture = await this.buildPopulatedFixture(context);
                cmsPageId = await this.createCmsPage(context, populatedFixture, cmsPageName);
                if (!cmsPageId) {
                    errors.push(`Failed to create homepage CMS layout "${cmsPageName}"`);
                    return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
                }
                logger.info(`    ✓ Created homepage CMS layout`, { cli: true });
            } else {
                logger.info(`    ⊘ Homepage CMS layout already exists`, { cli: true });
            }

            // Always ensure root category has the CMS page assigned
            const assigned = await this.assignCmsPageToCategory(context, rootCategoryId, cmsPageId);
            if (!assigned) {
                errors.push("Failed to assign CMS page to root category");
            } else {
                logger.info(`    ✓ Assigned homepage to root category`, { cli: true });
            }
        } catch (error) {
            errors.push(
                `Home processor failed: ${error instanceof Error ? error.message : String(error)}`
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

    override async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        const cmsPageName = this.getCmsPageName(context);

        if (context.options.dryRun) {
            logger.info(`    [DRY RUN] Would delete homepage CMS layout`, { cli: true });
            logger.info(`    [DRY RUN] Would remove CMS page from root category`, { cli: true });
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        let deleted = 0;
        const errors: string[] = [];

        try {
            // Remove cmsPageId from root category
            const rootCategoryId = await this.getRootCategoryId(context);
            if (rootCategoryId) {
                await this.assignCmsPageToCategory(context, rootCategoryId, null);
                logger.info(`    ✓ Removed CMS page from root category`, { cli: true });
            }

            // Delete the CMS page
            const cmsPageId = await this.findCmsPageByName(context, cmsPageName);
            if (cmsPageId) {
                const success = await this.deleteEntity(context, "cms-page", cmsPageId);
                if (success) {
                    logger.info(`    ✓ Deleted homepage CMS layout`, { cli: true });
                    deleted++;
                } else {
                    errors.push(`Failed to delete homepage CMS page "${cmsPageName}"`);
                }
            } else {
                logger.info(`    ⊘ Homepage CMS layout not found, skipping`, { cli: true });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`Home cleanup failed: ${message}`);
            logger.error(`    ✗ ${message}`, { cli: true });
        }

        return { name: this.name, deleted, errors, durationMs: 0 };
    }

    // =========================================================================
    // Fixture Population
    // =========================================================================

    /**
     * Build the fixture with dynamic text and hero image populated.
     */
    private async buildPopulatedFixture(context: PostProcessorContext): Promise<CmsPageFixture> {
        const cloned = JSON.parse(JSON.stringify(this.pageFixture)) as CmsPageFixture;
        const teaserBlock = cloned.sections[0]?.blocks[0];
        if (!teaserBlock) return cloned;

        // Populate hero image (left slot) - image should be pre-cached from hydration
        const imageSlot = teaserBlock.slots.find((s) => s.type === "image");
        if (imageSlot) {
            const mediaId = await this.uploadHeroImage(context);
            if (mediaId) {
                imageSlot.config.media = { source: "static", value: mediaId };
            }
        }

        // Populate welcome text (right slot)
        const textSlot = teaserBlock.slots.find((s) => s.type === "text");
        if (textSlot) {
            const { salesChannel } = context.blueprint;
            const productCount = context.blueprint.products.length;
            const categoryCount = countCategories(context.blueprint.categories);
            const html = buildHomePageText(
                salesChannel.name,
                salesChannel.description,
                productCount,
                categoryCount
            );
            textSlot.config.content = { source: "static", value: html };
        }

        return cloned;
    }

    /**
     * Upload the pre-generated hero image to Shopware.
     * Image must be in local cache from blueprint hydration.
     */
    private async uploadHeroImage(context: PostProcessorContext): Promise<string | null> {
        return this.getOrCreateCmsMedia(context, HOME_HERO_IMAGE_KEY);
    }

    // =========================================================================
    // Category Operations
    // =========================================================================

    private async getRootCategoryId(context: PostProcessorContext): Promise<string | null> {
        return getSalesChannelNavigationCategoryId(context);
    }

    /**
     * Assign (or remove) a CMS page on a category.
     * Pass null to remove the assignment.
     */
    private async assignCmsPageToCategory(
        context: PostProcessorContext,
        categoryId: string,
        cmsPageId: string | null
    ): Promise<boolean> {
        const response = await apiPost(context, "_action/sync", {
            assignCmsPage: {
                entity: "category",
                action: "upsert",
                payload: [{ id: categoryId, cmsPageId }],
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.apiError("_action/sync (assign CMS page to category)", response.status, {
                error: errorText,
            });
            return false;
        }

        return true;
    }
}

export const HomeProcessor = new HomeProcessorImpl();
