/**
 * Welcome Page - CMS Element Showcase landing page
 *
 * A beautiful entry point showcasing various CMS block types:
 * - text-hero: Main title and tagline
 * - image-text-bubble: 3 cards for Text, Images, Video categories
 * - center-text: Highlight for Text & Images category
 * - text-two-column: Overview of Commerce and Form categories
 * - product-slider: Live product preview
 *
 * Note: Product and media values need to be populated dynamically.
 */

import type { CmsPageFixture } from "../types.js";

export const WELCOME_PAGE: CmsPageFixture = {
    name: "CMS Element Showcase",
    type: "landingpage",
    sections: [
        {
            type: "default",
            sizingMode: "boxed",
            mobileBehavior: "wrap",
            blocks: [
                // Position 0: Hero Section
                {
                    type: "text-hero",
                    position: 0,
                    sectionPosition: "main",
                    marginTop: "40px",
                    marginBottom: "30px",
                    slots: [
                        {
                            type: "text",
                            slot: "content",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h1 style="text-align: center; font-size: 2.5em; margin-bottom: 16px;">CMS Element Showcase</h1>
<p style="text-align: center; font-size: 1.2em; color: #666; max-width: 600px; margin: 0 auto;">Explore all Shopware 6 CMS blocks in action. Each category page demonstrates different block types with real examples.</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 1: Image-Text-Bubble (3 category cards)
                {
                    type: "image-text-bubble",
                    position: 1,
                    sectionPosition: "main",
                    marginTop: "30px",
                    marginBottom: "30px",
                    slots: [
                        {
                            type: "image",
                            slot: "left-image",
                            config: {
                                media: { source: "static", value: null },
                                url: { source: "static", value: null },
                                newTab: { source: "static", value: false },
                                displayMode: { source: "static", value: "cover" },
                                minHeight: { source: "static", value: "180px" },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                        {
                            type: "text",
                            slot: "left-text",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h3 style="text-align: center; margin-bottom: 8px;">Text Elements</h3>
<p style="text-align: center; color: #666; font-size: 0.9em;">5 block types including hero, columns, and custom HTML</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                        {
                            type: "image",
                            slot: "center-image",
                            config: {
                                media: { source: "static", value: null },
                                url: { source: "static", value: null },
                                newTab: { source: "static", value: false },
                                displayMode: { source: "static", value: "cover" },
                                minHeight: { source: "static", value: "180px" },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                        {
                            type: "text",
                            slot: "center-text",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h3 style="text-align: center; margin-bottom: 8px;">Image Elements</h3>
<p style="text-align: center; color: #666; font-size: 0.9em;">Galleries, sliders, and single images</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                        {
                            type: "image",
                            slot: "right-image",
                            config: {
                                media: { source: "static", value: null },
                                url: { source: "static", value: null },
                                newTab: { source: "static", value: false },
                                displayMode: { source: "static", value: "cover" },
                                minHeight: { source: "static", value: "180px" },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                        {
                            type: "text",
                            slot: "right-text",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h3 style="text-align: center; margin-bottom: 8px;">Video Elements</h3>
<p style="text-align: center; color: #666; font-size: 0.9em;">YouTube and Vimeo embeds</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 2: Center Text (highlight Text & Images)
                {
                    type: "center-text",
                    position: 2,
                    sectionPosition: "main",
                    marginTop: "30px",
                    marginBottom: "30px",
                    slots: [
                        {
                            type: "image",
                            slot: "left",
                            config: {
                                media: { source: "static", value: null },
                                url: { source: "static", value: null },
                                newTab: { source: "static", value: false },
                                displayMode: { source: "static", value: "cover" },
                                minHeight: { source: "static", value: "200px" },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                        {
                            type: "text",
                            slot: "center",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h2 style="text-align: center; margin-bottom: 12px;">Text & Images</h2>
<p style="text-align: center; color: #666;">Combine text and images in stunning layouts. Image-text pairs, center-text, bubble columns, and text overlays on images.</p>`,
                                },
                                verticalAlign: { source: "static", value: "center" },
                            },
                        },
                        {
                            type: "image",
                            slot: "right",
                            config: {
                                media: { source: "static", value: null },
                                url: { source: "static", value: null },
                                newTab: { source: "static", value: false },
                                displayMode: { source: "static", value: "cover" },
                                minHeight: { source: "static", value: "200px" },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 3: Two Column (Commerce + Form overview)
                {
                    type: "text-two-column",
                    position: 3,
                    sectionPosition: "main",
                    marginTop: "30px",
                    marginBottom: "30px",
                    slots: [
                        {
                            type: "text",
                            slot: "left",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h3>Commerce Elements</h3>
<p>Showcase products with powerful commerce blocks:</p>
<ul style="color: #666;">
    <li>Product boxes and sliders</li>
    <li>Gallery with buy box</li>
    <li>Category navigation</li>
</ul>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                        {
                            type: "text",
                            slot: "right",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h3>Form Elements</h3>
<p>Engage customers with interactive forms:</p>
<ul style="color: #666;">
    <li>Contact forms</li>
    <li>Newsletter signup</li>
    <li>Custom confirmation messages</li>
</ul>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 4: Product Slider (live preview)
                {
                    type: "product-slider",
                    position: 4,
                    sectionPosition: "main",
                    marginTop: "30px",
                    marginBottom: "40px",
                    slots: [
                        {
                            type: "product-slider",
                            slot: "productSlider",
                            config: {
                                products: { source: "static", value: [] },
                                title: {
                                    source: "static",
                                    value: "Featured Products from This Store",
                                },
                                displayMode: { source: "static", value: "standard" },
                                boxLayout: { source: "static", value: "standard" },
                                navigationArrows: { source: "static", value: "outside" },
                                rotate: { source: "static", value: false },
                                autoplayTimeout: { source: "static", value: 5000 },
                                speed: { source: "static", value: 300 },
                                border: { source: "static", value: false },
                                elMinWidth: { source: "static", value: "280px" },
                                verticalAlign: { source: "static", value: null },
                                productStreamSorting: { source: "static", value: "name:ASC" },
                                productStreamLimit: { source: "static", value: 8 },
                            },
                        },
                    ],
                },
            ],
        },
    ],
};
