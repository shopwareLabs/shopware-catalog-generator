/**
 * Form Elements Page - Demonstrates form CMS blocks
 *
 * Blocks: form (contact), form (newsletter)
 */

import type { CmsPageFixture } from "../types.js";

export const FORM_ELEMENTS_PAGE: CmsPageFixture = {
    name: "Form Elements",
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
                                    value: `<h1 style="text-align: center;">Form Elements</h1>
<p style="text-align: center;">Interactive forms for customer engagement</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 1: Text intro for Contact Form
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
                                    value: `<h2 style="text-align: center;">Contact Form</h2>
<p style="text-align: center;">Allow customers to send inquiries directly</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 2: Contact Form
                {
                    type: "form",
                    position: 2,
                    sectionPosition: "main",
                    marginTop: "10px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "form",
                            slot: "content",
                            config: {
                                type: { source: "static", value: "contact" },
                                title: { source: "static", value: "Get in Touch" },
                                mailReceiver: {
                                    source: "static",
                                    value: ["contact@example.com"],
                                },
                                defaultMailReceiver: { source: "static", value: true },
                                confirmationText: {
                                    source: "static",
                                    value: "Thank you for your message! We will get back to you shortly.",
                                },
                            },
                        },
                    ],
                },
                // Position 3: Text intro for Newsletter
                {
                    type: "text-teaser",
                    position: 3,
                    sectionPosition: "main",
                    marginTop: "40px",
                    marginBottom: "10px",
                    slots: [
                        {
                            type: "text",
                            slot: "content",
                            config: {
                                content: {
                                    source: "static",
                                    value: `<h2 style="text-align: center;">Newsletter Signup</h2>
<p style="text-align: center;">Build your mailing list with a simple signup form</p>`,
                                },
                                verticalAlign: { source: "static", value: null },
                            },
                        },
                    ],
                },
                // Position 4: Newsletter Form
                {
                    type: "form",
                    position: 4,
                    sectionPosition: "main",
                    marginTop: "10px",
                    marginBottom: "20px",
                    slots: [
                        {
                            type: "form",
                            slot: "content",
                            config: {
                                type: { source: "static", value: "newsletter" },
                                title: {
                                    source: "static",
                                    value: "Subscribe to Our Newsletter",
                                },
                                mailReceiver: {
                                    source: "static",
                                    value: ["newsletter@example.com"],
                                },
                                defaultMailReceiver: { source: "static", value: true },
                                confirmationText: {
                                    source: "static",
                                    value: "Thank you for subscribing! Check your email to confirm.",
                                },
                            },
                        },
                    ],
                },
            ],
        },
    ],
};
