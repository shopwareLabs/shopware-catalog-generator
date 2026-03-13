/**
 * Home Listing Page - Homepage layout for generated stores
 *
 * A product_list page assigned to the root category with:
 * - Section 1 (default): text-teaser-section with hero image (left) + welcome text (right)
 * - Section 2 (default): full-width text block with credentials + promotion codes
 * - Section 3 (sidebar): product-listing + sidebar-filter for browsing all products
 *
 * The image and text slots are populated dynamically by the cms-home processor
 * with store-specific content (name, description, product/category counts).
 */

import type { CmsPageFixture } from "../types.js";

export const HOME_LISTING_PAGE: CmsPageFixture = {
    name: "Home Listing",
    type: "product_list",
    sections: [
        {
            type: "default",
            sizingMode: "boxed",
            mobileBehavior: "wrap",
            blocks: [
                {
                    type: "text-teaser-section",
                    position: 0,
                    sectionPosition: "main",
                    marginTop: "20px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "image",
                            slot: "left",
                            config: {
                                media: { source: "static", value: null },
                                displayMode: { source: "static", value: "cover" },
                                minHeight: { source: "static", value: "340px" },
                                verticalAlign: { source: "static", value: "center" },
                                horizontalAlign: { source: "static", value: "center" },
                                url: { source: "static", value: null },
                                newTab: { source: "static", value: false },
                            },
                        },
                        {
                            type: "text",
                            slot: "right",
                            config: {
                                content: {
                                    source: "static",
                                    value: "<h2>Welcome to the Demo-Store!</h2>",
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
            ],
        },
        {
            type: "default",
            sizingMode: "boxed",
            mobileBehavior: "wrap",
            blocks: [
                {
                    type: "text",
                    position: 0,
                    sectionPosition: "main",
                    marginTop: "0px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "text",
                            slot: "content",
                            config: {
                                content: {
                                    source: "static",
                                    value: "",
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
            ],
        },
        {
            type: "sidebar",
            sizingMode: "boxed",
            mobileBehavior: "wrap",
            blocks: [
                {
                    type: "product-listing",
                    position: 0,
                    sectionPosition: "main",
                    marginTop: "20px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "product-listing",
                            slot: "content",
                            config: {
                                boxLayout: { source: "static", value: "standard" },
                                boxHeadlineLevel: { source: "static", value: 2 },
                                showSorting: { source: "static", value: true },
                                useCustomSorting: { source: "static", value: false },
                                availableSortings: { source: "static", value: [] },
                                defaultSorting: { source: "static", value: "" },
                                filters: {
                                    source: "static",
                                    value: "manufacturer-filter,rating-filter,price-filter,shipping-free-filter,property-filter",
                                },
                                propertyWhitelist: { source: "static", value: [] },
                            },
                        },
                    ],
                },
                {
                    type: "sidebar-filter",
                    position: 1,
                    sectionPosition: "sidebar",
                    marginTop: "20px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "sidebar-filter",
                            slot: "content",
                            config: {},
                        },
                    ],
                },
            ],
        },
    ],
};
