/**
 * Images Elements Page - Demonstrates image CMS blocks
 *
 * Blocks: image, image-slider, image-gallery
 *
 * Note: sliderItems arrays are populated dynamically by the processor
 * using media from products in the SalesChannel.
 */

import type { CmsPageFixture } from "../types.js";

/**
 * Images Elements Page
 *
 * Demonstrates all image block types with live product media.
 */
export const IMAGES_ELEMENTS_PAGE: CmsPageFixture = {
    name: "Image Elements",
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
                                    value: `<h1 style="text-align: center;">Image Elements</h1>
<p style="text-align: center;">Display images with various layouts and slider options</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 1: Text intro for Image Slider
                {
                    type: "text",
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
                                    value: `<h2>Image Slider</h2>
<p>A carousel of images with navigation arrows and dots. Supports auto-slide, custom speed, and various display modes.</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 2: Image Slider
                // Note: sliderItems will be populated dynamically by the processor
                {
                    type: "image-slider",
                    position: 2,
                    sectionPosition: "main",
                    marginTop: "10px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "image-slider",
                            slot: "imageSlider",
                            config: {
                                sliderItems: { source: "static", value: [] },
                                navigationArrows: { source: "static", value: "outside" },
                                navigationDots: { source: "static", value: "inside" },
                                displayMode: { source: "static", value: "standard" },
                                minHeight: { source: "static", value: "300px" },
                                verticalAlign: { source: "static", value: null },
                                speed: { source: "static", value: 300 },
                                autoSlide: { source: "static", value: false },
                                autoplayTimeout: { source: "static", value: 5000 },
                                isDecorative: { source: "static", value: false },
                                useFetchPriorityOnFirstItem: { source: "static", value: false },
                            },
                        },
                    ],
                },
                // Position 3: Text intro for Image Gallery
                {
                    type: "text",
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
                                    value: `<h2>Image Gallery</h2>
<p>Multiple images with thumbnails, zoom capability, and full-screen viewing. Perfect for product showcases.</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 4: Image Gallery
                {
                    type: "image-gallery",
                    position: 4,
                    sectionPosition: "main",
                    marginTop: "10px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "image-gallery",
                            slot: "imageGallery",
                            config: {
                                sliderItems: { source: "static", value: [] },
                                navigationArrows: { source: "static", value: "inside" },
                                navigationDots: { source: "static", value: "outside" },
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
                    ],
                },
            ],
        },
    ],
};
