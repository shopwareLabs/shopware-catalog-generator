# Plan: Multi-language catalogs (AI translation pass)

Status: implemented on `feat/translations`, 2026-11-06. Differences from the draft are noted inline. Belongs to roadmap
step 5 (template regeneration), because templates must be regenerated once with
translations included.

## Goal

A generated store has native-sounding content in every language its SalesChannel uses,
not just the default language. English stays the source of truth. Other languages are
produced by an extra AI pass that rewrites the English JSON for that market. The pass
adapts the text instead of translating it word for word.

## Decisions

| Question                            | Decision                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Template languages                  | English and German (`en-GB` source + `de-DE`)                                                                                    |
| Missing languages during `generate` | The user decides after seeing the cost forecast: interactive prompt in a terminal, `--languages` flag elsewhere                  |
| Product names                       | Localise where it reads naturally, keep names that cannot be translated (the model decides per name, following the prompt rules) |
| Reviews                             | Translated, spread across languages                                                                                              |

## Current state

- `createSalesChannel()` in `src/shopware/hydrator.ts` hardcodes two domains: Storefront
  language + USD, and `de-DE` + EUR. The German domain shows English content.
- Blueprints, `cms-blueprint.json` and fixtures hold a single language. Nothing writes
  `translations` to Shopware.
- Post-processors must not call AI (enforced by `no-ai-in-processors.test.ts`), so all
  translation has to happen in Phase 2.
- The CLI has no interactive prompts yet.

## Design

### 1. English first, then a translate pass

Hydration is unchanged and still produces English. A new step `blueprint translate`
reads the hydrated English data and writes one file per locale. This is better than
generating every language directly:

- One content model: names, properties, variants and images are decided once.
- Languages can be added later without touching the English data, so product names
  and the images derived from them stay stable.
- It is cheap: about 10 to 15 text calls per language for 90 products, plus reviews.

### 2. Separate translation files, keyed by entity ID

```
generated/sales-channels/{name}/
├── hydrated-blueprint.json          # unchanged, English
├── cms-blueprint.json               # unchanged, English
└── translations/
    ├── index.json                   # { locales: ["de-DE"], source: "en-GB" }
    └── de-DE.json
```

```jsonc
// translations/de-DE.json
{
    "locale": "de-DE",
    "style": { "formality": "informal" }, // du vs Sie, set once per store
    "translatedAt": "...",
    "glossary": { "Hiking Boots": "Wanderschuhe" }, // shared terms, see section 5
    "categories": { "<id>": { "name": "...", "description": "...", "sourceHash": "a1b2c" } },
    "products": {
        "<id>": { "name": "...", "description": "...", "metaTitle": "...", "sourceHash": "..." },
    },
    "propertyGroups": { "<id>": { "name": "...", "options": { "<optionId>": "..." } } },
    "manufacturers": { "<id>": { "description": "..." } },
    "reviews": { "<reviewKey>": { "title": "...", "content": "..." } },
    "cms": { "<pageKey>.<slotKey>": { "...": "..." } },
    "media": { "<mediaKey>": { "alt": "...", "title": "..." } },
    "fixtures": { "<fixtureKey>": { "...": "..." } },
}
```

- `sourceHash` (from `createShortHash` over the English fields) shows which entries
  are out of date after an English re-hydration. Only those entries are translated again.
- Templates can ship any subset of locales. Old templates without `translations/` still work.
- A Zod schema in `src/types/translation.ts` validates each file on load.
- Reviews need stable English source texts in the cache first. Today the review processor
  composes them from `review-data.ts` templates at upload time. The English reviews per
  product are therefore generated deterministically during hydration and stored, so they
  can be translated (still no AI in the processor).

### 3. Which languages: the SalesChannel decides, the user confirms the cost

Languages are chosen at two points:

| Time                    | Source of the language list                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Translate (Phase 2, AI) | `--languages`, else `TRANSLATION_LANGUAGES` env, else the SalesChannel's languages (existing channel) or `de-DE` (new channel) |
| Upload (Phase 3, no AI) | The languages actually assigned to the SalesChannel in Shopware                                                                |

At upload, each SalesChannel language falls into one of these cases:

- **A translation file exists:** its content is sent as `translations`.
- **No translation file, inside `generate`:** the user decides, based on the cost forecast
  (below). This is still Phase 2, before any post-processor runs.
- **No translation file, inside `process` alone:** a warning is logged and Shopware falls
  back to the system language.

#### The user chooses based on the cost forecast

Before translating, `generate` and `blueprint translate` list the missing languages with
their forecast cost from `cost-estimator.ts`:

```
Translations missing for SalesChannel "music":
  de-DE   ~45k tokens   ~$0.03
  fr-FR   ~45k tokens   ~$0.03
  Total   ~90k tokens   ~$0.06
? Translate: (1) English only  (2) all SalesChannel languages  (3) choose
```

- **Interactive (TTY):** prompt as above, using `node:readline/promises`. The prompt lives
  only in `src/cli/`. Services receive the resolved language list and never prompt.
- **Non-interactive (MCP, CI, scripts):** the `--languages` flag decides: `none` (English
  only), `all` (every SalesChannel language), or a list such as `de-DE,fr-FR`. If the flag
  is missing, nothing is translated, and a warning shows the forecast and the flag to use.
  This avoids unexpected cost. `test-e2e.sh` passes `--languages=all`.
- **MCP:** `blueprint_estimate` returns the per-language forecast. `generate` and
  `blueprint_translate` take a `languages` parameter with the same values, so the assistant
  can show the cost and ask the user before calling.

#### Domains

For new SalesChannels, the hardcoded German domain becomes a domain list built from the
translated locales: one domain per locale that is installed in Shopware (`getLanguageId`
plus `getSnippetSetId`). The URL is `{name}-{lang}.{host}`. A small fixture maps each locale
to a currency (de/fr/es/it/nl → EUR, en-GB → GBP, …) and falls back to the default currency.
A locale that is not installed is skipped with a warning, as `de-DE` is today. Languages
are never installed automatically. That needs language packs and is out of scope.

### 4. Shopware write format

- Use locale-keyed `translations` in the sync payload, for example
  `translations: { "en-GB": {...}, "de-DE": {...} }`. Shopware's translation serializer
  accepts both locale codes and language IDs as keys.
- **Watch out for the system language.** Root fields are written in the system default
  language, which is not always English. A shop installed in German has `de-DE` as its
  system language. Read the system language once per run and put the matching content
  into the root fields. Put everything else, including English, into `translations`.
  Without this, a German-default shop shows English as "German".
- Translatable entities in scope: product (name, description, meta*, keywords, OG fields),
  category (name, description, meta*), property_group and option (name), manufacturer
  (description; the name stays as-is), media (alt, title), cms_page (name), cms_slot
  (`config` per language), promotion (name), unit and packaging unit, custom-field labels
  (already locale-keyed in fixtures).
- **Reviews:** `product_review` has one `languageId` and no `translations`.
  _Implemented differently from the draft:_ reviews are not duplicated per language. Review
  _i_ of a product is written in SalesChannel language _i % n_, with the translated title and
  content when a translation exists. A real multi-language shop also has reviews in different
  languages, and the total count and average rating stay what the blueprint says. Review IDs
  are derived from (product, review index), so re-runs upsert the same rows. English reviews
  are built deterministically from `review-data.ts` with a seeded PRNG instead of being moved
  into hydration.
- Version gating: none needed, translations have been in the DAL since 6.0.

### 5. The prompt: native copy, not literal translation

The system prompt for each locale says, roughly:

> You are a native {language} ({region}) e-commerce copywriter. Rewrite the following
> store content for shoppers in {region}. Do not translate word for word: use phrasing,
> idioms and sentence rhythm a native copywriter would write. Address the reader
> {formally/informally} consistently. Localise product names so they read naturally in
> {language}: translate the generic part (product type, material, descriptive words),
> keep coined brand or product-line names that have no meaningful translation, and keep
> words natives commonly use in English anyway. Use local conventions for units, number
> and date formats. Keep HTML tags and structure exactly. Use the glossary terms exactly
> as given. Return only JSON matching the schema, keyed by the given IDs.

Reviews get a variant of the prompt: write them like a real customer from {region}
would, in casual everyday language, keeping the rating's sentiment.

Supporting rules:

- **Glossary first.** One call translates category names, property group and option names
  into `glossary`. Every later batch receives the glossary, so "Hiking Boots" is the same
  word in the category name, the filter and the product text.
- **Batching by category branch**, using the same branching as `ProductHydrator`, and capped
  by `tokenLimit`. Input and output are `{id: fields}` maps only, never the whole blueprint.
- **Formality per store.** The default is chosen once per locale by the AI from the store
  description (for example a playful brand gets "du"). `--formality=formal|informal`
  overrides it. The choice is stored in the file so later batches stay consistent.
- **Cheap checks, no second AI pass by default:** every ID is present, the HTML tag set
  matches the source, descriptions are not identical to the English source (names may
  be, since some stay unchanged), and the length ratio is plausible. A failed batch is
  retried once. An optional `--review` pass, in which a second "native editor" call
  polishes the output, can follow later if the quality is not good enough.
- **Store-type agnostic.** No hardcoded domain examples in the prompt (AGENTS.md rule).

## Implementation steps

1. **Types and storage.** `src/types/translation.ts` (Zod schema),
   `DataCache.loadTranslations / saveTranslations`, `TemplateFetcher` copies `translations/`.
2. **English reviews in the cache.** Move review text selection from the processor into
   hydration (deterministic, from `review-data.ts`), stored per product.
3. **Translator.** `src/blueprint/hydrators/translation.ts`: glossary call, batched
   product/category/review/CMS/fixture calls, source-hash diffing, validation and retry.
   Uses `executeWithRetry` and `ConcurrencyLimiter` like the other hydrators.
4. **Cost estimate.** Add a `translate` call type per locale to `cost-estimator.ts`, so
   `blueprint estimate --languages=…` and the language prompt can show it.
5. **CLI and MCP.** `blueprint translate --name --languages=none|all|<list>
   [--only=products|categories|reviews|cms] [--formality] [--force]`. Add the interactive
   language prompt (TTY only) in `src/cli/`, the `blueprint_translate` MCP tool and the
   `languages` parameter on `generate`, the service function in `blueprint-service.ts`,
   and the translate step in `generate-service.ts`.
6. **Upload.** Add a translation payload builder (pure function, unit-tested) and handle
   the system language. Wire it into product/category/property sync and the CMS,
   manufacturer, media, promotion and review processors (they read from cache, no AI).
7. **SalesChannel languages.** Replace the hardcoded `de-DE` domain with a locale-driven
   domain list, plus the locale → currency fixture. For an existing SalesChannel, read its
   languages from Shopware.
8. **Fixtures.** Add hand-written `de-DE` text for units, packaging units, promotions and
   footer and legal pages. Other locales get these through the translate pass under the
   `fixtures` namespace.
9. **Tests and e2e.**
    - Unit tests: the schema, hash diffing, prompt content, language resolution
      (`none`/`all`/list, TTY vs non-TTY), the payload builder (including a non-English
      system language), review fan-out and idempotency, and the domain list.
    - `verify.ts` requests a product through the Store API with `sw-language-id` set to each
      language and checks that the description differs from English and the reviews exist
      in each language.
    - Run on the lane matrix.
10. **Templates.** Regenerate `shopware-catalog-templates` with `en-GB` + `de-DE`. This is
    the final step of the roadmap.

Steps 1 to 6 already give a working German store on today's German domain. Step 7
generalises it to any language. Following your preference, this can still be one PR.
