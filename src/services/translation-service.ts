/**
 * Translation Service - translate the hydrated catalog into other languages.
 *
 * English (the hydrated blueprint) is the source. Each locale is translated by a separate
 * AI pass and stored in `translations/{locale}.json`. Upload happens later, without AI,
 * in the `translations` and `reviews` post-processors.
 *
 * Returns string[] (output lines) so both CLI (prints) and MCP (joins) can consume it.
 */

import type { DataCache } from "../cache.js";
import type { Formality, LanguageSelection, TranslationSource } from "../types/index.js";

import {
    BlueprintGenerator,
    buildTranslationSource,
    collectCmsTexts,
    estimateTranslationCost,
    estimateTranslationSource,
    formatTranslationEstimate,
    generateCmsBlueprint,
    translateCatalog,
} from "../blueprint/index.js";
import { cacheFileForDisplay, createCacheFromEnv } from "../cache.js";
import {
    buildProductReviews,
    DEFAULT_DOMAIN_LOCALES,
    TRANSLATABLE_FIXTURE_TEXTS,
} from "../fixtures/index.js";
import {
    createProvidersFromEnv,
    providerConfigFromEnv,
    resolveModelSelection,
} from "../providers/index.js";
import { DataHydrator, getShopLanguages, languageOf } from "../shopware/index.js";
import { logger } from "../utils/index.js";
import { formatActualUsage } from "./blueprint-service.js";
import { createProcessorDeps } from "./shopware-context.js";
import { buildGenerationStep } from "./template-service.js";

/** Locale codes as Shopware stores them: "de-DE", "fr-CH" */
const LOCALE_PATTERN = /^([a-z]{2,3})-([a-z]{2})$/i;

/** Normalize "de-de" to "de-DE"; throws on anything that is not a full locale code */
export function normalizeLocale(value: string): string {
    const match = LOCALE_PATTERN.exec(value.trim());
    if (!match?.[1] || !match[2]) {
        throw new Error(
            `Invalid locale "${value}". Use full locale codes like de-DE, fr-FR or nl-NL.`
        );
    }
    return `${match[1].toLowerCase()}-${match[2].toUpperCase()}`;
}

/**
 * Parse a `--languages` value.
 * - "none" / "en": English only
 * - "all": every SalesChannel language (default locales for a new SalesChannel)
 * - "de-DE,fr-FR": explicit list
 *
 * Returns undefined when no value is given. Throws on invalid locale codes.
 */
export function parseLanguageSelection(value: string | undefined): LanguageSelection | undefined {
    const trimmed = value?.trim().toLowerCase();
    if (!trimmed) return undefined;
    if (trimmed === "none" || trimmed === "en") return { mode: "none" };
    if (trimmed === "all") return { mode: "all" };

    const locales = trimmed
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean)
        .map(normalizeLocale);
    return { mode: "list", locales: uniqueNonEnglish(locales) };
}

/** parseLanguageSelection for service callers: an "Error:" line instead of a throw */
export function tryParseLanguageSelection(value: string | undefined): {
    selection?: LanguageSelection;
    error?: string;
} {
    try {
        return { selection: parseLanguageSelection(value) };
    } catch (error) {
        return { error: `Error: ${error instanceof Error ? error.message : String(error)}` };
    }
}

/** Language selection from the `TRANSLATION_LANGUAGES` environment variable */
export function languageSelectionFromEnv(): LanguageSelection | undefined {
    return parseLanguageSelection(process.env.TRANSLATION_LANGUAGES);
}

function uniqueNonEnglish(locales: string[]): string[] {
    return [...new Set(locales)].filter((l) => languageOf(l) !== "en");
}

/** Non-English locales of an existing SalesChannel, or null when it cannot be read */
async function readSalesChannelLocales(salesChannelName: string): Promise<string[] | null> {
    const swEnvUrl = process.env.SW_ENV_URL;
    if (!swEnvUrl) return null;

    try {
        const dataHydrator = new DataHydrator();
        await dataHydrator.authenticateWithClientCredentials(
            swEnvUrl,
            process.env.SW_CLIENT_ID,
            process.env.SW_CLIENT_SECRET
        );
        const salesChannel = await dataHydrator.findSalesChannelByName(salesChannelName);
        if (!salesChannel) return null;

        const deps = createProcessorDeps({
            baseURL: swEnvUrl,
            getAccessToken: () => dataHydrator.getAccessToken(),
            clientId: process.env.SW_CLIENT_ID,
            clientSecret: process.env.SW_CLIENT_SECRET,
            skipProviders: true,
        });
        const languages = await getShopLanguages(deps.apiHelpers, salesChannel.id);
        return uniqueNonEnglish(languages.salesChannel.map((l) => l.locale));
    } catch (error) {
        logger.warn("Could not read SalesChannel languages, using the default locales", {
            cli: true,
            data: { error: error instanceof Error ? error.message : String(error) },
        });
        return null;
    }
}

/**
 * Locales to translate into.
 *
 * "all" uses the languages of the existing SalesChannel. A SalesChannel that does not
 * exist yet gets the default domain locales, which `generate` creates as domains.
 */
export async function resolveTargetLocales(
    selection: LanguageSelection,
    salesChannelName: string,
    readExisting: (name: string) => Promise<string[] | null> = readSalesChannelLocales
): Promise<string[]> {
    if (selection.mode === "none") return [];
    if (selection.mode === "list") return uniqueNonEnglish(selection.locales);
    return (await readExisting(salesChannelName)) ?? [...DEFAULT_DOMAIN_LOCALES];
}

/**
 * English source for the forecast: the real texts when hydrated, typical lengths otherwise.
 * Without any blueprint, an in-memory blueprint with `products` products is used.
 */
function forecastSource(
    cache: DataCache,
    salesChannelName: string,
    products: number
): TranslationSource {
    const cmsBlueprint =
        cache.loadCmsBlueprint(salesChannelName) ?? generateCmsBlueprint(salesChannelName);
    const hydrated = cache.loadHydratedBlueprint(salesChannelName);
    if (hydrated) return buildTranslationSource(hydrated, cmsBlueprint);

    const blueprint =
        cache.loadBlueprint(salesChannelName) ??
        new BlueprintGenerator({ totalProducts: products }).generateBlueprint(
            salesChannelName,
            `${salesChannelName} webshop`
        );
    const reviews = Object.fromEntries(
        blueprint.products
            .filter((p) => (p.metadata.reviewCount ?? 0) > 0)
            .map((p) => [
                p.id,
                buildProductReviews(p.id, p.name, p.metadata.reviewCount).map((r) => ({
                    title: r.title,
                    content: r.content,
                })),
            ])
    );
    return estimateTranslationSource(blueprint, {
        cms: collectCmsTexts(cmsBlueprint),
        fixtures: { ...TRANSLATABLE_FIXTURE_TEXTS },
        reviews,
    });
}

/**
 * Forecast the cost of translating the catalog into the given locales (no AI calls).
 */
export function formatTranslationForecast(
    cache: DataCache,
    salesChannelName: string,
    locales: string[],
    products = 90
): string[] {
    if (locales.length === 0) return [`Translation: English only`];

    const selection = resolveModelSelection(providerConfigFromEnv());
    const estimate = estimateTranslationCost(
        forecastSource(cache, salesChannelName, products),
        locales,
        selection
    );
    const hasPrevious = locales.some((l) => cache.loadTranslations(salesChannelName, l));
    return [
        ...formatTranslationEstimate(estimate),
        ...(cache.hasHydratedBlueprint(salesChannelName)
            ? []
            : [`  Note: not hydrated yet, the forecast uses typical text lengths`]),
        ...(hasPrevious
            ? [`  Note: unchanged texts of existing translations are reused and cost nothing`]
            : []),
    ];
}

/**
 * Forecast for `blueprint estimate --languages` and the generate prompt.
 */
export async function estimateTranslation(
    salesChannelName: string,
    selection: LanguageSelection,
    products = 90
): Promise<string[]> {
    const locales = await resolveTargetLocales(selection, salesChannelName);
    return formatTranslationForecast(createCacheFromEnv(), salesChannelName, locales, products);
}

export interface TranslateOptions {
    languages: LanguageSelection;
    /** Overrides the formality the AI picks per locale */
    formality?: Formality;
    /** Translate everything again instead of reusing unchanged entries */
    force?: boolean;
}

export interface TranslateResult {
    lines: string[];
    /** Locales that have a translation file after this run */
    locales: string[];
}

/**
 * Translate the hydrated catalog into each target locale.
 */
export async function runTranslation(
    salesChannelName: string,
    options: TranslateOptions
): Promise<TranslateResult> {
    const cache = createCacheFromEnv();
    const blueprint = cache.loadHydratedBlueprint(salesChannelName);
    if (!blueprint) {
        return {
            lines: [
                `Error: No hydrated blueprint found for "${salesChannelName}". ` +
                    `Run: blueprint hydrate --name=${salesChannelName}`,
            ],
            locales: [],
        };
    }

    const locales = await resolveTargetLocales(options.languages, salesChannelName);
    if (locales.length === 0) {
        return {
            lines: [`Translation: English only, nothing to translate`],
            locales: cache.listTranslationLocales(salesChannelName),
        };
    }

    for (const line of formatTranslationForecast(cache, salesChannelName, locales)) {
        logger.info(line, { cli: true });
    }

    const { text: textProvider } = createProvidersFromEnv();
    const selection = resolveModelSelection(providerConfigFromEnv());
    const source = buildTranslationSource(blueprint, cache.loadCmsBlueprint(salesChannelName));
    const storeDescription = blueprint.salesChannel.description || `${salesChannelName} webshop`;
    const lines: string[] = [];

    // One locale at a time: each pass already runs up to maxConcurrency calls in parallel
    for (const locale of locales) {
        logger.info(`  Translating into ${locale}...`, { cli: true });
        const result = await translateCatalog({
            textProvider,
            locale,
            storeName: salesChannelName,
            storeDescription,
            source,
            previous: cache.loadTranslations(salesChannelName, locale),
            formality: options.formality,
            force: options.force,
        });
        cache.saveTranslations(salesChannelName, result.file);
        // Only a run that translated something changes which model wrote the file
        if (result.translated > 0) {
            cache.recordGenerationStep(
                salesChannelName,
                `translate:${locale}`,
                buildGenerationStep(selection, false)
            );
        }
        lines.push(
            `  ${locale}: ${result.translated} translated, ${result.reused} reused, ` +
                `formality ${result.file.style.formality}`,
            ...formatFailedEntries(result.failed)
        );
    }

    return {
        lines: [
            ...lines,
            `  Saved to: ${cacheFileForDisplay(cache, salesChannelName, "translations")}`,
            ...formatActualUsage(textProvider, selection),
        ],
        locales: cache.listTranslationLocales(salesChannelName),
    };
}

function formatFailedEntries(failed: string[]): string[] {
    if (failed.length === 0) return [];
    const preview = failed.slice(0, 5).join(", ");
    const more = failed.length > 5 ? `, +${failed.length - 5} more` : "";
    return [
        `    ⚠ ${failed.length} entries stay English (failed twice): ${preview}${more}`,
        `      Run "blueprint translate" again to retry them`,
    ];
}

/**
 * `blueprint translate` command.
 */
export async function translateBlueprint(
    salesChannelName: string,
    options: TranslateOptions
): Promise<string[]> {
    logger.configure({ minLevel: "debug" });
    const result = await runTranslation(salesChannelName, options);
    return [`=== Blueprint Translate ===`, `Name: ${salesChannelName}`, ``, ...result.lines];
}
