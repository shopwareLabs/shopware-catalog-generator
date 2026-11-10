/**
 * Color Palette - Static color definitions with HEX values
 *
 * Provides a curated color palette for product properties.
 * AI can generate any color name, and we find the closest match for HEX.
 */

import { COLOR_OPTIONS } from "../fixtures/property-groups.js";

/**
 * Curated color palette with HEX values that look good in storefront.
 * Derived from the shade fixture, so there is one source of truth for hex codes.
 */
export const COLOR_PALETTE: Record<string, string> = Object.fromEntries(
    COLOR_OPTIONS.map((c) => [c.name, c.hex])
);

/**
 * View suffixes for consistent image generation
 * Each view type has a standard suffix to append to the base prompt
 */
export const VIEW_SUFFIXES: Record<string, string> = {
    // Product context views
    lifestyle:
        "styled in modern room setting with soft natural lighting, interior design photography",
    room: "placed in elegant interior with complementary decor, lifestyle photography",
    context: "shown in real-world setting with ambient lighting, product in use",

    // Studio views
    front: "front view on white background, studio lighting, high resolution product photography",
    side: "side profile view on white background, studio lighting, clean product shot",
    angle: "three-quarter angle view on white background, studio lighting, professional product photography",
    back: "back view on white background, studio lighting, product photography",
    top: "top-down view on white background, studio lighting, flat lay photography",

    // Detail views
    detail: "close-up showing texture and material quality, macro photography, sharp focus",
    texture: "extreme close-up of surface texture and finish, macro shot",

    // Special views
    packaging: "product in branded packaging, clean presentation, studio shot",
    dimensions: "product with scale reference showing actual size, product photography",
};

/**
 * Determine the best text color (white or black) for legibility on a given background.
 *
 * Uses the WCAG 2.0 relative luminance formula. The 0.179 threshold is the
 * standard midpoint where contrast ratio 4.5:1 flips between white and black text.
 * Follows Material Design's "On" color concept.
 *
 * @param hex - Background color as #RRGGBB
 * @returns "#ffffff" for dark backgrounds, "#000000" for light backgrounds
 */
export function getContrastTextColor(hex: string): string {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;

    const toLinear = (c: number): number =>
        c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

    const luminance = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

    return luminance > 0.179 ? "#000000" : "#ffffff";
}

export interface ColorMatch {
    /** Original palette color name */
    name: string;
    /** HEX color code */
    hex: string;
}

/**
 * Find the closest matching color from the palette
 *
 * Uses three-tier matching (hyphens and underscores count as spaces):
 * 1. Exact match (case-insensitive)
 * 2. Partial match: the longest palette entry contained in the name, else the
 *    first palette entry that contains the name
 * 3. Word-based match (any word matches)
 *
 * @param colorName - The color name to match (e.g., "Midnight Blue", "Warm Oak")
 * @returns The matching color with name and hex, or null if no match
 */
export function findClosestColor(colorName: string): ColorMatch | null {
    const normalized = colorName.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    if (!normalized) return null;

    const entries = Object.entries(COLOR_PALETTE).map(([name, hex]) => ({
        name,
        hex,
        lower: name.toLowerCase(),
    }));
    const toMatch = (e: { name: string; hex: string } | undefined): ColorMatch | null =>
        e ? { name: e.name, hex: e.hex } : null;

    const exact = entries.find((e) => e.lower === normalized);
    if (exact) return toMatch(exact);

    const contained = entries
        .filter((e) => normalized.includes(e.lower))
        .sort((a, b) => b.lower.length - a.lower.length)[0];
    if (contained) return toMatch(contained);

    const containing = entries.find((e) => e.lower.includes(normalized));
    if (containing) return toMatch(containing);

    const words = normalized.split(" ").filter((w) => w.length > 2);
    return toMatch(entries.find((e) => e.lower.split(" ").some((w) => words.includes(w))));
}

/**
 * Get HEX code for a color, with fallback
 *
 * @param colorName - The color name to look up
 * @param fallback - Fallback HEX if no match found (default: gray)
 * @returns HEX color code
 */
export function getColorHex(colorName: string, fallback: string = "#808080"): string {
    const match = findClosestColor(colorName);
    return match?.hex ?? fallback;
}

/**
 * Get the view suffix for a given image view type
 *
 * @param view - The view type (e.g., "front", "lifestyle")
 * @returns The suffix to append to the base prompt
 */
export function getViewSuffix(view: string): string {
    const normalized = view.toLowerCase().trim();
    return VIEW_SUFFIXES[normalized] ?? VIEW_SUFFIXES.front ?? "";
}

/**
 * Generate a complete image prompt from base description and view
 *
 * @param basePrompt - The base product description
 * @param view - The view type
 * @returns Complete prompt for image generation
 */
export function buildImagePrompt(basePrompt: string, view: string): string {
    const suffix = getViewSuffix(view);
    return `${basePrompt}, ${suffix}`;
}
