/**
 * Video Elements Page - Demonstrates video CMS blocks
 *
 * Blocks: youtube-video, vimeo-video
 */

import type { CmsPageFixture } from "../types.js";

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
                                    value: `<h1 style="text-align: center;">Video Elements</h1>
<p style="text-align: center;">Embed videos from YouTube and Vimeo in your CMS pages</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 1: Text intro for YouTube
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
                                    value: `<h2 style="text-align: center;">YouTube Video</h2>
<p style="text-align: center;">Shopware Global Kickoff 2026</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 2: YouTube Video
                {
                    type: "youtube-video",
                    position: 2,
                    sectionPosition: "main",
                    marginTop: "10px",
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
                // Position 3: Text intro for Vimeo
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
                                    value: `<h2 style="text-align: center;">Vimeo Video</h2>
<p style="text-align: center;">Testing the Vimeo video element</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 4: Vimeo Video
                {
                    type: "vimeo-video",
                    position: 4,
                    sectionPosition: "main",
                    marginTop: "10px",
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
