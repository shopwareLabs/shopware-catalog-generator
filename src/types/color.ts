/**
 * Colour types - two levels like real shops
 *
 * - Shade: the specific colour name shown on the product detail page ("Navy", "Burgundy").
 *   Lives in the "Color" property group (variant options, swatches).
 * - Family: one of 16 fixed colour families shown in the listing filter ("Blue", "Red").
 *   Lives in the "Color family" property group.
 */

import { z } from "zod";

/**
 * The 16 colour families.
 *
 * The 11 basic colour terms of Berlin and Kay (1969) plus the five that commerce filters
 * add on top (Beige, Gold, Silver, Multicolor, Transparent).
 */
export const COLOR_FAMILY_KEYS = [
    "black",
    "white",
    "gray",
    "red",
    "orange",
    "yellow",
    "green",
    "blue",
    "purple",
    "pink",
    "brown",
    "beige",
    "gold",
    "silver",
    "multicolor",
    "transparent",
] as const;

export type ColorFamily = (typeof COLOR_FAMILY_KEYS)[number];

export const ColorFamilySchema = z.enum(COLOR_FAMILY_KEYS);

/** A shade with its hex code and family */
export interface ColorShade {
    /** Canonical shade name (e.g. "Navy") */
    name: string;
    /** Hex code (#rrggbb) */
    hex: string;
    /** Colour family the shade belongs to */
    family: ColorFamily;
}

/**
 * Store-specific shades classified by the AI, keyed by lower-case shade name.
 * Stored per SalesChannel in `color-shades.json`.
 */
export type LearnedColorShades = Record<string, ColorShade>;

export const ColorShadeSchema = z.object({
    name: z.string().min(1),
    hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    family: ColorFamilySchema,
});

export const LearnedColorShadesSchema = z.record(z.string(), ColorShadeSchema);
