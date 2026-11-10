/**
 * Image prompt helpers shared by every image generation call.
 */

import type { ProductProperty } from "../types/index.js";

import { normalizeColorName } from "./color-normalize.js";

/**
 * Instruction appended to every image prompt. Image models tend to put real brand
 * names on packaging (for example on supplement bottles), which must not end up in
 * public demo catalogs. Text the prompt explicitly asks for, such as the store name
 * in a logo, stays allowed.
 */
export const FICTIONAL_BRANDING_INSTRUCTION =
    "Any brand names, logos or label text shown must be invented and fictional. " +
    "Do not show real-world brands, trademarks, company names or recognizable logos, " +
    "apart from text this prompt explicitly asks for.";

/**
 * Add the fictional branding instruction to an image prompt. Idempotent.
 *
 * Applied where image prompts are built, so cached image metadata stores the exact
 * prompt that was sent. The staleness check only compares the text before the first
 * comma, so the suffix does not affect it.
 */
export function withFictionalBranding(prompt: string): string {
    const trimmed = prompt.trim();
    if (trimmed.endsWith(FICTIONAL_BRANDING_INSTRUCTION)) return trimmed;
    const separator = /[.!?]$/.test(trimmed) ? " " : ". ";
    return `${trimmed}${separator}${FICTIONAL_BRANDING_INSTRUCTION}`;
}

/** Value of a property group (case-insensitive), or undefined */
function propertyValue(properties: ProductProperty[], group: string): string | undefined {
    return properties.find((p) => p.group.toLowerCase() === group)?.value;
}

/** The value when the product name does not already mention it */
function missingFromName(productName: string, value: string | undefined): string | undefined {
    if (!value || productName.toLowerCase().includes(value.toLowerCase())) return undefined;
    return value;
}

/**
 * Consistent base image prompt from the product name and its material, colour and
 * style, e.g. "Lounge Chair, Oak construction, Navy finish, Modern design".
 * Values the name already mentions are left out.
 */
export function buildBaseImagePrompt(productName: string, properties: ProductProperty[]): string {
    const material = missingFromName(productName, propertyValue(properties, "material"));
    const color = missingFromName(productName, propertyValue(properties, "color"));
    const style = missingFromName(productName, propertyValue(properties, "style"));

    return [
        productName,
        material && `${material} construction`,
        color && `${normalizeColorName(color) || color} finish`,
        style && `${style} design`,
    ]
        .filter(Boolean)
        .join(", ");
}
