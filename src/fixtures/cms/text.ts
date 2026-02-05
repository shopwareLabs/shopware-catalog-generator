/**
 * Text Elements Page - Demonstrates text-based CMS blocks
 *
 * Blocks: text, text-hero, text-teaser, text-two-column, html
 */

import type { CmsPageFixture } from "../types.js";

export const TEXT_ELEMENTS_PAGE: CmsPageFixture = {
    name: "Text Elements",
    type: "landingpage",
    sections: [
        {
            type: "default",
            sizingMode: "boxed",
            mobileBehavior: "wrap",
            blocks: [
                // Position 0: Text Hero - Main title
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
                                    value: `<h1 style="text-align: center;">Text Elements</h1>
<p style="text-align: center;">Explore the various text block types available in Shopware CMS</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 1: Simple Text Block
                {
                    type: "text",
                    position: 1,
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
                                    value: `<h2>Simple Text Block</h2>
<p>This is a basic text block. It's perfect for paragraphs, lists, and general content. You can use HTML formatting to create rich text content with headings, bold text, links, and more.</p>
<ul>
    <li>Supports HTML formatting</li>
    <li>Great for paragraphs and lists</li>
    <li>Flexible content structure</li>
</ul>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 2: Text Teaser
                {
                    type: "text-teaser",
                    position: 2,
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
                                    value: `<h2 style="text-align: center;">Text Teaser Block</h2>
<p style="text-align: center;"><i>Perfect for introductions, quotes, or highlighting important information</i></p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 3: Text Two Column
                {
                    type: "text-two-column",
                    position: 3,
                    sectionPosition: "main",
                    marginTop: "20px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "text",
                            slot: "left",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h3>Left Column</h3>
<p>Two-column layouts are great for comparing features, showing before/after content, or organizing related information side by side.</p>`,
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
                                    value: `<h3>Right Column</h3>
<p>Each column can have its own heading and content. The columns automatically stack on mobile devices for better readability.</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 4: HTML Block
                {
                    type: "html",
                    position: 4,
                    sectionPosition: "main",
                    marginTop: "20px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "html",
                            slot: "content",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px; border-radius: 12px; text-align: center; color: white;">
    <h2 style="margin: 0 0 16px 0; color: white;">Custom HTML Block</h2>
    <p style="margin: 0 0 20px 0; opacity: 0.9;">This block allows custom HTML, CSS, and even JavaScript for advanced layouts.</p>
    <button style="background: white; color: #667eea; border: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; cursor: pointer;">
        Custom Button
    </button>
</div>`,
                                },
                            },
                        },
                    ],
                },
            ],
        },
    ],
};
