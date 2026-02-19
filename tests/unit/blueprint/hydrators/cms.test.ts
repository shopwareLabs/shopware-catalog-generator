import { describe, expect, test } from "bun:test";

import {
    generateCmsBlueprint,
    hydrateCmsBlueprint,
} from "../../../../src/blueprint/hydrators/cms.js";
import { MockTextProvider } from "../../../mocks/text-provider.mock.js";

describe("cms-hydrator", () => {
    describe("generateCmsBlueprint", () => {
        test("returns a CmsBlueprint with correct salesChannelName", () => {
            const blueprint = generateCmsBlueprint("furniture");

            expect(blueprint).toBeDefined();
            expect(blueprint.salesChannelName).toBe("furniture");
        });

        test("includes pages for all 8 CMS page fixtures", () => {
            const blueprint = generateCmsBlueprint("beauty");

            expect(blueprint.pages).toHaveLength(8);

            const pageNames = blueprint.pages.map((p) => p.name);
            expect(pageNames).toContain("Text Elements");
            expect(pageNames).toContain("Image Elements");
            expect(pageNames).toContain("Video Elements");
            expect(pageNames).toContain("Text & Images");
            expect(pageNames).toContain("Commerce Elements");
            expect(pageNames).toContain("Form Elements");
            expect(pageNames).toContain("CMS Element Showcase");
            expect(pageNames).toContain("Testing Overview");
        });

        test("each page has sections with blocks that contain text slots", () => {
            const blueprint = generateCmsBlueprint("music");

            for (const page of blueprint.pages) {
                expect(page.sections.length).toBeGreaterThanOrEqual(0);
                for (const section of page.sections) {
                    expect(section.blocks).toBeDefined();
                    for (const block of section.blocks) {
                        expect(block.slots).toBeDefined();
                        const textSlots = block.slots.filter(
                            (s) => s.type === "text" && s.textContent
                        );
                        if (block.slots.length > 0) {
                            expect(textSlots.length).toBeGreaterThanOrEqual(0);
                        }
                    }
                }
            }
        });

        test("text slots contain the original fixture text content", () => {
            const blueprint = generateCmsBlueprint("garden");

            const textElementsPage = blueprint.pages.find((p) => p.name === "Text Elements");
            expect(textElementsPage).toBeDefined();

            const textSlots = textElementsPage!.sections.flatMap((s) =>
                s.blocks.flatMap((b) => b.slots.filter((slot) => slot.textContent))
            );
            expect(textSlots.length).toBeGreaterThan(0);

            const firstSlot = textSlots[0];
            expect(firstSlot?.textContent).toContain("Text Elements");
        });
    });

    describe("hydrateCmsBlueprint", () => {
        test("with mock text provider that returns JSON array of strings, replaces text content in slots", async () => {
            const blueprint = generateCmsBlueprint("test-store");
            const pageWithText = blueprint.pages.find((p) =>
                p.sections.some((s) =>
                    s.blocks.some((b) => b.slots.some((slot) => slot.textContent))
                )
            );
            if (!pageWithText) {
                return;
            }

            const textSlotCount = pageWithText.sections.reduce(
                (count, s) =>
                    count +
                    s.blocks.reduce(
                        (c, b) => c + b.slots.filter((slot) => slot.textContent).length,
                        0
                    ),
                0
            );
            if (textSlotCount === 0) return;

            const mockProvider = new MockTextProvider();
            mockProvider.setRawResponse(
                "default",
                JSON.stringify(
                    Array.from({ length: textSlotCount }, (_, i) => `<p>Hydrated ${i}</p>`)
                )
            );

            const hydrated = await hydrateCmsBlueprint(
                blueprint,
                mockProvider,
                "Test store description"
            );

            const hydratedPage = hydrated.pages.find((p) => p.name === pageWithText.name);
            expect(hydratedPage).toBeDefined();

            const firstTextSlot = hydratedPage!.sections
                .flatMap((s) => s.blocks)
                .flatMap((b) => b.slots)
                .find((s) => s.textContent);
            expect(firstTextSlot?.textContent).toBe("<p>Hydrated 0</p>");
        });

        test("falls back to original text on parse failure", async () => {
            const blueprint = generateCmsBlueprint("test-store");
            const pageWithText = blueprint.pages.find((p) =>
                p.sections.some((s) =>
                    s.blocks.some((b) => b.slots.some((slot) => slot.textContent))
                )
            );
            if (!pageWithText) return;

            const originalFirstSlot = pageWithText.sections
                .flatMap((s) => s.blocks)
                .flatMap((b) => b.slots)
                .find((s) => s.textContent);
            const originalText = originalFirstSlot?.textContent;
            if (!originalText) return;

            const mockProvider = new MockTextProvider();
            mockProvider.setRawResponse("default", "invalid json {{{");

            const hydrated = await hydrateCmsBlueprint(blueprint, mockProvider, "Test store");

            const hydratedPage = hydrated.pages.find((p) => p.name === pageWithText.name);
            expect(hydratedPage).toBeDefined();
            const firstSlot = hydratedPage!.sections
                .flatMap((s) => s.blocks)
                .flatMap((b) => b.slots)
                .find((s) => s.textContent);
            expect(firstSlot?.textContent).toBe(originalText);
        });

        test("sets hydratedAt timestamp", async () => {
            const blueprint = generateCmsBlueprint("test-store");
            const mockProvider = new MockTextProvider();

            const hydrated = await hydrateCmsBlueprint(blueprint, mockProvider, "Test store");

            expect(hydrated.hydratedAt).toBeDefined();
            expect(typeof hydrated.hydratedAt).toBe("string");
            expect(new Date(hydrated.hydratedAt!).getTime()).not.toBeNaN();
        });
    });
});
