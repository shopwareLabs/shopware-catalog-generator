# Fixtures Documentation

Internal documentation for AI agents working on the fixtures module.

## Overview

Fixtures contain static, pre-defined data configurations used by post-processors and other modules. They exist to keep processor code clean and to ensure consistent, deterministic content.

## Module Structure

```
fixtures/
├── types.ts              # Fixture type definitions (CmsPageFixture, etc.)
├── index.ts              # Re-exports all fixtures
├── cms/                  # CMS page fixtures
│   ├── index.ts          # Re-exports all CMS fixtures
│   ├── home-listing.ts   # Home listing page (root category)
│   ├── testing-placeholder.ts  # Testing entry page
│   ├── welcome.ts        # CMS Element Showcase page
│   ├── text.ts           # Text elements page
│   ├── images.ts         # Image elements page
│   ├── video.ts          # Video elements page
│   ├── text-images.ts    # Text & Images page
│   ├── commerce.ts       # Commerce elements page
│   └── form.ts           # Form elements page
├── custom-fields.ts      # Product custom field set (catalog_generator: cg_featured, cg_launch_year, cg_internal_note)
├── demo-customers.ts     # Demo customer accounts + B2B group, B2B accounts are business accounts (company, VAT ID)
├── digital-products.ts   # Gift card fixture (GIFT_CARD_50)
├── footer-navigation.ts  # Footer category trees + legal pages (cms-footer-pages), FOOTER_CATEGORY_NAMES
├── locale-currencies.ts  # Locale → currency for extra domains, DEFAULT_DOMAIN_LOCALES (de-DE)
├── packaging-units.ts    # Units (pc, kg, m) and packaging options (Pair, Pack, Box, ...) for reference prices
├── promotions.ts         # Demo promotions (WELCOME10, SUMMER20, SAVE15, FREESHIP)
├── property-groups.ts    # Universal property groups (Color with hex codes)
├── review-data.ts        # Reviewer names, review templates, buildProductReviews (seeded, stable across runs)
├── shopware-features.ts  # Feature → first Shopware version, MIN_SUPPORTED_SHOPWARE_VERSION
├── translatable-texts.ts # Fixture texts translated with the catalog (see below)
└── color-images/         # SVG color swatch images
    ├── gradient.svg
    ├── rainbow.svg
    ├── multicolor.svg
    ├── patterned.svg
    └── assorted.svg
```

## Key Conventions

### CMS Page Fixtures

Each CMS page fixture defines the complete page structure:

```typescript
export const TEXT_ELEMENTS_PAGE: CmsPageFixture = {
    name: "Text Elements",
    type: "page",
    sections: [
        {
            type: "default",
            blocks: [
                {
                    type: "text",
                    slots: [{ type: "text", config: { content: { value: "..." } } }],
                },
            ],
        },
    ],
};
```

### Why Fixtures?

- **No AI calls in post-processors:** All content is pre-defined, making Phase 3 fast and deterministic
- **Reusable:** Same content across all SalesChannels
- **Testable:** Fixture data can be unit tested for structure validity
- **Maintainable:** Content changes are isolated from processor logic

## promotions.ts

Pre-defined discount codes used by the `promotions` post-processor and displayed on the homepage:

```typescript
import { PROMOTIONS, PromotionDefinition } from "../fixtures/index.js";

// PROMOTIONS: readonly PromotionDefinition[]
// - WELCOME10: 10% off cart
// - SUMMER20:  20% off cart (max $50)
// - SAVE15:    $15 flat off cart
// - FREESHIP:  100% off delivery (free shipping)
```

`PromotionDefinition` fields: `name`, `code`, `discountType` (`"percentage" | "absolute"`),
`discountValue`, `scope` (`"cart" | "delivery"`), optional `maxValue`, optional `freeShipping`.

> **Note:** Demo promotions are global (not scoped to a SalesChannel). Cleanup deletes them
> by code across all SalesChannels. This is intentional — promotion codes are store-wide.
> Names are translated, so never look promotions up by name.

## translatable-texts.ts

English texts that post-processors write to Shopware and that `blueprint translate` rewrites
per locale (`fixtures` in `translations/{locale}.json`, with a source hash per key in
`fixtureHashes` so changed texts are re-translated). Placeholders like `{name}` are filled at
upload time with `localizedFixtureText(key, texts, values)`, which falls back to English.

| Key                                 | Used for                                          |
| ----------------------------------- | ------------------------------------------------- |
| `manufacturer.description`          | Manufacturer description                          |
| `promotion.<CODE>.name`             | Promotion names                                   |
| `unit.<shortCode>.name / shortCode` | Packaging units (non-system languages only)       |
| `packaging.<label>`                 | Product `packUnit` / `packUnitPlural`             |
| `media.productImage.<view>`         | Product image alt/title (`productMediaTexts`)     |
| `footer.category.<name>`            | Footer category names (non-system languages only) |
| `home.*`                            | Homepage hero and reference text (cms-home)       |

Units and footer categories are looked up by short code / name, so their system-language
row stays English. Units are global: a German translation also applies to other
SalesChannels that use the same unit.

## Adding a New Fixture

1. Create the fixture file in `src/fixtures/` (or `src/fixtures/cms/` for CMS pages)
2. Define the fixture as a typed constant
3. Export from `src/fixtures/index.ts`
4. Import in the consuming processor or module

## Testing

Fixtures are indirectly tested through post-processor tests. If a fixture has complex logic (like `buildProductReviews()`), add direct unit tests.
