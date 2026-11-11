# Services Documentation

Internal documentation for AI agents working on the services module.

## Overview

The `services/` layer contains shared application logic consumed by the **CLI**, the **MCP server** and the **HTTP server**. Functions return `string[]` (output lines) so callers can handle output differently:

- **CLI** — prints each line with `console.log`
- **MCP** — joins lines and returns as a single string

No function in this layer calls `console.log` directly.

## Module Structure

```
services/
├── blueprint-service.ts   # createBlueprint, hydrateBlueprint, estimateBlueprintCost, fixBlueprint, inspireBlueprint
├── generate-service.ts    # runGenerate, runProcessorsForSalesChannel
├── commands.ts            # Command specs (Zod params + run) shared by CLI and MCP, executeCommand
├── generate-request.ts    # buildGenerateRequest, generateRequestParams (input → options, all surfaces)
├── variant-params.ts      # variantSettingParams (Zod shape for MCP tools and the server body)
├── image-fix-service.ts   # fixImages (dispatch by type), fixProductImages, fixCategoryImages, fixCmsImages, fixThemeImages
├── translation-service.ts # parseLanguageSelection, resolveTargetLocales, estimateTranslation, translateBlueprint
├── template-service.ts    # buildGenerationStep, readLaneResults, writeTemplateMetadata (template.json)
└── shopware-context.ts    # ShopwareConnection, connectShopware, createProcessorDeps
```

## blueprint-service.ts

Shared logic for the `blueprint create`, `blueprint hydrate`, `blueprint fix`, and `blueprint inspire` commands.

```typescript
import {
    createBlueprint,
    hydrateBlueprint,
    estimateBlueprintCost,
    fixBlueprint,
    inspireBlueprint,
    resolveCmsStoreDescription,
} from "./services/blueprint-service.js";

// Phase 0 (optional): Crawl a real store for AI inspiration (no AI, no Shopware connection)
const lines = await inspireBlueprint("https://some-music-shop.com", "music");
// → saves generated/sales-channels/music/inspiration.json

// Phase 1: Generate blueprint structure (no AI)
const lines = await createBlueprint("music", "Musical instruments", 90);

// Phase 2a (optional): Forecast cost of the next hydration (no AI calls)
const lines = estimateBlueprintCost("music", { only: "cms" });

// Phase 2: Hydrate with AI content (uses inspiration.json automatically if present)
const lines = await hydrateBlueprint("music", { only: "categories" }); // selective
const lines = await hydrateBlueprint("music", { force: true }); // full re-hydration
const lines = await hydrateBlueprint("music", {}); // new blueprint

// Phase 2b: Fix incomplete hydration (placeholder names)
const lines = await fixBlueprint("music");
```

`inspireBlueprint(url, salesChannelName)`:

- Uses `crawlForInspiration()` from `src/crawlers/` (dynamically imported to avoid loading `cheerio` at startup)
- Saves `InspirationData` to `generated/sales-channels/{name}/inspiration.json` via `cache.saveInspiration()`
- No AI calls, no Shopware connection required
- Returns output lines for CLI/MCP display

`hydrateBlueprint` and `estimateBlueprintCost` share `planHydration()`, so both reject the same
invalid runs with the same message (missing blueprint, `--only=variants` without a hydrated
blueprint, a changed variant share). Tests pass `HydrateDeps` (`cache`, `providers`,
`loadExistingProperties`) as the third argument instead of reading `.env` or calling Shopware.
Image passes are skipped when `imagesEnabled(imageProvider)` (from `src/providers/`) is false,
which is the case for `IMAGE_PROVIDER=none`.

`hydrateBlueprint` automatically loads `inspiration.json` if it exists and passes it to the hydrator:

- Category AI prompt gets real category names as style examples
- Product AI prompts get matching example products for each branch
- `hydrateBrandColors()` AI call is skipped if `inspiration.brandColors` is present

`hydrateBlueprint` logs the cost forecast (via `estimateHydrationCost()` from `src/blueprint/cost-estimator.ts`)
before creating providers, and appends the actual token usage and cost to its output lines. Actual usage is
only available for providers that implement `TextProvider.getUsage()` (currently OpenAI).

`hydrateBlueprint` supports seven selective modes via the `only` option (`HYDRATE_ONLY_MODES`):

- `"categories"` — re-hydrate category names/descriptions only
- `"properties"` — re-hydrate product properties only (preserves product names)
- `"cms"` — re-hydrate CMS blueprint text and CMS images only
- `"variants"` — re-pick variant options with `options.variants` overrides and save them to `blueprint.json`
- `"variant-images"` — recolour product images per colour variant (needs an image provider with
  `editImage`, otherwise returns a "Skipped" line). Records `hydrate:variant-images` in `generation.json`
- `"prices"` — re-price products with AI price ranges, keeps names. Records `hydrate:prices`
- `"names"` — drop variant values from variant parent names and rename duplicate product names.
  Records `hydrate:names`

Variant overrides (`VariantSettingOverrides`, raw flag strings or MCP numbers) are passed to
`createBlueprint`, `estimateBlueprintCost`, `hydrateBlueprint` and `generate`. Invalid values,
overrides without `only: "variants"` and a share change with `only: "variants"` return an
`"Error: ..."` line; the CLI turns it into a `CLIError`.

Safety: if a hydrated blueprint already exists and neither `only` nor `force` is set, returns an error message (prevents accidental name changes that invalidate cached images).

`resolveCmsStoreDescription` picks the best available store description for CMS text prompts:

```typescript
// Priority: hydratedBlueprint.description → blueprint.description → "{name} webshop"
const desc = resolveCmsStoreDescription("music", blueprint.salesChannel.description, hydratedDesc);
```

## generate-service.ts

Shared logic for the `generate` (full pipeline) and `process` (post-processors only) commands.

```typescript
import { runGenerate, runProcessorsForSalesChannel } from "./services/generate-service.js";

// Full pipeline: blueprint → hydrate → translate → upload → post-processors
const { lines, summary } = await runGenerate("music", "Musical instruments", { products: 90 });

// Run post-processors against an existing SalesChannel
const lines = await runProcessorsForSalesChannel("music", ["images", "reviews"], false);
```

`GenerateOptions`:

| Field            | Type                      | Default           | Description                                                   |
| ---------------- | ------------------------- | ----------------- | ------------------------------------------------------------- |
| `products`       | `number`                  | `90`              | Products to generate                                          |
| `dryRun`         | `boolean`                 | `false`           | Preview only, no Shopware changes                             |
| `noTemplate`     | `boolean`                 | `false`           | Skip pre-generated template lookup                            |
| `languages`      | `LanguageSelection`       | -                 | Translate before upload                                       |
| `variants`       | `VariantSettingOverrides` | `{}`              | Variant settings for a new blueprint                          |
| `connection`     | `ShopwareConnection`      | from `SW_ENV_URL` | Integration (CLI/MCP) or admin user (server)                  |
| `clearCache`     | `boolean`                 | `false`           | Clear the SalesChannel cache first (server)                   |
| `inspirationUrl` | `string`                  | -                 | Crawl this store before the blueprint (server)                |
| `skipProcessors` | `boolean`                 | `false`           | Upload only, no post-processors (server)                      |
| `hooks`          | `GenerateHooks`           | -                 | `onLine` / `onProgress` for live output (server process logs) |

`runGenerate` returns `{ lines, summary? }`. `summary` (SalesChannel ID, counts, processor
results) is only set when the upload ran; a run that stopped early ends with an `Error:` line.

### Surface parity (CLI, MCP, server)

`runGenerate` is the only implementation of the pipeline. CLI, MCP and the HTTP server are thin
wrappers that map their input to a `GenerateInput` and call `buildGenerateRequest()`
(`generate-request.ts`), which validates the name and products, resolves `--languages` /
`TRANSLATION_LANGUAGES` and returns the options. Each entry point accepts an injected
`runGenerate` (`generate(args, deps)`, `executeGenerateTool(args, run)`,
`handleGenerate(request, deps)`), and `tests/unit/services/generate-request-parity.test.ts`
runs one case per surface and expects the same service call.

**Adding a generate option:** add it to `GenerateInput`, `generateRequestParams` and
`buildGenerateRequest`, map the CLI flag in `generateInputFromArgs`, and add a case to the
parity test. The MCP tool and the server body pick up `generateRequestParams` automatically.

### Command specs (every other command)

All other commands shared by CLI and MCP (`blueprint create/estimate/translate/hydrate/inspire/fix`,
`image fix`, `template metadata`, `process`) are defined once in `commands.ts`:

```typescript
export const BLUEPRINT_FIX = defineCommand({
    tool: "blueprint_fix",
    description: "Fix placeholder names in a hydrated blueprint",
    params: { name: z.string().describe("SalesChannel name") },
    run: ({ name }, { services }) => withValidName(name, (n) => services.fixBlueprint(n)),
});
```

The Zod `params` are the single source of validation and defaults. `executeCommand(spec, rawArgs,
options)` parses the arguments, returns `["Error: ..."]` on invalid input (no service call), and
runs the spec with the real or injected `services`. The surfaces only map their input:

- MCP: `registerCommandTool(server, spec)` (`src/mcp/tools/command-tool.ts`)
- CLI: `runCliCommand(spec, args, { errorCode })` (`src/cli/command.ts`), which maps flags to
  params (`--only` → `only` / `processors`, `--variant-colors` → `variantColors`) and names flags
  in error messages

`tests/unit/services/commands-parity.test.ts` runs every case through the CLI argv parser and the
MCP tool with recording services and expects identical service calls (and no call for invalid
input on either surface). The cache and cleanup CLIs (`src/cache-cli.ts`, `src/cleanup-cli.ts`)
run their specs with `runCliParams`; `maintenance-parity.test.ts` covers them the same way.
Shared recording services live in `tests/helpers/recording-services.ts`.

**Cache and cleanup services:** `cache-service.ts` works on an injectable `DataCache`
(`createCacheFromEnv()` by default). Restore never overwrites a non-empty target.
`cleanup-service.ts` takes `CleanupDeps { connect, cache }`, so tests use a fake Shopware.
A dry run never deletes core data, and `full` runs every processor cleanup plus the core cleanup
but only deletes the SalesChannel with `deleteSalesChannel`.

**Adding a command or a parameter:** change the spec in `commands.ts`, map a new CLI flag in
`commandParamsFromArgs` if its name differs, and add a case to the parity test.

The pipeline:

1. Checks for a pre-generated template in the configured template repo
2. Creates a blueprint if none exists
3. Hydrates the blueprint if not yet hydrated
4. Validates the blueprint (auto-fixes duplicates)
5. **Auto-recovery:** if validation detects an incomplete hydration (no products or no categories), deletes the broken hydrated blueprint and re-runs hydration automatically
6. Checks hydration return lines for `Error:` prefixes and surfaces them immediately
7. Syncs categories, property groups, and products to Shopware
8. Runs all registered post-processors

Both `runGenerate` and `runProcessorsForSalesChannel` append an `Error:` line via `formatProcessorErrorLine()`
when any post-processor returns errors (`theme (2), images (1)`), even though the processor did not throw.
The CLI wrappers print the summary first and then throw a `CLIError`, so the exit code reflects the failure.

**Resilient hydration:** If a previous hydration attempt failed mid-way (e.g., API credits exhausted), leaving a 0-product `hydrated-blueprint.json` on disk, `generate` detects this via `isIncompleteHydration()` and automatically retries instead of failing with a validation error. If validation still fails after retry, actionable recovery instructions are included in the error output.

## image-fix-service.ts

Shared logic for the `image fix` command. Regenerates cached images and re-uploads them.

```typescript
import {
    fixImages,
    fixProductImages,
    fixCategoryImages,
    fixCmsImages,
    fixThemeImages,
    THEME_MEDIA_KEYS,
} from "./services/image-fix-service.js";

// Entry point used by CLI and MCP: loads the blueprint and dispatches by type
const lines = await fixImages("music", { type: "product", target: "Guitar Stand", dryRun: false });

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
["store-logo", "store-favicon", "store-share"];
```

Internal helpers (exported for testing):

- `flattenCategories(categories)` — recursively flattens the category tree
- `resolveCmsProcessors(searchTerm)` — maps a search term to CMS processor names

## template-service.ts

Template metadata for the templates repo. `hydrateBlueprint` and `translateBlueprint` call
`cache.recordGenerationStep(name, key, buildGenerationStep(selection, withImages))` after
saving, which writes `generation.json`. `writeTemplateMetadata(name, { e2eDir })` builds
`template.json` from it, the hydrated blueprint, the translation locales and the lane
results of a `test-e2e-lanes.sh` run. `summarizeTemplateInfo` is the one-line summary
`generate` prints when it uses a template. Details: [src/templates/AGENTS.md](../templates/AGENTS.md).

## shopware-context.ts

Factory for creating the `ProcessorDeps` bundle (API helpers + AI providers) needed to run post-processors. Replaces repeated bootstrap code that was duplicated across services and tools.

```typescript
import {
    createProcessorDeps,
    ProcessorDepsConfig,
    ProcessorDeps,
} from "./services/shopware-context.js";

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

| Field            | Type          | Description                                    |
| ---------------- | ------------- | ---------------------------------------------- |
| `baseURL`        | `string`      | Shopware Admin API base URL                    |
| `getAccessToken` | `TokenGetter` | Returns current access token                   |
| `clientId`       | `string?`     | OAuth client ID (for client credentials flow)  |
| `clientSecret`   | `string?`     | OAuth client secret                            |
| `username`       | `string?`     | Admin username (for password flow)             |
| `password`       | `string?`     | Admin password                                 |
| `skipProviders`  | `boolean?`    | Skip AI provider creation (cleanup-only flows) |
