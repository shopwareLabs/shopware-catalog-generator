/**
 * Theme Hydrator - Generates brand colors for theme customization via AI
 */

import { z } from "zod";

import type { BrandColors, TextProvider } from "../../types/index.js";

import { executeWithRetry, logger } from "../../utils/index.js";

const hexColorPattern = /^#[0-9a-fA-F]{6}$/;

const BrandColorsSchema = z.object({
    primary: z.string().regex(hexColorPattern),
    secondary: z.string().regex(hexColorPattern),
});

const FALLBACK_BRAND_COLORS: BrandColors = { primary: "#0070f3", secondary: "#7928ca" };

export async function hydrateBrandColors(
    textProvider: TextProvider,
    storeName: string,
    storeDescription: string
): Promise<BrandColors> {
    logger.info("  Generating brand colors...", { cli: true });

    const result = await executeWithRetry(() =>
        textProvider.generateCompletion([
            {
                role: "system",
                content:
                    "You are a brand designer following Material Design color principles. " +
                    "Pick a primary and secondary color for an e-commerce store. " +
                    "Return ONLY a JSON object with two hex color codes (#RRGGBB). " +
                    "The primary color is used for buy buttons, links, and headings — it must have good contrast on white (WCAG AA, relative luminance <= 0.4). " +
                    "The secondary color complements the primary and is used for accents. " +
                    'Example: {"primary":"#E91E63","secondary":"#F8BBD0"}',
            },
            {
                role: "user",
                content: [
                    `Generate brand colors for this online store:`,
                    `Store name: "${storeName}"`,
                    `What it sells: ${storeDescription}`,
                    ``,
                    `Choose colors that evoke the right mood for this type of store.`,
                    `Return ONLY {"primary":"#...","secondary":"#..."} — no other fields, no markdown.`,
                ].join("\n"),
            },
        ])
    );

    try {
        const jsonStr = result
            .replace(/```json?\n?/g, "")
            .replace(/```\n?/g, "")
            .trim();
        const parsed = BrandColorsSchema.parse(JSON.parse(jsonStr));
        logger.info(`  Brand colors: primary=${parsed.primary}, secondary=${parsed.secondary}`, {
            cli: true,
        });
        return parsed;
    } catch (err) {
        logger.warn("Brand color generation returned invalid response — using defaults", {
            cli: true,
            data: { raw: result, error: err },
        });
        return FALLBACK_BRAND_COLORS;
    }
}

export { FALLBACK_BRAND_COLORS };
