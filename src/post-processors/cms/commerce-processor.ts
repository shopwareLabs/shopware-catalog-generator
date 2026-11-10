/**
 * Commerce Elements Processor - Creates the Commerce demo page
 *
 * Note: This processor needs to populate product IDs dynamically
 * from the SalesChannel's products for the commerce blocks.
 */

import type { CmsPageFixture, CmsSlotConfig } from "../../fixtures/index.js";
import type { PostProcessorContext, PostProcessorResult } from "../index.js";

import { COMMERCE_ELEMENTS_PAGE } from "../../fixtures/index.js";
import { apiPost, cloneDeep, logger } from "../../utils/index.js";
import { BaseCmsProcessor, fixtureBlocks, toSliderItems } from "./base-processor.js";

/** Product with media information */
interface ProductWithMedia {
    id: string;
    coverMediaId: string | null;
    mediaIds: string[];
}

interface ProductSearchItem {
    id: string;
    coverId?: string;
    cover?: { mediaId?: string; media?: { id?: string } };
    media?: Array<{ mediaId?: string; id?: string }>;
}

interface ProductResponse {
    data?: ProductSearchItem[];
}

/** Product data the commerce slots are filled with */
interface ProductSlotData {
    productIds: string[];
    firstProductMedia: string[];
}

/** Config key a slot type is filled into, and its value */
interface ProductSlotFiller {
    configKey: string;
    value: (data: ProductSlotData, slotIndex: number) => unknown;
}

const PRODUCT_SLOT_FILLERS = new Map<string, ProductSlotFiller>([
    [
        "product-box",
        {
            configKey: "product",
            value: ({ productIds }, slotIndex) => productIds[slotIndex] || productIds[0] || null,
        },
    ],
    [
        "product-slider",
        { configKey: "products", value: ({ productIds }) => productIds.slice(0, 8) },
    ],
    ["buy-box", { configKey: "product", value: ({ productIds }) => productIds[0] || null }],
    [
        "image-gallery",
        {
            configKey: "sliderItems",
            value: ({ firstProductMedia }) => toSliderItems(firstProductMedia),
        },
    ],
]);

/** Cover media first, then the other unique gallery media */
function toProductWithMedia(product: ProductSearchItem): ProductWithMedia {
    const coverMediaId = product.cover?.mediaId || product.cover?.media?.id || null;
    const galleryIds = (product.media ?? [])
        .map((media) => media.mediaId || media.id)
        .filter((id): id is string => Boolean(id));
    const mediaIds = [...new Set([...(coverMediaId ? [coverMediaId] : []), ...galleryIds])];
    return { id: product.id, coverMediaId, mediaIds };
}

/** Fill a slot (by its type) with product data; slots without the config key stay as they are */
function fillProductSlot(slot: CmsSlotConfig, slotIndex: number, data: ProductSlotData): void {
    const filler = PRODUCT_SLOT_FILLERS.get(slot.type);
    if (!filler || !slot.config[filler.configKey]) return;
    slot.config[filler.configKey] = { source: "static", value: filler.value(data, slotIndex) };
}

class CommerceProcessorImpl extends BaseCmsProcessor {
    readonly name = "cms-commerce";
    readonly description =
        "Create Commerce Elements demo page (product-box, slider, gallery-buybox, nav)";
    readonly pageFixture = COMMERCE_ELEMENTS_PAGE;
    override readonly dependsOn = ["images"];

    /**
     * Override process to populate product IDs before creating the page
     */
    override async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        if (context.options.dryRun) {
            return this.dryRunResult(this.pageFixture.name, this.pageFixture.name);
        }

        return this.processPage(context, async () => {
            // Get products with media from this SalesChannel
            const products = await this.getProductsWithMedia(context);
            if (products.length === 0) {
                logger.warn(
                    `    ⚠ No products found in SalesChannel, commerce blocks will be empty`,
                    { cli: true }
                );
            }

            return {
                fixture: this.populateProductData(this.pageFixture, products),
                logs: this.layoutLogs(`with ${products.length} products`),
            };
        });
    }

    /**
     * Get products with their media from the SalesChannel
     */
    private async getProductsWithMedia(context: PostProcessorContext): Promise<ProductWithMedia[]> {
        try {
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
            if (!response.ok) return [];

            const data = (await response.json()) as ProductResponse;
            return (data.data || []).map(toProductWithMedia);
        } catch (error) {
            logger.warn("Failed to get products for commerce page", { data: error });
            return [];
        }
    }

    /**
     * Populate product IDs and media in the fixture.
     * Removes gallery-buybox block if no product media is available
     * (Shopware crashes with empty sliderItems criteria).
     */
    private populateProductData(
        fixture: CmsPageFixture,
        products: ProductWithMedia[]
    ): CmsPageFixture {
        const cloned = cloneDeep(fixture);
        const data: ProductSlotData = {
            productIds: products.map((p) => p.id),
            firstProductMedia: products[0]?.mediaIds ?? [],
        };

        if (data.firstProductMedia.length === 0) {
            this.removeGalleryBuybox(cloned);
        }

        fixtureBlocks(cloned).forEach((block) =>
            block.slots.forEach((slot, slotIndex) => fillProductSlot(slot, slotIndex, data))
        );
        return cloned;
    }

    /** Remove the gallery-buybox blocks and their text intro */
    private removeGalleryBuybox(fixture: CmsPageFixture): void {
        fixture.sections.forEach((section) => {
            section.blocks = section.blocks.filter(
                (block) => block.type !== "gallery-buybox" && !this.isGalleryBuyboxIntro(block)
            );
        });
    }

    /** Check if a block is the text intro for gallery-buybox (position 5) */
    private isGalleryBuyboxIntro(block: { position: number; type: string }): boolean {
        return block.position === 5 && block.type === "text-teaser";
    }
}

export const CommerceProcessor = new CommerceProcessorImpl();
