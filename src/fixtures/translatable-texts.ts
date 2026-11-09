/**
 * Translatable fixture texts.
 *
 * English texts that post-processors write to Shopware and that the translate pass
 * rewrites per locale (stored under `fixtures` in `translations/{locale}.json`).
 * Placeholders like `{name}` are kept by the translator and filled at upload time.
 */

export const TRANSLATABLE_FIXTURE_TEXTS = {
    "manufacturer.description": "{name} is a trusted manufacturer of quality products.",
} as const;

export type TranslatableFixtureKey = keyof typeof TRANSLATABLE_FIXTURE_TEXTS;

/**
 * Replace `{placeholder}` tokens in a fixture text.
 */
export function fillFixtureText(template: string, values: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
