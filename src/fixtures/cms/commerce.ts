/**
 * Commerce Elements Page - Demonstrates product-related CMS blocks
 *
 * Blocks: product-box (3-column), product-slider, gallery-buybox, category-navigation
 *
 * Note: Product blocks require product IDs to display products.
 * The processor will populate these dynamically from the SalesChannel.
 */

import type { CmsPageFixture } from "../types.js";

export const COMMERCE_ELEMENTS_PAGE: CmsPageFixture = {
    name: "Commerce Elements",
    type: "landingpage",
    sections: [
        {
            type: "default",
            sizingMode: "boxed",
            mobileBehavior: "wrap",
            blocks: [
                // Position 0: Text Hero - Introduction
                {
                    type: "text-hero",
                    position: 0,
                    sectionPosition: "main",
                    marginTop: "20px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "text",
                            slot: "content",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h1 style="text-align: center;">Commerce Elements</h1>
<p style="text-align: center;">Display products with various layouts and shopping features</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 1: Text intro for Product Boxes
                {
                    type: "text-teaser",
                    position: 1,
                    sectionPosition: "main",
                    marginTop: "20px",
                    marginBottom: "10px",
                    slots: [
                        {
                            type: "text",
                            slot: "content",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h2 style="text-align: center;">Product Boxes</h2>
<p style="text-align: center;">Featured products in a three-column layout</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 2: Product Three Column
                // Note: product values will be set dynamically by the processor
                {
                    type: "product-three-column",
                    position: 2,
                    sectionPosition: "main",
                    marginTop: "10px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "product-box",
                            slot: "left",
                            config: {
                                product: { source: "static", value: null },
                                boxLayout: { source: "static", value: "standard" },
                                displayMode: { source: "static", value: "standard" },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                        {
                            type: "product-box",
                            slot: "center",
                            config: {
                                product: { source: "static", value: null },
                                boxLayout: { source: "static", value: "standard" },
                                displayMode: { source: "static", value: "standard" },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                        {
                            type: "product-box",
                            slot: "right",
                            config: {
                                product: { source: "static", value: null },
                                boxLayout: { source: "static", value: "standard" },
                                displayMode: { source: "static", value: "standard" },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 3: Text intro for Product Slider
                {
                    type: "text-teaser",
                    position: 3,
                    sectionPosition: "main",
                    marginTop: "20px",
                    marginBottom: "10px",
                    slots: [
                        {
                            type: "text",
                            slot: "content",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h2 style="text-align: center;">Product Slider</h2>
<p style="text-align: center;">A carousel of products with navigation controls</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 4: Product Slider
                // Note: products array will be set dynamically by the processor
                {
                    type: "product-slider",
                    position: 4,
                    sectionPosition: "main",
                    marginTop: "10px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "product-slider",
                            slot: "productSlider",
                            config: {
                                products: { source: "static", value: [] },
                                title: { source: "static", value: "Featured Products" },
                                displayMode: { source: "static", value: "standard" },
                                boxLayout: { source: "static", value: "standard" },
                                navigationArrows: { source: "static", value: "outside" },
                                rotate: { source: "static", value: false },
                                autoplayTimeout: { source: "static", value: 5000 },
                                speed: { source: "static", value: 300 },
                                border: { source: "static", value: false },
                                elMinWidth: { source: "static", value: "300px" },
                                verticalAlign: { source: "static", value: null },
                                productStreamSorting: { source: "static", value: "name:ASC" },
                                productStreamLimit: { source: "static", value: 10 },
                            },
                        },
                    ],
                },
                // Position 5: Text intro for Gallery-Buybox
                {
                    type: "text-teaser",
                    position: 5,
                    sectionPosition: "main",
                    marginTop: "20px",
                    marginBottom: "10px",
                    slots: [
                        {
                            type: "text",
                            slot: "content",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h2 style="text-align: center;">Gallery + Buy Box</h2>
<p style="text-align: center;">Product detail layout with image gallery and add-to-cart functionality</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 6: Gallery-Buybox
                // Note: media and product values will be set dynamically
                {
                    type: "gallery-buybox",
                    position: 6,
                    sectionPosition: "main",
                    marginTop: "10px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "image-gallery",
                            slot: "left",
                            config: {
                                sliderItems: { source: "static", value: [] },
                                navigationArrows: { source: "static", value: "inside" },
                                navigationDots: { source: "static", value: "none" },
                                galleryPosition: { source: "static", value: "left" },
                                displayMode: { source: "static", value: "standard" },
                                minHeight: { source: "static", value: "340px" },
                                verticalAlign: { source: "static", value: null },
                                zoom: { source: "static", value: true },
                                fullScreen: { source: "static", value: true },
                                keepAspectRatioOnZoom: { source: "static", value: true },
                                magnifierOverGallery: { source: "static", value: false },
                                useFetchPriorityOnFirstItem: { source: "static", value: false },
                            },
                        },
                        {
                            type: "buy-box",
                            slot: "right",
                            config: {
                                product: { source: "static", value: null },
                                alignment: { source: "static", value: "flex-start" },
                            },
                        },
                    ],
                },
                // Position 7: Text intro for Category Navigation
                {
                    type: "text-teaser",
                    position: 7,
                    sectionPosition: "main",
                    marginTop: "20px",
                    marginBottom: "10px",
                    slots: [
                        {
                            type: "text",
                            slot: "content",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h2 style="text-align: center;">Category Navigation</h2>
<p style="text-align: center;">Display the category tree for easy navigation</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 8: Category Navigation
                // Uses page context automatically, no config needed
                {
                    type: "category-navigation",
                    position: 8,
                    sectionPosition: "main",
                    marginTop: "10px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "category-navigation",
                            slot: "content",
                            config: {},
                        },
                    ],
                },
            ],
        },
    ],
};
