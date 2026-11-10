/**
 * Colour normalisation - maps raw colour names to shades and families
 *
 * Pure functions, no AI. Resolution order for a shade name:
 * 1. Curated shade (fixture, including aliases and word spellings like "grey")
 * 2. Learned shade (classified by the AI for this store, `color-shades.json`)
 * 3. Image colour (Multicolor, Rainbow, ...) → family "multicolor"
 * 4. Two known colours ("Black/White", "Navy & Red") → family "multicolor"
 * Anything else is unknown and goes to the AI classifier during hydration.
 * `estimateShade` is the no-AI fallback for unknown names.
 */

import type { ColorFamily, ColorShade, LearnedColorShades } from "../types/index.js";

import { getColorFamily } from "../fixtures/color-families.js";
import { colorHasImage, COLOR_ALIASES, getCuratedShade } from "../fixtures/property-groups.js";
import { findClosestColor } from "./color-palette.js";

/** Name used for vague multi-colour values ("3 colors", "assorted colors") */
export const MULTICOLOR_NAME = "Multicolor";

/** Hex used when nothing is known about a colour */
const NEUTRAL_HEX = "#808080";

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

/** Values that describe several colours without naming them */
const VAGUE_MULTICOLOR_PATTERNS: RegExp[] = [
    /^\d+\s*colou?rs?$/i,
    /^(mixed|bright|assorted|various|multiple|many|different|all)\s+colou?rs?$/i,
    /^(various|multiple)$/i,
];

/** Separators between two colours in a combination value */
/** A hyphen without spaces is one hue ("Blue-Gray"), not a combination. */
const COMBINATION_SEPARATOR = /\s*(?:\/|&|\+|\band\b|,)\s*|\s+-\s+/i;

/** Check if a string is a #rrggbb hex code */
export function isHexColor(value: string): boolean {
    return HEX_PATTERN.test(value);
}

/** Collapse whitespace and unify spellings ("Grey" → "Gray", "Colour" → "Color") */
function cleanSpelling(raw: string): string {
    return raw
        .trim()
        .replace(/\s+/g, " ")
        .replace(/\bgrey\b/gi, "gray")
        .replace(/\bcolour(s|ed)?\b/gi, (_m, suffix: string | undefined) => `color${suffix ?? ""}`);
}

/** Title case that also capitalises after hyphens and slashes ("blue-gray" → "Blue-Gray") */
function titleCase(value: string): string {
    return value
        .toLowerCase()
        .replace(/(^|[\s\-/])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** Resolve aliases and curated casing for a single colour name (no combinations) */
function canonicalSingleName(raw: string): string {
    const cleaned = cleanSpelling(raw);
    if (!cleaned) return "";
    const alias = COLOR_ALIASES[cleaned.toLowerCase()];
    if (alias) return alias;
    const curated = getCuratedShade(cleaned);
    if (curated) return curated.name;
    return titleCase(cleaned);
}

/** Parts of a combination value when every part is a curated colour */
function knownCombinationParts(name: string): string[] | null {
    const parts = name.split(COMBINATION_SEPARATOR).map((p) => p.trim());
    if (parts.length < 2 || parts.some((p) => !p)) return null;
    const canonical = parts.map(canonicalSingleName);
    const allKnown = canonical.every((p) => getCuratedShade(p) !== undefined);
    return allKnown ? canonical : null;
}

/**
 * Normalise a raw colour value to its canonical shade name.
 *
 * - "grey" → "Gray", "navy blue" → "Navy", "off-white" → "Off White"
 * - "3 colours", "assorted colors" → "Multicolor"
 * - "black & white" → "Black/White"
 * - unknown names are title-cased ("dusty rose" → "Dusty Rose")
 */
export function normalizeColorName(raw: string): string {
    const cleaned = cleanSpelling(raw);
    if (!cleaned) return "";
    if (VAGUE_MULTICOLOR_PATTERNS.some((p) => p.test(cleaned))) return MULTICOLOR_NAME;
    const combination = knownCombinationParts(cleaned);
    if (combination) return combination.join("/");
    return canonicalSingleName(cleaned);
}

interface Hsl {
    /** Hue in degrees (0-360) */
    h: number;
    /** Saturation (0-1) */
    s: number;
    /** Lightness (0-1) */
    l: number;
}

function hexToHsl(hex: string): Hsl {
    const value = Number.parseInt(hex.slice(1), 16);
    const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => c / 255);
    const max = Math.max(r ?? 0, g ?? 0, b ?? 0);
    const min = Math.min(r ?? 0, g ?? 0, b ?? 0);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return { h: 0, s: 0, l };
    const s = d / (1 - Math.abs(2 * l - 1));
    const h =
        max === r
            ? ((g ?? 0) - (b ?? 0)) / d + 6
            : max === g
              ? ((b ?? 0) - (r ?? 0)) / d + 2
              : ((r ?? 0) - (g ?? 0)) / d + 4;
    return { h: (h * 60) % 360, s, l };
}

/** Family of a colourless (low saturation) colour by lightness */
function neutralFamily(l: number): ColorFamily {
    if (l < 0.18) return "black";
    if (l > 0.9) return "white";
    return "gray";
}

/** Family of warm hues (red to yellow): browns and beiges live here */
function warmFamily({ h, s, l }: Hsl): ColorFamily | null {
    if (h < 12 || h >= 345) return l > 0.72 ? "pink" : "red";
    if (h >= 65) return null;
    if (l > 0.88 && s < 0.6) return "white";
    if (l > 0.6 && s < 0.75) return "beige";
    if (l < 0.42 || (s < 0.45 && l < 0.6)) return "brown";
    return h < 42 ? "orange" : "yellow";
}

/** Family of the remaining hues */
function hueFamily(h: number): ColorFamily {
    if (h < 165) return "green";
    if (h < 255) return "blue";
    if (h < 290) return "purple";
    return "pink";
}

/**
 * Colour family for a hex code by hue, saturation and lightness.
 * Never returns "multicolor", "transparent", "gold" or "silver": those depend on
 * the material, not the hex code.
 */
export function familyFromHex(hex: string): ColorFamily {
    if (!isHexColor(hex)) return "gray";
    const hsl = hexToHsl(hex);
    if (hsl.l < 0.1) return "black";
    if (hsl.s < 0.15 || hsl.l > 0.96) return neutralFamily(hsl.l);
    return warmFamily(hsl) ?? hueFamily(hsl.h);
}

/**
 * Resolve a colour value to a known shade, or null when the name is unknown.
 * The returned name is the canonical (normalised) name.
 */
export function resolveShade(raw: string, learned: LearnedColorShades = {}): ColorShade | null {
    const name = normalizeColorName(raw);
    if (!name) return null;

    const curated = getCuratedShade(name);
    if (curated) return curated;

    const learnedShade = learned[name.toLowerCase()];
    if (learnedShade) return { ...learnedShade, name };

    if (colorHasImage(name)) {
        return { name, hex: getColorFamily("multicolor").hex, family: "multicolor" };
    }

    const combination = knownCombinationParts(name);
    const first = combination?.[0] ? getCuratedShade(combination[0]) : undefined;
    if (first) return { name, hex: first.hex, family: "multicolor" };

    return null;
}

/**
 * Best guess for an unknown colour without AI: closest palette match by name,
 * else a neutral gray. Used when the AI classifier is not available or failed.
 */
export function estimateShade(raw: string): ColorShade {
    const name = normalizeColorName(raw) || raw.trim();
    const match = findClosestColor(name);
    if (!match) return { name, hex: NEUTRAL_HEX, family: "gray" };
    const family = getCuratedShade(match.name)?.family ?? familyFromHex(match.hex);
    return { name, hex: match.hex, family };
}

/** Known shade, else the no-AI estimate */
export function resolveOrEstimateShade(raw: string, learned: LearnedColorShades = {}): ColorShade {
    return resolveShade(raw, learned) ?? estimateShade(raw);
}
