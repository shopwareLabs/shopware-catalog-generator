# Types Documentation

Internal documentation for AI agents working on the types module.

## Overview

All types are centralized in `src/types/` and re-exported through `src/types/index.ts`. Always import types from `./types/index.js` — never from individual files.

## Module Structure

```
types/
├── index.ts            # Central re-export (import from here)
├── blueprint.ts        # Blueprint types (v2) + DEFAULT_BLUEPRINT_CONFIG
├── shopware.ts         # Shopware entity types + Zod schemas
├── providers.ts        # AI provider interfaces (TextProvider, ImageProvider)
├── cache.ts            # Cache configuration types
├── export.ts           # Export types (ExportValidation, ExportResult)
└── property-cache.ts   # Property cache types (CachedPropertyGroup)
```

## Key Types

### Blueprint Types (`blueprint.ts`)

- `Blueprint` — Phase 1 output (structure without AI content)
- `HydratedBlueprint` — Phase 2 output (filled with AI content)
- `BlueprintCategory`, `BlueprintProduct` — Category/product nodes
- `BlueprintConfig` — Generator configuration (topLevelCategories, maxDepth, etc.)
- `ProductMetadata` — Per-product metadata (variant flags, image descriptions, review counts, storefront flags, physical attributes, EAN, purchase constraints)
- `VariantConfig` — Variant property group + selected options
- `CmsBlueprint`, `CmsBlueprintPage` — CMS text content structure
- `BrandColors` — AI-generated brand colors for theme customization (primary, secondary only; buy button, text, and price colors are derived deterministically via Material Design principles)

### Shopware Types (`shopware.ts`)

- `SalesChannel`, `SalesChannelFull`, `SalesChannelInput` — SalesChannel entities
- `CategoryNode`, `ProductInput`, `PropertyGroup`, `PropertyOption` — Core entities
- Zod schemas: `ProductDefinition`, `PropertyGroupDefinition`, etc. — Used for AI response validation
- **Sync payload types** (used in `hydrator.ts` to replace `Record<string, unknown>`):
    - `PricePayload` — `{ currencyId, gross, net, linked, listPrice? }`
    - `ProductVisibilityPayload` — `{ id, productId, salesChannelId, visibility }`
    - `TieredPricePayload` — `{ ruleId, quantityStart, quantityEnd?, price[] }`
    - `ProductSyncPayload` — Full product upsert payload (includes index signature for Shopware-specific extensions)
    - `ProductMediaPayload` — Product–media association
    - `MediaEntityPayload` — Media entity creation record (`{ id, private, mediaFolderId? }`)

### Blueprint Types (`blueprint.ts`)

- `BlueprintProduct` includes:
    - `deliveryTimeIndex?: number` — Round-robin index set in Phase 1; resolved to a real delivery-time ID in Phase 3 (idempotent)
    - Note: `releaseDate` is **not** stored in the blueprint. For `isNew` products, Phase 3 sets `releaseDate = new Date().toISOString()` at upload time so the storefront "New" badge never ages out

### Provider Types (`providers.ts`)

- `TextProvider` — AI text generation interface (generateCompletion, maxConcurrency, tokenLimit)
- `ImageProvider` — AI image generation interface (generateImage)
- `AIProviderType` — `"openai" | "github-models" | "pollinations"`
- `PROVIDER_DEFAULTS` — Default concurrency and token limits per provider

## Conventions

- Use `interface` over `type` for object shapes
- Use `import type` for type-only imports
- Avoid `any` — use `unknown` or specific types
- Use `z.ZodTypeAny` instead of `z.ZodType<any>`
- All Zod schemas for AI response validation live in `shopware.ts`
- Export new types from `index.ts` immediately after creating them
