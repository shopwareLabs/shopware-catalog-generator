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

import {
    DEMO_CUSTOMERS,
    DEMO_PASSWORD,
    HOME_LISTING_PAGE,
    PROMOTIONS,
} from "../../fixtures/index.js";
import { getSalesChannelNavigationCategoryId } from "../../shopware/api-helpers.js";
import {
    apiPost,
    capitalizeString,
    cloneDeep,
    countCategories,
    logger,
} from "../../utils/index.js";
import { BaseCmsProcessor } from "./base-processor.js";

function buildIntroHtml(
    displayName: string,
    description: string,
    productCount: number,
    categoryCount: number
): string {
    return [
        `<h2>Welcome to the ${displayName} Demo-Store!</h2>`,
        `<p>This store was generated with the&nbsp;`,
        `<a target="_blank" href="https://github.com/shopwareLabs/shopware-catalog-generator" rel="noopener">shopware-catalog-generator</a>.`,
        `<br>The prompt to <b>generate</b> this store was:</p>`,
        `<blockquote>${description}</blockquote>`,
        `<p>It includes ${productCount} Products and ${categoryCount} Categories.</p>`,
    ].join("");
}

export interface HomeFeatures {
    includeCredentials: boolean;
    includePromotions: boolean;
    includeCrossSelling: boolean;
}

function buildFeaturesHtml(features: HomeFeatures): string {
    const items = [
        `<li>Simple Products,&nbsp;Variant Products and&nbsp;Digital Product</li>`,
        ...(features.includeCrossSelling
            ? [`<li>Products have Properties, Images and Cross-Selling</li>`]
            : [`<li>Products have Properties and Images</li>`]),
        ...(features.includeCredentials
            ? [`<li>Demo Customer Accounts with B2B Customer Group</li>`]
            : []),
        ...(features.includePromotions
            ? [`<li>Promotion Codes and Tiered Quantity Pricing</li>`]
            : []),
        `<li>CMS-Pages and all CMS-Elements for Testing</li>`,
        `<li>Both default Category-Layouts with Pagination</li>`,
    ];
    return [
        `<h4>Supported Features:</h4>`,
        `<ul>`,
        ...items,
        `</ul>`,
        `<p>The linked <a target="_blank" href="https://github.com/shopwareLabs/shopware-catalog-templates" rel="noopener">catalog templates</a> provide reusable setups for different store types. `,
        `See the <a target="_blank" href="https://github.com/shopwareLabs/shopware-catalog-generator#readme" rel="noopener">README</a> for technical details.</p>`,
    ].join("");
}

function buildCredentialsHtml(): string {
    const cellStyle = `style="padding: 4px 16px 4px 0"`;
    const headerStyle = `style="padding: 4px 16px 4px 0; text-align: left"`;

    const rows = DEMO_CUSTOMERS.map((c) => {
        const groupLabel = c.group === "b2b" ? "B2B (net prices)" : "Standard";
        return `<tr><td ${cellStyle}>${c.email}</td><td ${cellStyle}>${DEMO_PASSWORD}</td><td ${cellStyle}>${groupLabel}</td></tr>`;
    });

    return [
        `<h4>Demo Accounts</h4>`,
        `<table style="border-collapse: collapse; margin-bottom: 1em"><thead>`,
        `<tr><th ${headerStyle}>Email</th><th ${headerStyle}>Password</th><th ${headerStyle}>Group</th></tr>`,
        `</thead><tbody>`,
        ...rows,
        `</tbody></table>`,
    ].join("");
}

function buildPromotionCodesHtml(): string {
    const cellStyle = `style="padding: 4px 16px 4px 0"`;
    const headerStyle = `style="padding: 4px 16px 4px 0; text-align: left"`;

    const rows = PROMOTIONS.map((p) => {
        const description =
            p.scope === "delivery"
                ? "Free Shipping"
                : p.discountType === "percentage"
                  ? `${p.discountValue}% off${p.maxValue ? ` (max $${p.maxValue})` : ""}`
                  : `$${p.discountValue} off`;

        return `<tr><td ${cellStyle}><code>${p.code}</code></td><td ${cellStyle}>${description}</td></tr>`;
    });

    return [
        `<h4>Promotion Codes</h4>`,
        `<table style="border-collapse: collapse; margin-bottom: 1em"><thead>`,
        `<tr><th ${headerStyle}>Code</th><th ${headerStyle}>Discount</th></tr>`,
        `</thead><tbody>`,
        ...rows,
        `</tbody></table>`,
    ].join("");
}

/**
 * Build the hero section text: intro, features, and links.
 *
 * Exported for testing.
 */
export function buildHeroText(
    storeName: string,
    description: string,
    productCount: number,
    categoryCount: number,
    features: HomeFeatures = {
        includeCredentials: true,
        includePromotions: true,
        includeCrossSelling: true,
    }
): string {
    const displayName = capitalizeString(storeName);
    return [
        buildIntroHtml(displayName, description, productCount, categoryCount),
        buildFeaturesHtml(features),
    ].join("");
}

/**
 * Build the reference section: credentials + promotion codes side-by-side, plus closing.
 * Only includes sections for processors that are active in the current run.
 *
 * Exported for testing.
 */
export function buildReferenceText(
    storeName: string,
    features: HomeFeatures = {
        includeCredentials: true,
        includePromotions: true,
        includeCrossSelling: true,
    }
): string {
    const parts: string[] = [];

    if (features.includeCredentials || features.includePromotions) {
        const cells: string[] = [];
        if (features.includeCredentials) {
            cells.push(
                `<td style="vertical-align: top; padding-right: 3em">${buildCredentialsHtml()}</td>`
            );
        }
        if (features.includePromotions) {
            cells.push(`<td style="vertical-align: top">${buildPromotionCodesHtml()}</td>`);
        }
        parts.push(`<table style="border-collapse: collapse"><tr>${cells.join("")}</tr></table>`);
    }

    parts.push(`<p>Enjoy this <b>${storeName.toLowerCase()}</b> demo-store.&nbsp;\u{1F607}</p>`);
    return parts.join("");
}

const HOME_HERO_IMAGE_KEY = "home-hero";

class HomeProcessorImpl extends BaseCmsProcessor implements PostProcessor {
    readonly name = "cms-home";
    readonly description = "Create homepage layout with welcome text and product listing";
    readonly pageFixture = HOME_LISTING_PAGE;
    override readonly dependsOn: string[] = ["customers", "promotions", "cross-selling"];

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
        const cloned = cloneDeep(this.pageFixture);
        const { salesChannel } = context.blueprint;
        const productCount = context.blueprint.products.length;
        const categoryCount = countCategories(context.blueprint.categories);
        const active = context.options.activeProcessors ?? [];
        const features: HomeFeatures = {
            includeCredentials: active.includes("customers"),
            includePromotions: active.includes("promotions"),
            includeCrossSelling: active.includes("cross-selling"),
        };

        // Section 0: Hero teaser (image + intro/features)
        const teaserBlock = cloned.sections[0]?.blocks[0];
        if (teaserBlock) {
            const imageSlot = teaserBlock.slots.find((s) => s.type === "image");
            if (imageSlot) {
                const mediaId = await this.uploadHeroImage(context);
                if (mediaId) {
                    imageSlot.config.media = { source: "static", value: mediaId };
                }
            }

            const heroSlot = teaserBlock.slots.find((s) => s.type === "text");
            if (heroSlot) {
                heroSlot.config.content = {
                    source: "static",
                    value: buildHeroText(
                        salesChannel.name,
                        salesChannel.description,
                        productCount,
                        categoryCount,
                        features
                    ),
                };
            }
        }

        // Section 1: Reference info (credentials + promotions side-by-side)
        const referenceSlot = cloned.sections[1]?.blocks[0]?.slots[0];
        if (referenceSlot) {
            referenceSlot.config.content = {
                source: "static",
                value: buildReferenceText(salesChannel.name, features),
            };
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
