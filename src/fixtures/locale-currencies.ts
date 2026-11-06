/**
 * Currency per storefront locale, used for the extra language domains of a new
 * SalesChannel. Exact locale first, then the language. Unknown locales use the
 * Storefront's default currency.
 */

export const LOCALE_CURRENCIES: Readonly<Record<string, string>> = {
    "en-GB": "GBP",
    "en-US": "USD",
    "de-CH": "CHF",
    "fr-CH": "CHF",
    "it-CH": "CHF",
    de: "EUR",
    fr: "EUR",
    es: "EUR",
    it: "EUR",
    nl: "EUR",
    pt: "EUR",
    fi: "EUR",
    pl: "PLN",
    cs: "CZK",
    da: "DKK",
    sv: "SEK",
    nb: "NOK",
    no: "NOK",
    tr: "TRY",
    ja: "JPY",
};

/** Default domain locales of a new SalesChannel (besides the English Storefront language) */
export const DEFAULT_DOMAIN_LOCALES: readonly string[] = ["de-DE"];

/** ISO currency code for a locale, or null when unknown */
export function currencyForLocale(locale: string): string | null {
    const language = locale.split("-")[0]?.toLowerCase() ?? "";
    return LOCALE_CURRENCIES[locale] ?? LOCALE_CURRENCIES[language] ?? null;
}
