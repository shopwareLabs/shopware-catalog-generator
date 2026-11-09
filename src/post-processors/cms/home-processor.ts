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

import type { CmsPageFixture, PromotionDefinition } from "../../fixtures/index.js";
import type { HydratedBlueprint } from "../../types/index.js";
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
    localizedFixtureText,
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

/** Fixture texts of one language (English when null) */
type Texts = Readonly<Record<string, string>> | null;

const GENERATOR_URL = "https://github.com/shopwareLabs/shopware-catalog-generator";
const TEMPLATES_URL = "https://github.com/shopwareLabs/shopware-catalog-templates";
const README_URL = "https://github.com/shopwareLabs/shopware-catalog-generator#readme";

export interface HomeFeatures {
    includeCredentials: boolean;
    includePromotions: boolean;
    includeCrossSelling: boolean;
}

const ALL_FEATURES: HomeFeatures = {
    includeCredentials: true,
    includePromotions: true,
    includeCrossSelling: true,
};

const CELL_STYLE = `style="padding: 4px 16px 4px 0"`;
const HEADER_STYLE = `style="padding: 4px 16px 4px 0; text-align: left"`;

/** Slot keys ("<section>.<block>.<slot>") of the two homepage text slots, see HOME_LISTING_PAGE */
const HOME_HERO_SLOT_KEY = "0.0.right";
const HOME_REFERENCE_SLOT_KEY = "1.0.content";

function buildIntroHtml(
    displayName: string,
    description: string,
    productCount: number,
    categoryCount: number,
    texts: Texts
): string {
    const counts = localizedFixtureText("home.counts", texts, {
        productCount: String(productCount),
        categoryCount: String(categoryCount),
    });
    return [
        `<h2>${localizedFixtureText("home.welcome", texts, { name: displayName })}</h2>`,
        `<p>${localizedFixtureText("home.generatedWith", texts, { generatorUrl: GENERATOR_URL })}</p>`,
        `<blockquote>${description}</blockquote>`,
        `<p>${counts}</p>`,
    ].join("");
}

function buildFeaturesHtml(features: HomeFeatures, texts: Texts): string {
    const featureKeys = [
        "home.feature.productTypes",
        features.includeCrossSelling ? "home.feature.crossSelling" : "home.feature.properties",
        ...(features.includeCredentials ? ["home.feature.customers"] : []),
        ...(features.includePromotions ? ["home.feature.promotions"] : []),
        "home.feature.cms",
        "home.feature.layouts",
    ];
    const links = localizedFixtureText("home.links", texts, {
        templatesUrl: TEMPLATES_URL,
        readmeUrl: README_URL,
    });
    return [
        `<h4>${localizedFixtureText("home.featuresHeading", texts)}</h4>`,
        `<ul>`,
        ...featureKeys.map((key) => `<li>${localizedFixtureText(key, texts)}</li>`),
        `</ul>`,
        `<p>${links}</p>`,
    ].join("");
}

function buildTable(heading: string, columns: string[], rows: string[][]): string {
    const headerCells = columns.map((c) => `<th ${HEADER_STYLE}>${c}</th>`).join("");
    const bodyRows = rows.map(
        (cells) => `<tr>${cells.map((c) => `<td ${CELL_STYLE}>${c}</td>`).join("")}</tr>`
    );
    return [
        `<h4>${heading}</h4>`,
        `<table style="border-collapse: collapse; margin-bottom: 1em"><thead>`,
        `<tr>${headerCells}</tr>`,
        `</thead><tbody>`,
        ...bodyRows,
        `</tbody></table>`,
    ].join("");
}

function buildCredentialsHtml(texts: Texts): string {
    const t = (key: string): string => localizedFixtureText(key, texts);
    return buildTable(
        t("home.accountsHeading"),
        [t("home.column.email"), t("home.column.password"), t("home.column.group")],
        DEMO_CUSTOMERS.map((c) => [
            c.email,
            DEMO_PASSWORD,
            t(c.group === "b2b" ? "home.group.b2b" : "home.group.standard"),
        ])
    );
}

/** Discount label of a promotion, e.g. "20% off (max $50)" */
function describeDiscount(promo: PromotionDefinition, texts: Texts): string {
    if (promo.scope === "delivery") {
        return localizedFixtureText("home.discount.freeShipping", texts);
    }
    if (promo.discountType === "absolute") {
        return localizedFixtureText("home.discount.absolute", texts, {
            amount: `$${promo.discountValue}`,
        });
    }
    const value = String(promo.discountValue);
    if (!promo.maxValue) {
        return localizedFixtureText("home.discount.percentage", texts, { value });
    }
    return localizedFixtureText("home.discount.percentageMax", texts, {
        value,
        max: `$${promo.maxValue}`,
    });
}

function buildPromotionCodesHtml(texts: Texts): string {
    const t = (key: string): string => localizedFixtureText(key, texts);
    return buildTable(
        t("home.promotionsHeading"),
        [t("home.column.code"), t("home.column.discount")],
        PROMOTIONS.map((p) => [`<code>${p.code}</code>`, describeDiscount(p, texts)])
    );
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
    features: HomeFeatures = ALL_FEATURES,
    texts: Texts = null
): string {
    const displayName = capitalizeString(storeName);
    return [
        buildIntroHtml(displayName, description, productCount, categoryCount, texts),
        buildFeaturesHtml(features, texts),
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
    features: HomeFeatures = ALL_FEATURES,
    texts: Texts = null
): string {
    const credentials = `<td style="vertical-align: top; padding-right: 3em">${buildCredentialsHtml(texts)}</td>`;
    const promotions = `<td style="vertical-align: top">${buildPromotionCodesHtml(texts)}</td>`;
    const cells = [
        ...(features.includeCredentials ? [credentials] : []),
        ...(features.includePromotions ? [promotions] : []),
    ];
    const table =
        cells.length > 0
            ? [`<table style="border-collapse: collapse"><tr>${cells.join("")}</tr></table>`]
            : [];
    const closing = localizedFixtureText("home.enjoy", texts, { name: storeName.toLowerCase() });
    return [...table, `<p>${closing}</p>`].join("");
}

/**
 * Which optional homepage sections to show, based on the processors of this run.
 *
 * Runs that do not include cms-home (e.g. `process --only=translations`) assume the
 * page was created by a full generate, which shows every section.
 */
export function homeFeaturesFor(activeProcessors: readonly string[] | undefined): HomeFeatures {
    if (!activeProcessors?.includes("cms-home")) return ALL_FEATURES;
    return {
        includeCredentials: activeProcessors.includes("customers"),
        includePromotions: activeProcessors.includes("promotions"),
        includeCrossSelling: activeProcessors.includes("cross-selling"),
    };
}

/** Homepage text slots ("<section>.<block>.<slot>" -> HTML) in one language */
export function buildHomeSlotTexts(
    blueprint: HydratedBlueprint,
    features: HomeFeatures,
    texts: Texts
): Record<string, string> {
    const { salesChannel } = blueprint;
    return {
        [HOME_HERO_SLOT_KEY]: buildHeroText(
            salesChannel.name,
            salesChannel.description,
            blueprint.products.length,
            countCategories(blueprint.categories),
            features,
            texts
        ),
        [HOME_REFERENCE_SLOT_KEY]: buildReferenceText(salesChannel.name, features, texts),
    };
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
