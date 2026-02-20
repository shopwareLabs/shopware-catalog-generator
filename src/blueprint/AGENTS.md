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
    ├── image.ts          # Product/category/CMS image pre-generation
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

```typescript
const generator = new BlueprintGenerator({ totalProducts: 90 });
const blueprint = generator.generateBlueprint("music", "Musical instruments");
// Output: blueprint.json (no AI calls, instant)
```

### BlueprintHydrator

Orchestrates AI hydration of the blueprint:

1. **Categories:** Names and descriptions via `hydrateCategories()`
2. **Products:** Names, descriptions, properties via `ProductHydrator`
3. **Variants:** Property group resolution via `VariantResolver`
4. **CMS:** Text content via `hydrateCmsBlueprint()`
5. **Images:** Product, category, and CMS images via `hydrateProductImages()` / `hydrateCmsImages()`

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
    ├── hydrateCategories()      → Category names + descriptions
    │
    ├── ProductHydrator.hydrate() → Product names + descriptions + properties
    │   └── VariantResolver       → Variant configs from cache or AI
    │
    ├── hydrateCmsBlueprint()    → CMS page text content
    │
    ├── hydrateProductImages()   → Product + category image prompts → cache
    │
    └── hydrateCmsImages()       → CMS block images → cache
```

All image generation happens here in Phase 2. Post-processors in Phase 3 only upload from cache.

## Testing

```bash
bun test tests/unit/blueprint/
bun test tests/integration/blueprint.test.ts
```
