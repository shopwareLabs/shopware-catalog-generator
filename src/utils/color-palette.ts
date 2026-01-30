/**
 * Color Palette - Static color definitions with HEX values
 *
 * Provides a curated color palette for product properties.
 * AI can generate any color name, and we find the closest match for HEX.
 */

/**
 * Curated color palette with HEX values that look good in storefront
 */
export const COLOR_PALETTE: Record<string, string> = {
    // Neutrals
    Black: "#1a1a1a",
    White: "#ffffff",
    Gray: "#6b7280",
    Charcoal: "#374151",
    Ivory: "#fffff0",
    Cream: "#fffdd0",
    Beige: "#f5f5dc",
    Taupe: "#483c32",

    // Wood tones
    "Natural Oak": "#c9a66b",
    Oak: "#c9a66b",
    Walnut: "#5d432c",
    Cherry: "#6b2d2d",
    Mahogany: "#4a0000",
    Pine: "#d4a76a",
    Espresso: "#3c2415",
    Teak: "#b08d57",
    Ash: "#b2beb5",
    Birch: "#f5deb3",
    Maple: "#c5833b",
    Ebony: "#555d50",
    Rosewood: "#65000b",
    Cedar: "#a0522d",

    // Standard colors
    Red: "#dc2626",
    Blue: "#2563eb",
    Green: "#16a34a",
    Yellow: "#eab308",
    Orange: "#ea580c",
    Purple: "#9333ea",
    Pink: "#ec4899",
    Brown: "#78350f",

    // Rich colors
    Navy: "#1e3a5f",
    "Forest Green": "#228b22",
    Burgundy: "#722f37",
    Terracotta: "#e2725b",
    "Slate Blue": "#6a5acd",
    Olive: "#808000",
    Teal: "#008080",
    Coral: "#ff7f50",
    Indigo: "#4b0082",
    Maroon: "#800000",
    Turquoise: "#40e0d0",
    Lavender: "#e6e6fa",
    Salmon: "#fa8072",
    Mint: "#98fb98",
    Mustard: "#ffdb58",
    Plum: "#dda0dd",
    Rust: "#b7410e",
    Sand: "#c2b280",
    Sage: "#bcb88a",
    Slate: "#708090",

    // Metals
    Brass: "#b5a642",
    Bronze: "#cd7f32",
    Silver: "#c0c0c0",
    Copper: "#b87333",
    Gold: "#ffd700",
    Chrome: "#dbe4eb",
    Nickel: "#727472",
    "Brushed Steel": "#8b8d8e",

    // Fabric/Textile colors
    Denim: "#1560bd",
    Khaki: "#c3b091",
    Tan: "#d2b48c",
    Camel: "#c19a6b",
    Linen: "#faf0e6",
    "Charcoal Gray": "#36454f",
};

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

export interface ColorMatch {
    /** Original palette color name */
    name: string;
    /** HEX color code */
    hex: string;
}

/**
 * Find the closest matching color from the palette
 *
 * Uses three-tier matching:
 * 1. Exact match (case-insensitive)
 * 2. Partial match (color name contains palette entry or vice versa)
 * 3. Word-based match (any word matches)
 *
 * @param colorName - The color name to match (e.g., "Midnight Blue", "Warm Oak")
 * @returns The matching color with name and hex, or null if no match
 */
export function findClosestColor(colorName: string): ColorMatch | null {
    const normalized = colorName.toLowerCase().trim();

    if (!normalized) {
        return null;
    }

    // 1. Exact match
    for (const [name, hex] of Object.entries(COLOR_PALETTE)) {
        if (name.toLowerCase() === normalized) {
            return { name, hex };
        }
    }

    // 2. Partial match (color name contains palette entry or vice versa)
    for (const [name, hex] of Object.entries(COLOR_PALETTE)) {
        const paletteLower = name.toLowerCase();
        if (normalized.includes(paletteLower) || paletteLower.includes(normalized)) {
            return { name, hex };
        }
    }

    // 3. Word-based match (any word matches a palette color)
    const words = normalized.split(/[\s-_]+/);
    for (const [name, hex] of Object.entries(COLOR_PALETTE)) {
        const paletteWords = name.toLowerCase().split(/[\s-_]+/);
        if (words.some((w) => paletteWords.includes(w) && w.length > 2)) {
            return { name, hex };
        }
    }

    return null;
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
 * Check if a property group name suggests it's a color property
 */
export function isColorGroup(groupName: string): boolean {
    const name = groupName.toLowerCase();
    return (
        name.includes("color") || name.includes("colour") || name === "farbe" || name === "finish"
    );
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
