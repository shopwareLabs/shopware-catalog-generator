# Blueprint Module Documentation

Internal documentation for AI agents working on the blueprint module.

## Overview

The blueprint module implements Phases 1 and 2 of the 3-phase pipeline:

- **Phase 1 (Generator):** Create a complete structure without AI calls (~100ms)
- **Phase 2 (Hydrator):** Fill the structure with AI-generated content (parallel)

## Module Structure

```
blueprint/
├── generator.ts          # BlueprintGenerator - Phase 1 (no AI)
├── hydrator.ts           # BlueprintHydrator - Phase 2 orchestrator
├── fix-placeholders.ts   # Fix incomplete hydration (placeholder names)
├── variant-resolver.ts   # Variant configuration resolution via cache + AI
├── index.ts              # Re-exports
└── hydrators/            # Specialized hydration modules
    ├── category.ts       # Category names/descriptions via AI
    ├── product.ts        # Product content via AI (parallel branches)
    ├── cms.ts            # CMS blueprint generation and AI text hydration
    ├── image.ts          # Product/category/CMS/theme image pre-generation + trimAndResize
    ├── theme.ts          # AI brand color generation (primary + secondary)
    └── index.ts          # Re-exports
```

## Key Classes

### BlueprintGenerator

Creates the complete structure instantly without AI:

- 3 top-level categories (configurable via `BlueprintConfig`)
- 3 levels deep with 3-5 subcategories per level
- ~30 products per top-level branch (90 total default)
- Random metadata: prices, review counts, variant flags, image views
- Cross-category assignments for realistic distribution
- Storefront flags: `isTopseller` (~10%), `isNew` (~15%), `isShippingFree` (~8%)
- Physical attributes: `weight` (0.1-25kg), `width`/`height`/`length` (mm)
- Product identifiers: **collision-resistant EAN-13** (generated via `generateNumericHash` for 12 unique digits + check digit), manufacturer number
- Purchase constraints: `minPurchase`/`purchaseSteps` (~5%), `maxPurchase` (~10%)
- **No `releaseDate` in blueprint** — `isNew` products do not store a date in the blueprint. Phase 3 (`hydrateEnvWithProductsDirect`) sets `releaseDate = new Date().toISOString()` at upload time so the "New" badge is always fresh on the storefront and never ages out
- **Deterministic `deliveryTimeIndex`** — round-robin across `DELIVERY_TIME_SLOTS` by product index, ensuring idempotent Phase 3 uploads

```typescript
const generator = new BlueprintGenerator({ totalProducts: 90 });
const blueprint = generator.generateBlueprint("music", "Musical instruments");
// Output: blueprint.json (no AI calls, instant)
```

### BlueprintHydrator

Orchestrates AI hydration of the blueprint:

1. **Categories + Brand Colors:** Names/descriptions via `hydrateCategories()`, colors via `hydrateBrandColors()` (parallel)
2. **Products:** Names, descriptions, properties via `ProductHydrator`
3. **Variants:** Property group resolution via `VariantResolver`
4. **CMS:** Text content via `hydrateCmsBlueprint()`
5. **Images:** Product, category, CMS, and theme images via `hydrateProductImages()` / `hydrateCmsImages()` / `hydrateThemeMedia()`

**Brand color resilience:** `hydrateBrandColors()` catches all parse/schema errors and returns safe fallback colors (`#0070f3` / `#7928ca`) instead of throwing. One bad AI response cannot abort full hydration.

Supports selective re-hydration modes:

- `categories` — Only update category names/descriptions
- `properties` — Only update product properties (preserves names for image stability)
- `cms` — Only hydrate CMS text blueprint

### VariantResolver

Resolves variant configurations using a two-tier cache:

1. Check store-scoped property cache (`generated/sales-channels/{store}/properties/`)
2. Check universal property cache (`generated/properties/`)
3. Fall back to AI generation if not cached

## Hydration Flow

```
Blueprint (Phase 1)
    │
    ├── hydrateCategories()       → Category names + descriptions  ┐
    ├── hydrateBrandColors()      → Brand colors (hex codes)       ┘ parallel (Promise.all)
    │
    ├── ProductHydrator.hydrate() → Product names + descriptions + properties + SEO metadata
    │   └── VariantResolver       → Variant configs from cache or AI
    │
    ├── hydrateCmsBlueprint()     → CMS page text content
    │
    ├── hydrateCmsImages()        → CMS block images → cache          ┐ each awaited in turn,
    ├── hydrateProductImages()    → Product + category images → cache ┤ but internally parallel
    └── hydrateThemeMedia()       → Logo, favicon, share icon → cache ┘ up to maxConcurrency
```

**Parallelism notes:**

- `hydrateCategories` and `hydrateBrandColors` run in parallel via `Promise.all` (both are fast single AI calls)
- Each image hydration function runs its own requests in parallel internally, up to `imageProvider.maxConcurrency`
- The three functions are called one after the other (not in a `Promise.all`) to avoid all three competing for the same rate-limit slots simultaneously

All image generation happens here in Phase 2. Post-processors in Phase 3 only upload from cache.

### Image Post-Processing (`trimAndResize`)

AI image generators (e.g. OpenAI) only support fixed canvas sizes (1024x1024, 1536x1024, etc.).
For theme media that requires exact dimensions, `trimAndResize()` uses `sharp` to:

1. **Trim** whitespace borders from the AI-generated image
2. **Resize** to the exact target dimensions (with `contain` fit, white background)
3. **Convert** to WebP format

Applied automatically to all theme media during `hydrateThemeMedia()`:

| Asset           | Target Size | Notes                       |
| --------------- | ----------- | --------------------------- |
| `store-logo`    | 474×70      | 2× of Shopware's 237×35 ref |
| `store-favicon` | 96×96       | Browser favicon             |
| `store-share`   | 1200×630    | OG/social media card        |

Brand colors from `hydrateBrandColors()` are passed to `hydrateThemeMedia()` and included
in image generation prompts for visual consistency across theme assets.

## Testing

```bash
bun test tests/unit/blueprint/
bun test tests/integration/blueprint.test.ts
```
