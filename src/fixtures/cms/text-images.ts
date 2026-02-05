/**
 * Text & Images Elements Page - Demonstrates combined text and image blocks
 *
 * Blocks: image-text, center-text, image-text-bubble, text-on-image
 *
 * Note: Image blocks require media IDs to display images.
 * The processor will populate these dynamically.
 */

import type { CmsPageFixture } from "../types.js";

export const TEXT_IMAGES_ELEMENTS_PAGE: CmsPageFixture = {
    name: "Text & Images",
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
                                    value: `<h1 style="text-align: center;">Text & Images</h1>
<p style="text-align: center;">Combine text with images in various layouts</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 1: Image-Text (image left, text right)
                {
                    type: "image-text",
                    position: 1,
                    sectionPosition: "main",
                    marginTop: "20px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "image",
                            slot: "left",
                            config: {
                                media: { source: "static", value: null },
                                url: { source: "static", value: null },
                                newTab: { source: "static", value: false },
                                displayMode: { source: "static", value: "cover" },
                                minHeight: { source: "static", value: "300px" },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                        {
                            type: "text",
                            slot: "right",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h2>Image-Text Block</h2>
<p>This layout places an image on the left and text on the right. It's perfect for product features, team member profiles, or any content that benefits from visual accompaniment.</p>
<p>The image automatically adjusts to the content height while maintaining its aspect ratio.</p>`,
                                },
                                verticalAlign: { source: "static", value: "center" },
                            },
                        },
                    ],
                },
                // Position 2: Image-Text reversed (text left, image right)
                {
                    type: "image-text",
                    position: 2,
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
                                    value: `<h2>Reversed Layout</h2>
<p>By swapping the slot assignments, you can create a text-left, image-right layout. This creates visual variety when alternating between sections.</p>
<p>Use this pattern to keep your pages visually interesting while maintaining readability.</p>`,
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
                                minHeight: { source: "static", value: "300px" },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 3: Center Text (image-text-image)
                {
                    type: "center-text",
                    position: 3,
                    sectionPosition: "main",
                    marginTop: "20px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "image",
                            slot: "left",
                            config: {
                                media: { source: "static", value: null },
                                url: { source: "static", value: null },
                                newTab: { source: "static", value: false },
                                displayMode: { source: "static", value: "cover" },
                                minHeight: { source: "static", value: "250px" },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                        {
                            type: "text",
                            slot: "center",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h2 style="text-align: center;">Center Text</h2>
<p style="text-align: center;">This three-column layout frames your text content between two images. Perfect for highlighting key messages or creating visual impact.</p>`,
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
                                minHeight: { source: "static", value: "250px" },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 4: Image-Text-Bubble (3 columns with image+text pairs)
                {
                    type: "image-text-bubble",
                    position: 4,
                    sectionPosition: "main",
                    marginTop: "20px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "image",
                            slot: "left-image",
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
                            slot: "left-text",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h3 style="text-align: center;">Feature One</h3>
<p style="text-align: center;">Highlight your first feature with an image and description.</p>`,
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
                                minHeight: { source: "static", value: "200px" },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                        {
                            type: "text",
                            slot: "center-text",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h3 style="text-align: center;">Feature Two</h3>
<p style="text-align: center;">The center column draws attention to your main selling point.</p>`,
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
                                minHeight: { source: "static", value: "200px" },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                        {
                            type: "text",
                            slot: "right-text",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h3 style="text-align: center;">Feature Three</h3>
<p style="text-align: center;">Complete the trio with a third compelling feature.</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 5: Text on Image (overlay)
                // Note: This block needs backgroundMediaId set at the block level
                {
                    type: "text-on-image",
                    position: 5,
                    sectionPosition: "main",
                    marginTop: "20px",
                    marginBottom: "20px",
                    backgroundMediaId: undefined, // Set dynamically by processor
                    backgroundMediaMode: "cover",
                    slots: [
                        {
                            type: "text",
                            slot: "content",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<div style="padding: 60px 20px; text-align: center;">
<h2 style="color: white; text-shadow: 2px 2px 4px rgba(0,0,0,0.5);">Text on Image</h2>
<p style="color: white; text-shadow: 1px 1px 2px rgba(0,0,0,0.5); max-width: 600px; margin: 0 auto;">This block overlays text on a background image. Great for hero sections, calls to action, or creating dramatic visual impact.</p>
</div>`,
                                },
                                verticalAlign: { source: "static", value: "center" },
                            },
                        },
                    ],
                },
            ],
        },
    ],
};
