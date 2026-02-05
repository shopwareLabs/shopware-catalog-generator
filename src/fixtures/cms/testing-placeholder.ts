/**
 * Testing Placeholder Page - Entry point for Testing category
 *
 * A simple placeholder page that will be replaced with actual content later.
 * Currently serves as the landing page for the main Testing category.
 */

import type { CmsPageFixture } from "../types.js";

export const TESTING_PLACEHOLDER_PAGE: CmsPageFixture = {
    name: "Testing Overview",
    type: "landingpage",
    sections: [
        {
            type: "default",
            sizingMode: "boxed",
            mobileBehavior: "wrap",
            blocks: [
                // Hero Section
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
                                    value: `<h1 style="text-align: center; font-size: 2.5em; margin-bottom: 16px;">Testing Area</h1>
<p style="text-align: center; font-size: 1.2em; color: #666; max-width: 600px; margin: 0 auto;">Welcome to the Testing section. Explore CMS elements and product types below.</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Two Column Overview
                {
                    type: "text-two-column",
                    position: 1,
                    sectionPosition: "main",
                    marginTop: "30px",
                    marginBottom: "40px",
                    slots: [
                        {
                            type: "text",
                            slot: "left",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h2>CMS Elements</h2>
<p>Explore all Shopware 6 CMS block types in action. Each category demonstrates different block types with real examples:</p>
<ul>
<li><strong>Text</strong> - Text blocks, heroes, teasers</li>
<li><strong>Images</strong> - Galleries, sliders, single images</li>
<li><strong>Video</strong> - YouTube and Vimeo embeds</li>
<li><strong>Text & Images</strong> - Combined layouts</li>
<li><strong>Commerce</strong> - Product boxes, sliders, buy boxes</li>
<li><strong>Form</strong> - Contact and newsletter forms</li>
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
                                    value: `<h2>Product Types</h2>
<p>View examples of different product configurations available in Shopware 6:</p>
<ul>
<li><strong>Simple Product</strong> - Standard product without variants</li>
<li><strong>Variant Product</strong> - Product with size/color options</li>
<li><strong>Digital Product</strong> - Downloadable product with file attachment</li>
</ul>
<p style="margin-top: 16px; color: #666;">Click on each category in the navigation to explore the examples.</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
            ],
        },
    ],
};
