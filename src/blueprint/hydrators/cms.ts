/**
 * CMS Blueprint Hydrator - Generates and hydrates CMS text content via AI
 *
 * Extracts text slots from CMS page fixtures, sends them to AI for
 * store-specific text generation, and saves the hydrated content.
 */

import type { CmsBlockConfig, CmsPageFixture, CmsSectionConfig } from "../../fixtures/types.js";
import type {
    CmsBlueprint,
    CmsBlueprintBlock,
    CmsBlueprintPage,
    CmsBlueprintSection,
    CmsBlueprintSlot,
    TextProvider,
} from "../../types/index.js";

import {
    COMMERCE_ELEMENTS_PAGE,
    FORM_ELEMENTS_PAGE,
    IMAGES_ELEMENTS_PAGE,
    TESTING_PLACEHOLDER_PAGE,
    TEXT_ELEMENTS_PAGE,
    TEXT_IMAGES_ELEMENTS_PAGE,
    VIDEO_ELEMENTS_PAGE,
    WELCOME_PAGE,
} from "../../fixtures/index.js";
import { ConcurrencyLimiter, cloneDeep, executeWithRetry, logger } from "../../utils/index.js";

/** Maps fixture pages to their processor names */
const PAGE_PROCESSOR_MAP: Array<{ fixture: CmsPageFixture; processor: string }> = [
    { fixture: TEXT_ELEMENTS_PAGE, processor: "cms-text" },
    { fixture: IMAGES_ELEMENTS_PAGE, processor: "cms-images" },
    { fixture: VIDEO_ELEMENTS_PAGE, processor: "cms-video" },
    { fixture: TEXT_IMAGES_ELEMENTS_PAGE, processor: "cms-text-images" },
    { fixture: COMMERCE_ELEMENTS_PAGE, processor: "cms-commerce" },
    { fixture: FORM_ELEMENTS_PAGE, processor: "cms-form" },
    { fixture: WELCOME_PAGE, processor: "cms-welcome" },
    { fixture: TESTING_PLACEHOLDER_PAGE, processor: "cms-testing" },
];

/**
 * Generate a CMS blueprint by extracting text slots from fixtures
 */
export function generateCmsBlueprint(salesChannelName: string): CmsBlueprint {
    const pages: CmsBlueprintPage[] = PAGE_PROCESSOR_MAP.map(({ fixture, processor }) => ({
        name: fixture.name,
        processor,
        sections: extractSections(fixture.sections),
    }));

    return { salesChannelName, pages };
}

function extractSections(sections: CmsSectionConfig[]): CmsBlueprintSection[] {
    return sections.map((section) => ({
        blocks: section.blocks.map(extractBlock),
    }));
}

function extractBlock(block: CmsBlockConfig): CmsBlueprintBlock {
    return {
        type: block.type,
        position: block.position,
        slots: block.slots
            .filter((slot) => slot.type === "text" && slot.config.content)
            .map((slot) => ({
                type: slot.type,
                slot: slot.slot,
                textContent: extractTextContent(slot.config),
            })),
    };
}

function extractTextContent(config: Record<string, { source: string; value: unknown }>): string {
    const content = config.content;
    if (content && typeof content.value === "string") return content.value;
    return "";
}

/**
 * Hydrate a CMS blueprint with AI-generated text
 */
export async function hydrateCmsBlueprint(
    blueprint: CmsBlueprint,
    textProvider: TextProvider,
    storeDescription: string
): Promise<CmsBlueprint> {
    logger.info("  Hydrating CMS text content...", { cli: true });

    const limiter = new ConcurrencyLimiter(textProvider.maxConcurrency);

    const hydratedPages = await limiter.all(
        blueprint.pages.map(
            (page) => () =>
                hydratePage(page, textProvider, blueprint.salesChannelName, storeDescription)
        )
    );

    return {
        ...blueprint,
        pages: hydratedPages,
        hydratedAt: new Date().toISOString(),
    };
}

async function hydratePage(
    page: CmsBlueprintPage,
    textProvider: TextProvider,
    storeName: string,
    storeDescription: string
): Promise<CmsBlueprintPage> {
    const textSlots = collectTextSlots(page);
    if (textSlots.length === 0) return page;

    const existingTexts = textSlots.map((s) => ({
        blockType: s.blockType,
        slot: s.slot.slot,
        currentText: s.slot.textContent || "",
    }));

    const prompt = buildCmsTextPrompt(page.name, storeName, storeDescription, existingTexts);

    try {
        const response = await executeWithRetry(
            () =>
                textProvider.generateCompletion([
                    { role: "system", content: CMS_SYSTEM_PROMPT },
                    { role: "user", content: prompt },
                ]),
            { maxRetries: 3, baseDelay: 5000 }
        );

        const hydratedTexts = parseHydratedTexts(response, textSlots.length);
        return applyHydratedTexts(page, textSlots, hydratedTexts);
    } catch (error) {
        logger.warn(`Failed to hydrate CMS page "${page.name}": ${error}`);
        return page;
    }
}

interface TextSlotRef {
    sectionIdx: number;
    blockIdx: number;
    slotIdx: number;
    blockType: string;
    slot: CmsBlueprintSlot;
}

function collectTextSlots(page: CmsBlueprintPage): TextSlotRef[] {
    const refs: TextSlotRef[] = [];
    for (let si = 0; si < page.sections.length; si++) {
        const section = page.sections[si];
        if (!section) continue;
        for (let bi = 0; bi < section.blocks.length; bi++) {
            const block = section.blocks[bi];
            if (!block) continue;
            for (let sli = 0; sli < block.slots.length; sli++) {
                const slot = block.slots[sli];
                if (!slot?.textContent) continue;
                refs.push({
                    sectionIdx: si,
                    blockIdx: bi,
                    slotIdx: sli,
                    blockType: block.type,
                    slot,
                });
            }
        }
    }
    return refs;
}

const CMS_SYSTEM_PROMPT = `You are a professional e-commerce copywriter. You write engaging, realistic HTML content for CMS pages in online stores. Your text should feel authentic, professional, and match the store's theme.

Rules:
- Return ONLY a JSON array of strings, one per text slot requested
- Each string is valid HTML (use <h1>-<h3>, <p>, <ul>, <li>, etc.)
- Keep the same HTML structure/tags as the original (headings, paragraphs, lists)
- Match the approximate length of the original text
- Use inline styles only if present in the original
- Content must be relevant to the store's topic
- Do NOT include markdown, code fences, or explanations
- Write in English`;

function buildCmsTextPrompt(
    pageName: string,
    storeName: string,
    storeDescription: string,
    texts: Array<{ blockType: string; slot: string; currentText: string }>
): string {
    const slots = texts
        .map(
            (t, i) =>
                `[${i}] Block: "${t.blockType}", Slot: "${t.slot}"\nCurrent text:\n${t.currentText}`
        )
        .join("\n\n");

    return `Rewrite the following ${texts.length} text slot(s) for the "${pageName}" page of a "${storeName}" store (${storeDescription}).

Make each text relevant to this store's products and theme. Keep the same HTML structure and approximate length.

${slots}

Return a JSON array of ${texts.length} HTML strings, one for each slot in order. Example: ["<h1>...</h1>", "<p>...</p>"]`;
}

function parseHydratedTexts(response: string, expectedCount: number): string[] {
    const cleaned = response
        .trim()
        .replace(/^```json?\s*/i, "")
        .replace(/```\s*$/, "");

    try {
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed) && parsed.length >= expectedCount) {
            return parsed.slice(0, expectedCount).map(String);
        }
    } catch {
        // Try to extract JSON array from the response
        const match = cleaned.match(/\[[\s\S]*\]/);
        if (match) {
            try {
                const arr = JSON.parse(match[0]);
                if (Array.isArray(arr) && arr.length >= expectedCount) {
                    return arr.slice(0, expectedCount).map(String);
                }
            } catch {
                // Fall through
            }
        }
    }

    logger.warn(`CMS text hydration returned unexpected format, using originals`);
    return [];
}

function applyHydratedTexts(
    page: CmsBlueprintPage,
    slots: TextSlotRef[],
    hydratedTexts: string[]
): CmsBlueprintPage {
    if (hydratedTexts.length === 0) return page;

    const cloned = cloneDeep(page);

    for (let i = 0; i < slots.length && i < hydratedTexts.length; i++) {
        const ref = slots[i];
        if (!ref) continue;
        const text = hydratedTexts[i];
        if (!text) continue;

        const section = cloned.sections[ref.sectionIdx];
        const block = section?.blocks[ref.blockIdx];
        const slot = block?.slots[ref.slotIdx];
        if (slot) {
            slot.textContent = text;
        }
    }

    return cloned;
}
