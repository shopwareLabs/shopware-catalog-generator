/**
 * Image prompt guards shared by every image generation call.
 */

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
