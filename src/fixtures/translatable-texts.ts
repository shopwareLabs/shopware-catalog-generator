/**
 * Translatable fixture texts.
 *
 * English texts that post-processors write to Shopware and that the translate pass
 * rewrites per locale (stored under `fixtures` in `translations/{locale}.json`).
 * Placeholders like `{name}` are kept by the translator and filled at upload time.
 */

import { FOOTER_CATEGORY_NAMES } from "./footer-navigation.js";
import { PACKAGING_OPTIONS, PACKAGING_UNITS } from "./packaging-units.js";
import { PROMOTIONS } from "./promotions.js";

/** Product image views, mirrors `ImageView` in types/blueprint.ts */
export const PRODUCT_IMAGE_VIEWS = ["front", "side", "detail", "lifestyle", "packaging"] as const;

/** Texts of the generated homepage (cms-home). HTML is kept, URLs are placeholders. */
const HOME_TEXTS: Record<string, string> = {
    "home.welcome": "Welcome to the {name} Demo-Store!",
    "home.generatedWith":
        'This store was generated with the&nbsp;<a target="_blank" href="{generatorUrl}" rel="noopener">shopware-catalog-generator</a>.<br>The prompt to <b>generate</b> this store was:',
    "home.counts": "It includes {productCount} Products and {categoryCount} Categories.",
    "home.featuresHeading": "Supported Features:",
    "home.feature.productTypes": "Simple Products,&nbsp;Variant Products and&nbsp;Digital Product",
    "home.feature.crossSelling": "Products have Properties, Images and Cross-Selling",
    "home.feature.properties": "Products have Properties and Images",
    "home.feature.customers": "Demo Customer Accounts with B2B Customer Group",
    "home.feature.promotions": "Promotion Codes and Tiered Quantity Pricing",
    "home.feature.cms": "CMS-Pages and all CMS-Elements for Testing",
    "home.feature.layouts": "Both default Category-Layouts with Pagination",
    "home.links":
        'The linked <a target="_blank" href="{templatesUrl}" rel="noopener">catalog templates</a> provide reusable setups for different store types. See the <a target="_blank" href="{readmeUrl}" rel="noopener">README</a> for technical details.',
    "home.accountsHeading": "Demo Accounts",
    "home.column.email": "Email",
    "home.column.password": "Password",
    "home.column.group": "Group",
    "home.group.b2b": "B2B (net prices)",
    "home.group.standard": "Standard",
    "home.promotionsHeading": "Promotion Codes",
    "home.column.code": "Code",
    "home.column.discount": "Discount",
    "home.discount.freeShipping": "Free Shipping",
    "home.discount.percentage": "{value}% off",
    "home.discount.percentageMax": "{value}% off (max {max})",
    "home.discount.absolute": "{amount} off",
    "home.enjoy": "Enjoy this <b>{name}</b> demo-store.&nbsp;\u{1F607}",
};

function promotionTexts(): Record<string, string> {
    return Object.fromEntries(PROMOTIONS.map((p) => [`promotion.${p.code}.name`, p.name]));
}

function unitTexts(): Record<string, string> {
    return Object.fromEntries(
        PACKAGING_UNITS.flatMap((u) => [
            [`unit.${u.shortCode}.name`, u.name],
            [`unit.${u.shortCode}.shortCode`, u.shortCode],
        ])
    );
}

function packagingTexts(): Record<string, string> {
    return Object.fromEntries(
        PACKAGING_OPTIONS.flatMap((o) => [o.packUnit, o.packUnitPlural]).map((label) => [
            packagingTextKey(label),
            label,
        ])
    );
}

function productImageTexts(): Record<string, string> {
    return Object.fromEntries(
        PRODUCT_IMAGE_VIEWS.map((view) => [productImageTextKey(view), `{name} (${view} view)`])
    );
}

function footerTexts(): Record<string, string> {
    return Object.fromEntries(FOOTER_CATEGORY_NAMES.map((name) => [footerTextKey(name), name]));
}

export const TRANSLATABLE_FIXTURE_TEXTS: Readonly<Record<string, string>> = {
    "manufacturer.description": "{name} is a trusted manufacturer of quality products.",
    ...promotionTexts(),
    ...unitTexts(),
    ...packagingTexts(),
    ...productImageTexts(),
    ...footerTexts(),
    ...HOME_TEXTS,
};

/** Key of a packaging label ("Pack", "Packs") */
export function packagingTextKey(label: string): string {
    return `packaging.${label}`;
}

/** Key of the alt text template for a product image view */
export function productImageTextKey(view: string): string {
    return `media.productImage.${view}`;
}

/** Key of a footer category name */
export function footerTextKey(name: string): string {
    return `footer.category.${name}`;
}

/**
 * Replace `{placeholder}` tokens in a fixture text.
 */
export function fillFixtureText(template: string, values: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * Fixture text in the given language, with placeholders filled.
 *
 * Falls back to English when `texts` has no entry for the key (missing or failed
 * translation), and to the key itself for unknown keys.
 */
export function localizedFixtureText(
    key: string,
    texts: Readonly<Record<string, string>> | null | undefined,
    values: Record<string, string> = {}
): string {
    const template = texts?.[key] ?? TRANSLATABLE_FIXTURE_TEXTS[key] ?? key;
    return fillFixtureText(template, values);
}

/**
 * Alt text and title of a product image, e.g. "Oak Desk (front view)".
 * Screen readers and image search use the alt text; the title shows as tooltip.
 */
export function productMediaTexts(
    productName: string,
    view: string,
    texts: Readonly<Record<string, string>> | null = null
): { alt: string; title: string } {
    const text = localizedFixtureText(productImageTextKey(view), texts, { name: productName });
    if (text !== productImageTextKey(view)) return { alt: text, title: text };
    // Unknown view: no template, use the English pattern
    const fallback = `${productName} (${view} view)`;
    return { alt: fallback, title: fallback };
}

/**
 * Alt text and title for a colour variant image: the parent image text with the shade,
 * e.g. "Oak Desk, Burgundy (front view)".
 */
export function variantMediaTexts(
    productName: string,
    view: string,
    shade: string,
    texts: Readonly<Record<string, string>> | null = null
): { alt: string; title: string } {
    return productMediaTexts(`${productName}, ${shade}`, view, texts);
}
