/**
 * Colour shade hydrator - classifies store-specific shade names via AI
 *
 * Shade names that are not in the curated fixture ("Dusty Rose", "Sunset Orange",
 * "Moss") get a hex code and a colour family from the AI, with the store context so
 * ambiguous names are read the way this store means them. Results are learned per
 * store (`color-shades.json`) and reused on the next run, so each name costs one
 * classification once.
 */

import { z } from "zod";

import type { ColorShade, LearnedColorShades, TextProvider } from "../../types/index.js";
import type { StoreContext } from "./product.js";

import { COLOR_FAMILY_KEYS, ColorShadeSchema } from "../../types/index.js";
import {
    estimateShade,
    executeWithRetry,
    logger,
    normalizeColorName,
    resolveShade,
} from "../../utils/index.js";

/** Names per AI call */
export const COLOR_SHADE_BATCH_SIZE = 50;

const ColorShadeResponseSchema = z.object({
    shades: z.array(ColorShadeSchema),
});

/** Shade names that are neither curated nor learned yet */
export function findUnknownShades(names: string[], learned: LearnedColorShades): string[] {
    const unknown = names
        .map(normalizeColorName)
        .filter((name) => name && resolveShade(name, learned) === null);
    return [...new Map(unknown.map((n) => [n.toLowerCase(), n])).values()];
}

function buildMessages(
    names: string[],
    store: StoreContext
): Array<{ role: "system" | "user"; content: string }> {
    return [
        {
            role: "system",
            content:
                "You are a colour expert for e-commerce catalogs. For each colour name, give the " +
                "hex code a customer would expect to see on the product and the colour family " +
                "used in the shop's colour filter. Read the names in the context of the store.",
        },
        {
            role: "user",
            content: [
                `Store: "${store.name}"`,
                `Description: ${store.description}`,
                "",
                `Colour families: ${COLOR_FAMILY_KEYS.join(", ")}`,
                "Rules:",
                "- hex: #rrggbb, the typical colour of that name for this kind of product",
                "- family: exactly one of the families above, the one a shopper would filter by",
                '- "multicolor" only for patterns or several colours, "gold"/"silver" for metallic finishes',
                "- keep each name exactly as given",
                "",
                "Colour names:",
                ...names.map((n) => `- ${n}`),
                "",
                'Return JSON: {"shades":[{"name":"...","hex":"#rrggbb","family":"..."}]}',
            ].join("\n"),
        },
    ];
}

/** Classify one batch; names the AI skipped or got wrong fall back to the no-AI estimate */
async function classifyBatch(
    textProvider: TextProvider,
    names: string[],
    store: StoreContext
): Promise<ColorShade[]> {
    try {
        const response = await executeWithRetry(() =>
            textProvider.generateCompletion(
                buildMessages(names, store),
                ColorShadeResponseSchema,
                "ColorShades"
            )
        );
        const json = response
            .replace(/```json?\n?/g, "")
            .replace(/```\n?/g, "")
            .trim();
        const parsed = ColorShadeResponseSchema.parse(JSON.parse(json));
        const byName = new Map(parsed.shades.map((s) => [s.name.toLowerCase(), s]));
        return names.map((name) => {
            const shade = byName.get(name.toLowerCase());
            return shade ? { ...shade, name } : estimateShade(name);
        });
    } catch (error) {
        logger.warn("Colour shade classification failed, using estimates", {
            cli: true,
            data: { names, error: error instanceof Error ? error.message : String(error) },
        });
        return names.map(estimateShade);
    }
}

function chunk<T>(items: T[], size: number): T[][] {
    return Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
        items.slice(i * size, (i + 1) * size)
    );
}

/**
 * Classify unknown shade names and return the updated learned shades.
 * Known names (curated or learned) are skipped, so a re-run without new names makes
 * no AI call.
 */
export async function hydrateColorShades(
    textProvider: TextProvider,
    names: string[],
    store: StoreContext,
    learned: LearnedColorShades = {}
): Promise<LearnedColorShades> {
    const unknown = findUnknownShades(names, learned);
    if (unknown.length === 0) return learned;

    logger.info(`  Classifying ${unknown.length} new colour shade(s)...`, { cli: true });
    const result: LearnedColorShades = { ...learned };
    for (const batch of chunk(unknown, COLOR_SHADE_BATCH_SIZE)) {
        const shades = await classifyBatch(textProvider, batch, store);
        for (const shade of shades) result[shade.name.toLowerCase()] = shade;
    }
    return result;
}
