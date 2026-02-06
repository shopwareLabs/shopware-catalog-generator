/**
 * Commerce Elements Processor - Creates the Commerce demo page
 *
 * Note: This processor needs to populate product IDs dynamically
 * from the SalesChannel's products for the commerce blocks.
 */

import type { CmsPageFixture } from "../../fixtures/index.js";
import type { PostProcessorContext, PostProcessorResult } from "../index.js";

import { COMMERCE_ELEMENTS_PAGE } from "../../fixtures/index.js";
import { apiPost, logger } from "../../utils/index.js";

import { BaseCmsProcessor } from "./base-processor.js";

class CommerceProcessorImpl extends BaseCmsProcessor {
    readonly name = "cms-commerce";
    readonly description =
        "Create Commerce Elements demo page (product-box, slider, gallery-buybox, nav)";
    readonly pageFixture = COMMERCE_ELEMENTS_PAGE;

    /**
     * Override process to populate product IDs before creating the page
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
            // Get products with media from this SalesChannel
            const products = await this.getProductsWithMedia(context);
            if (products.length === 0) {
                logger.cli(
                    `    ⚠ No products found in SalesChannel, commerce blocks will be empty`
                );
            }

            // Create a modified fixture with product IDs and media populated
            const populatedFixture = this.populateProductData(this.pageFixture, products);

            // Step 1: Check if CMS page already exists for this SalesChannel
            let cmsPageId = await this.findCmsPageByName(context, cmsPageName);

            if (!cmsPageId) {
                cmsPageId = await this.createCmsPage(context, populatedFixture, cmsPageName);
                if (!cmsPageId) {
                    errors.push(`Failed to create CMS page layout "${cmsPageName}"`);
                    return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
                }
                logger.cli(
                    `    ✓ Created CMS layout "${this.pageFixture.name}" with ${products.length} products`
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
     * Get products with their media from the SalesChannel
     */
    private async getProductsWithMedia(context: PostProcessorContext): Promise<ProductWithMedia[]> {
        try {
            interface ProductResponse {
                data?: Array<{
                    id: string;
                    coverId?: string;
                    cover?: { mediaId?: string; media?: { id?: string } };
                    media?: Array<{ mediaId?: string; id?: string }>;
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
                    media: {},
                },
                limit: 10,
            });

            if (response.ok) {
                const data = (await response.json()) as ProductResponse;
                return (data.data || []).map((p) => {
                    // Extract cover media ID
                    const coverMediaId = p.cover?.mediaId || p.cover?.media?.id || null;

                    // Get all media IDs for gallery
                    const mediaIds: string[] = [];
                    if (coverMediaId) mediaIds.push(coverMediaId);
                    if (p.media) {
                        for (const m of p.media) {
                            const mediaId = m.mediaId || m.id;
                            if (mediaId && !mediaIds.includes(mediaId)) {
                                mediaIds.push(mediaId);
                            }
                        }
                    }

                    return { id: p.id, coverMediaId, mediaIds };
                });
            }
        } catch (error) {
            logger.warn("Failed to get products for commerce page", { error });
        }

        return [];
    }

    /**
     * Populate product IDs and media in the fixture
     */
    private populateProductData(
        fixture: CmsPageFixture,
        products: ProductWithMedia[]
    ): CmsPageFixture {
        // Deep clone the fixture
        const cloned = JSON.parse(JSON.stringify(fixture)) as CmsPageFixture;
        const productIds = products.map((p) => p.id);

        for (const section of cloned.sections) {
            for (const block of section.blocks) {
                for (const slot of block.slots) {
                    // Product box slots
                    if (slot.type === "product-box" && slot.config.product) {
                        const index = block.slots.indexOf(slot);
                        const productId = productIds[index] || productIds[0] || null;
                        slot.config.product = { source: "static", value: productId };
                    }

                    // Product slider slot
                    if (slot.type === "product-slider" && slot.config.products) {
                        slot.config.products = { source: "static", value: productIds.slice(0, 8) };
                    }

                    // Buy box slot
                    if (slot.type === "buy-box" && slot.config.product) {
                        slot.config.product = { source: "static", value: productIds[0] || null };
                    }

                    // Image gallery slot (in gallery-buybox)
                    if (slot.type === "image-gallery" && slot.config.sliderItems) {
                        // Use the first product's media for the gallery
                        const firstProduct = products[0];
                        if (firstProduct && firstProduct.mediaIds.length > 0) {
                            const sliderItems = firstProduct.mediaIds.map((mediaId) => ({
                                mediaId,
                                url: null,
                                newTab: false,
                            }));
                            slot.config.sliderItems = { source: "static", value: sliderItems };
                        }
                    }
                }
            }
        }

        return cloned;
    }
}

/** Product with media information */
interface ProductWithMedia {
    id: string;
    coverMediaId: string | null;
    mediaIds: string[];
}

export const CommerceProcessor = new CommerceProcessorImpl();
