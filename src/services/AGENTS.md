# Services Documentation

Internal documentation for AI agents working on the services module.

## Overview

The `services/` layer contains shared application logic consumed by both the **CLI** and the **MCP server**. Functions return `string[]` (output lines) so callers can handle output differently:

- **CLI** — prints each line with `console.log`
- **MCP** — joins lines and returns as a single string

No function in this layer calls `console.log` directly.

## Module Structure

```
services/
├── blueprint-service.ts   # createBlueprint, hydrateBlueprint, fixBlueprint
├── generate-service.ts    # generate, runProcessorsForSalesChannel
├── image-fix-service.ts   # fixProductImages, fixCategoryImages, fixCmsImages, fixThemeImages
└── shopware-context.ts    # createProcessorDeps (shared bootstrap for API helpers + providers)
```

## blueprint-service.ts

Shared logic for the `blueprint create`, `blueprint hydrate`, and `blueprint fix` commands.

```typescript
import {
    createBlueprint,
    hydrateBlueprint,
    fixBlueprint,
    resolveCmsStoreDescription,
} from "./services/blueprint-service.js";

// Phase 1: Generate blueprint structure (no AI)
const lines = await createBlueprint("music", "Musical instruments", 90);

// Phase 2: Hydrate with AI content
const lines = await hydrateBlueprint("music", { only: "categories" }); // selective
const lines = await hydrateBlueprint("music", { force: true });        // full re-hydration
const lines = await hydrateBlueprint("music", {});                     // new blueprint

// Phase 2b: Fix incomplete hydration (placeholder names)
const lines = await fixBlueprint("music");
```

`hydrateBlueprint` supports three selective modes via the `only` option:

- `"categories"` — re-hydrate category names/descriptions only
- `"properties"` — re-hydrate product properties only (preserves product names)
- `"cms"` — re-hydrate CMS blueprint text and CMS images only

Safety: if a hydrated blueprint already exists and neither `only` nor `force` is set, returns an error message (prevents accidental name changes that invalidate cached images).

`resolveCmsStoreDescription` picks the best available store description for CMS text prompts:

```typescript
// Priority: hydratedBlueprint.description → blueprint.description → "{name} webshop"
const desc = resolveCmsStoreDescription("music", blueprint.salesChannel.description, hydratedDesc);
```

## generate-service.ts

Shared logic for the `generate` (full pipeline) and `process` (post-processors only) commands.

```typescript
import { generate, runProcessorsForSalesChannel, GenerateOptions } from "./services/generate-service.js";

// Full pipeline: blueprint → hydrate → upload → post-processors
const lines = await generate("music", "Musical instruments", { products: 90 });

// Run post-processors against an existing SalesChannel
const lines = await runProcessorsForSalesChannel("music", ["images", "reviews"], false);
```

`GenerateOptions`:

| Field        | Type      | Default | Description                          |
| ------------ | --------- | ------- | ------------------------------------ |
| `products`   | `number`  | `90`    | Products to generate                 |
| `dryRun`     | `boolean` | `false` | Preview only, no Shopware changes    |
| `noTemplate` | `boolean` | `false` | Skip pre-generated template lookup   |

The `generate` function:

1. Checks for a pre-generated template in the configured template repo
2. Creates a blueprint if none exists
3. Hydrates the blueprint if not yet hydrated
4. Validates the blueprint (auto-fixes duplicates)
5. Syncs categories, property groups, and products to Shopware
6. Runs all registered post-processors

## image-fix-service.ts

Shared logic for the `image fix` command. Regenerates cached images and re-uploads them.

```typescript
import {
    fixProductImages,
    fixCategoryImages,
    fixCmsImages,
    fixThemeImages,
    THEME_MEDIA_KEYS,
} from "./services/image-fix-service.js";

// Regenerate product images (match by name or ID)
const lines = await fixProductImages("music", blueprint, cache, "Guitar Stand", false);

// Regenerate category banner
const lines = await fixCategoryImages("music", blueprint, cache, "Electric Guitars", false);

// Regenerate CMS images (target: "home", "images", "text-images", "all")
const lines = await fixCmsImages("music", blueprint, cache, "home", false);

// Regenerate theme media (target: "logo", "favicon", "share", or "all")
const lines = await fixThemeImages("music", blueprint, cache, "logo", false);
```

`THEME_MEDIA_KEYS` — the three supported theme media keys:

```typescript
["store-logo", "store-favicon", "store-share"]
```

Internal helpers (exported for testing):

- `flattenCategories(categories)` — recursively flattens the category tree
- `resolveCmsProcessors(searchTerm)` — maps a search term to CMS processor names

## shopware-context.ts

Factory for creating the `ProcessorDeps` bundle (API helpers + AI providers) needed to run post-processors. Replaces repeated bootstrap code that was duplicated across services and tools.

```typescript
import { createProcessorDeps, ProcessorDepsConfig, ProcessorDeps } from "./services/shopware-context.js";

const deps = createProcessorDeps({
    baseURL: process.env.SW_ENV_URL,
    getAccessToken: () => dataHydrator.getAccessToken(),
    clientId: process.env.SW_CLIENT_ID,
    clientSecret: process.env.SW_CLIENT_SECRET,
    // Optional:
    skipProviders: false, // set true for cleanup-only flows (no AI needed)
});

// deps.apiHelpers   — ShopwareApiHelpers for all API calls
// deps.textProvider — TextProvider from env (undefined if skipProviders)
// deps.imageProvider — ImageProvider from env (undefined if skipProviders)
```

`ProcessorDepsConfig`:

| Field            | Type           | Description                                    |
| ---------------- | -------------- | ---------------------------------------------- |
| `baseURL`        | `string`       | Shopware Admin API base URL                    |
| `getAccessToken` | `TokenGetter`  | Returns current access token                   |
| `clientId`       | `string?`      | OAuth client ID (for client credentials flow)  |
| `clientSecret`   | `string?`      | OAuth client secret                            |
| `username`       | `string?`      | Admin username (for password flow)             |
| `password`       | `string?`      | Admin password                                 |
| `skipProviders`  | `boolean?`     | Skip AI provider creation (cleanup-only flows) |
