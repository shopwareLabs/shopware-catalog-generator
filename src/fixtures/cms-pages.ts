/**
 * CMS Page Fixtures - Reusable CMS page configurations
 *
 * Add new CMS pages here to test different element types.
 */

import type { CmsPageFixture } from "./types.js";

// =============================================================================
// Video Elements Page
// =============================================================================

/**
 * Video Elements landing page with YouTube and Vimeo examples
 */
export const VIDEO_ELEMENTS_PAGE: CmsPageFixture = {
    name: "Video Elements",
    type: "landingpage",
    sections: [
        {
            type: "default",
            sizingMode: "boxed",
            mobileBehavior: "wrap",
            blocks: [
                // Position 0: Text Hero - YouTube intro
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
                                    value: `<h2 style="text-align: center;">YouTube Video Sample</h2>
                        <hr>
                        <p style="text-align: center;">Shopware Global Kickoff 2026 was a blast!</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 1: YouTube Video
                {
                    type: "youtube-video",
                    position: 1,
                    sectionPosition: "main",
                    marginTop: "20px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "youtube-video",
                            slot: "video",
                            config: {
                                videoID: { source: "static", value: "15Xe_fJyUgU" },
                                iframeTitle: { source: "static", value: "" },
                                autoPlay: { source: "static", value: false },
                                loop: { source: "static", value: false },
                                showControls: { source: "static", value: true },
                                start: { source: "static", value: null },
                                end: { source: "static", value: null },
                                displayMode: { source: "static", value: "standard" },
                                advancedPrivacyMode: { source: "static", value: true },
                                needsConfirmation: { source: "static", value: false },
                                previewMedia: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 2: Text Teaser - Vimeo intro
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
                                    value: `<h2 style="text-align: center;">Vimeo Video Sample</h2>
                        <p style="text-align: center;"><i>Testing Vimeo Video Element</i></p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 3: Vimeo Video
                {
                    type: "vimeo-video",
                    position: 3,
                    sectionPosition: "main",
                    marginTop: "20px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "vimeo-video",
                            slot: "video",
                            config: {
                                videoID: { source: "static", value: "347119375" },
                                iframeTitle: { source: "static", value: "" },
                                autoplay: { source: "static", value: false },
                                byLine: { source: "static", value: false },
                                color: { source: "static", value: "" },
                                doNotTrack: { source: "static", value: true },
                                loop: { source: "static", value: false },
                                portrait: { source: "static", value: true },
                                title: { source: "static", value: true },
                                controls: { source: "static", value: true },
                                needsConfirmation: { source: "static", value: false },
                                previewMedia: { source: "static", value: null },
                            },
                        },
                    ],
                },
            ],
        },
    ],
};
