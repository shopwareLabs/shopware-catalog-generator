# CLI Reference

Internal documentation for AI agents working on the CLI module, and complete reference for all commands.

## Module Overview

The CLI is a thin router in `main.ts` that parses args and delegates to focused modules:

- `blueprint.ts` — `blueprint create`, `blueprint hydrate`, `blueprint fix`, `blueprint inspire`
- `generate.ts` — `generate`, `process`
- `image-fix.ts` — `image fix`
- `template.ts` — `template metadata`
- `command.ts` — `runCliCommand(spec, args, options)`: maps flags to the params of a command spec in `src/services/commands.ts`, prints the lines, throws `CLIError` on an `Error:` line
- `shared.ts` — `CLIError`, validation helpers, `executePostProcessors`

**Important:** All application logic lives in `src/services/`, not in the CLI modules. CLI handlers are thin wrappers that call service functions and print their `string[]` output. This keeps the CLI and MCP tools in sync — both call the same service functions. Except `generate`, every command shared with MCP is a spec in `src/services/commands.ts`; validation errors name the CLI flag (`--variant-colors: ...`).

| Service File                        | CLI Module         | What It Does                                     |
| ----------------------------------- | ------------------ | ------------------------------------------------ |
| `src/services/blueprint-service.ts` | `cli/blueprint.ts` | Blueprint create / hydrate / fix / inspire logic |
| `src/services/generate-service.ts`  | `cli/generate.ts`  | Full generation pipeline + post-processors       |
| `src/services/image-fix-service.ts` | `cli/image-fix.ts` | Image regeneration (product/category/cms/theme)  |
| `src/services/template-service.ts`  | `cli/template.ts`  | Template metadata (`template.json`)              |

Separate CLI entry points (not routed through `main.ts`):

- `cache-cli.ts` — `cache:list`, `cache:clear`, `cache:trash`, `cache:restore`, `cache:empty-trash`
- `cleanup-cli.ts` — `cleanup`, `cleanup:media`, `cleanup:props`
- `server.ts` — HTTP server mode

## Command Reference

### Generate

Full pipeline: create blueprint, hydrate with AI, upload to Shopware.

```bash
bun run generate --name=music --description="Musical instruments and accessories"
```

| Flag            | Type   | Default            | Description                               |
| --------------- | ------ | ------------------ | ----------------------------------------- |
| `--name`        | string | _(required)_       | SalesChannel name (becomes subdomain)     |
| `--description` | string | `"{name} webshop"` | Context for AI generation                 |
| `--products`    | number | `90`               | Number of products to generate            |
| `--only`        | string | _(all)_            | Post-processors to run (comma-separated)  |
| `--dry-run`     | flag   | `false`            | Preview actions without making changes    |
| `--no-template` | flag   | `false`            | Skip checking for pre-generated templates |

### Process

Run post-processors on an existing SalesChannel (already uploaded to Shopware).

```bash
bun run process --name=music --only=images,manufacturers,customers
```

| Flag        | Type   | Default      | Description                            |
| ----------- | ------ | ------------ | -------------------------------------- |
| `--name`    | string | _(required)_ | SalesChannel name                      |
| `--only`    | string | _(all)_      | Processors to run (comma-separated)    |
| `--dry-run` | flag   | `false`      | Preview actions without making changes |

### Blueprint Create

Phase 1: Generate blueprint structure without AI calls (instant).

```bash
bun run blueprint create --name=music --description="Musical instruments and accessories"
```

| Flag            | Type   | Default            | Description                    |
| --------------- | ------ | ------------------ | ------------------------------ |
| `--name`        | string | _(required)_       | SalesChannel name              |
| `--description` | string | `"{name} webshop"` | Context for AI generation      |
| `--products`    | number | `90`               | Number of products to generate |

Variant settings are fixed here and stored in `blueprint.variants` (flag beats env var beats default):

| Flag                | Type   | Default | Description                                                     |
| ------------------- | ------ | ------- | --------------------------------------------------------------- |
| `--variant-share`   | number | `0.3`   | Share of products with variants (0-1, env `VARIANT_SHARE`)      |
| `--variant-colors`  | number | `4`     | Colours per colour variant product (2-12, env `VARIANT_COLORS`) |
| `--variant-options` | number | `3`     | Options per other variant group (2-8, env `VARIANT_OPTIONS`)    |
| `--max-variants`    | number | `24`    | Max variants per product (4-100, env `MAX_VARIANTS`)            |

Exactly `round(products × share)` products get variants, picked by a seeded rank of their IDs.
Out-of-range values fail with a clear error.

**Output:** `generated/sales-channels/{name}/blueprint.json`

### Blueprint Estimate

Forecast AI cost for the next hydration run. Makes no AI calls and needs no Shopware connection.

```bash
bun run blueprint estimate --name=music
bun run blueprint estimate --name=music --only=cms
```

| Flag          | Type   | Default            | Description                                                   |
| ------------- | ------ | ------------------ | ------------------------------------------------------------- |
| `--name`      | string | _(required)_       | SalesChannel name (blueprint must exist)                      |
| `--only`      | string | _(full hydration)_ | Selective mode: `categories`, `properties`, `cms`, `variants` |
| `--languages` | string | _(none)_           | Also forecast translation: `de-DE,fr-FR`, `all`, `none`       |

`blueprint hydrate` prints the same forecast before it starts and the actual token usage at the end.

### Blueprint Translate

Translate the hydrated catalog into other locales (one AI pass per locale). Output:
`generated/sales-channels/{name}/translations/{locale}.json`. Upload runs in `generate`
(or `process --only=translations,reviews`).

```bash
bun run blueprint translate --name=music --languages=de-DE,fr-FR
bun run blueprint translate --name=music --languages=all --formality=formal
```

| Flag          | Type    | Default                 | Description                                                  |
| ------------- | ------- | ----------------------- | ------------------------------------------------------------ |
| `--name`      | string  | _(required)_            | SalesChannel name (hydrated blueprint must exist)            |
| `--languages` | string  | `TRANSLATION_LANGUAGES` | Locale list, `all` (SalesChannel languages) or `none`        |
| `--formality` | string  | _(AI picks per locale)_ | `formal` or `informal`                                       |
| `--force`     | boolean | `false`                 | Re-translate everything instead of reusing unchanged entries |

`generate` accepts `--languages` too. Without it (and without `TRANSLATION_LANGUAGES`) it shows
the translation forecast and asks in a terminal; outside a terminal it stays English only.

### Blueprint Hydrate

Phase 2: Fill blueprint with AI-generated content (names, descriptions, properties, images).

```bash
bun run blueprint hydrate --name=music
```

| Flag          | Type   | Default            | Description                                                          |
| ------------- | ------ | ------------------ | -------------------------------------------------------------------- |
| `--name`      | string | _(required)_       | SalesChannel name                                                    |
| `--only`      | string | _(full hydration)_ | Selective mode: `categories`, `properties`, `cms` or `variants`      |
| `--rehydrate` | flag   | `false`            | Force full re-hydration (overwrites existing, changes product names) |

#### Hydration Modes

| Mode                       | What It Does                                                   |
| -------------------------- | -------------------------------------------------------------- |
| _(default, new blueprint)_ | Full hydration: categories, products, properties, images       |
| `--only=categories`        | Only update category names/descriptions, preserve product data |
| `--only=properties`        | Only update product properties, preserve names (image-stable)  |
| `--only=cms`               | Only hydrate CMS blueprint text (`cms-blueprint.json`)         |
| `--only=variants`          | Re-pick variant options with new settings (see below)          |
| `--only=variant-images`    | Recolour product images per colour variant (OpenAI edits)      |
| `--only=prices`            | Realistic prices per product (one AI call per 100 products)    |
| `--only=names`             | Unique product names, no variant values in parent names        |
| `--only=manufacturers`     | Fictional brands that fit the store (one AI call)              |
| `--rehydrate`              | Force full re-hydration even if hydrated blueprint exists      |

If a hydrated blueprint already exists, `--only` or `--rehydrate` is required to prevent accidental name changes.

`--only=variants` takes `--variant-colors`, `--variant-options` and `--max-variants` (not
`--variant-share`, which is fixed at create). Existing options stay first, so product names and images
stay valid. Products that need more colours get them from one AI call per 25 products (default colour
first); without AI the colours are topped up from the known shades. The new settings are saved to
`blueprint.json`. Variant flags without `--only=variants` fail with an error.

```bash
bun run blueprint hydrate --name=music --only=variants --variant-colors=6 --max-variants=36
```

`--only=variant-images` recolours the parent images (default colour) into every other colour of a
colour variant product with OpenAI `images.edit`. Run it after `--only=variants`. Pollinations cannot
edit images, so it is skipped with a warning. `VARIANT_IMAGE_VIEWS=cover` only recolours the first view.
`blueprint estimate --only=variant-images` shows the edit count and cost first.

**Output:** `generated/sales-channels/{name}/hydrated-blueprint.json`

### Blueprint Fix

Fix incomplete hydration by replacing placeholder names in a hydrated blueprint.

```bash
bun run blueprint fix --name=music
```

| Flag     | Type   | Default      | Description       |
| -------- | ------ | ------------ | ----------------- |
| `--name` | string | _(required)_ | SalesChannel name |

### Blueprint Inspire

Crawl a real store URL to extract categories, example products, brand colors, and description.
Saves `inspiration.json` so `blueprint hydrate` can use it to orient AI generation.

```bash
bun run blueprint inspire --name=music --url=https://some-music-shop.com
```

| Flag     | Type   | Default      | Description                    |
| -------- | ------ | ------------ | ------------------------------ |
| `--name` | string | _(required)_ | SalesChannel name              |
| `--url`  | string | _(required)_ | URL of the real store to crawl |

**Output:** `generated/sales-channels/{name}/inspiration.json`

No AI calls are made. Uses `cheerio` (MIT) + `sharp` to parse static HTML and images:

1. JSON-LD `BreadcrumbList` → category names; fallback: `<nav>` link text
2. JSON-LD `Product` / `ItemList` → example products (follows up to 2 category pages)
3. Brand images → dominant color extraction:
    - SVG icons: `fill`/`stroke` attributes parsed directly (e.g. IKEA blue + yellow)
    - Raster icons (apple-touch-icon, PNG favicons): pixel analysis via `sharp`
    - Fallback: `theme-color` meta / CSS `--primary-color` vars (near-white filtered out)
4. `og:description` or JSON-LD `Organization.description` → brand description

### Image Fix

Regenerate images for a specific product, category, or CMS page.

```bash
bun run image fix --name=music --target="Acoustic Guitar" --type=product
bun run image fix --name=music --type=theme --target=logo
bun run image fix --name=music --type=theme              # regenerates all theme media
```

| Flag        | Type   | Default      | Description                                                    |
| ----------- | ------ | ------------ | -------------------------------------------------------------- |
| `--name`    | string | _(required)_ | SalesChannel name                                              |
| `--target`  | string | _(required)_ | Product/category name or ID, CMS page name, or theme media key |
| `--type`    | string | `product`    | Target type: `product`, `category`, `cms`, or `theme`          |
| `--dry-run` | flag   | `false`      | Preview without regenerating                                   |

For `--type=theme`, `--target` is optional (defaults to "all"). Valid targets: `logo`, `favicon`, `share`, or `all`.

### Template Metadata

Write `template.json` (generator version, date, models, languages, tested Shopware versions)
for a cached SalesChannel before it is copied to the templates repo. No AI, no Shopware.

```bash
bun run template metadata --name=beauty
bun run template metadata --name=beauty --e2e=e2e-results/20261109-123512
```

| Flag     | Type   | Default      | Description                                                   |
| -------- | ------ | ------------ | ------------------------------------------------------------- |
| `--name` | string | _(required)_ | SalesChannel name (hydrated blueprint must exist)             |
| `--e2e`  | string | -            | `e2e-results/<timestamp>` of a `test-e2e-lanes.sh` run to add |

See [src/templates/AGENTS.md](../templates/AGENTS.md#template-metadata-templatejson).

### Cleanup

Remove generated data from Shopware. Local cache is preserved.

```bash
bun run cleanup -- --salesChannel="music"
bun run cleanup -- --salesChannel="music" --full --delete
```

| Flag              | Type   | Default      | Description                                                     |
| ----------------- | ------ | ------------ | --------------------------------------------------------------- |
| `--salesChannel`  | string | _(required)_ | SalesChannel to clean up                                        |
| `--delete`        | flag   | `false`      | Also delete the SalesChannel itself                             |
| `--props`         | flag   | `false`      | Also delete property groups                                     |
| `--manufacturers` | flag   | `false`      | Same as adding `manufacturers` to `--processors`                |
| `--processors`    | string | _(none)_     | Cleanup specific processor entities (comma-separated, or `all`) |
| `--full`          | flag   | `false`      | All processor cleanups, then core (add `--delete` for the SC)   |
| `--dry-run`       | flag   | `false`      | Preview what would be deleted                                   |

#### Global Cleanup (no SalesChannel required)

```bash
bun run cleanup -- --unused-props        # Delete property groups with no used options
bun run cleanup -- --unused-options      # Delete individual unused property options
bun run cleanup -- --orphaned-media      # Delete media not linked to any product
```

| Flag               | Type | Description                                                  |
| ------------------ | ---- | ------------------------------------------------------------ |
| `--unused-props`   | flag | Delete property groups where no options are used by products |
| `--unused-options` | flag | Delete individual property options not used by any product   |
| `--orphaned-media` | flag | Delete media where the linked product no longer exists       |

#### Shortcut Scripts

```bash
bun run cleanup:media     # Same as --orphaned-media
bun run cleanup:props     # Same as --unused-props
```

### Cache Management

Manage local cached files in `generated/`. Does **not** affect Shopware.

```bash
bun run cache:list                    # Show cached SalesChannels with stats
bun run cache:clear                   # Move all cached data to trash
bun run cache:clear -- music          # Move specific SalesChannel to trash
bun run cache:trash                   # List trash contents
bun run cache:restore -- <item>       # Restore specific item from trash
bun run cache:restore -- --all        # Restore all items from trash
bun run cache:empty-trash -- --confirm  # Permanently delete trash (irreversible)
```

| Command                   | Description                                             |
| ------------------------- | ------------------------------------------------------- |
| `cache:list`              | List all cached SalesChannels with product/image counts |
| `cache:clear`             | Move cache to `.trash/` (recoverable)                   |
| `cache:clear -- <name>`   | Move specific SalesChannel cache to trash               |
| `cache:trash`             | Show trash contents                                     |
| `cache:restore -- <item>` | Restore a specific item from trash                      |
| `cache:restore -- --all`  | Restore everything from trash                           |
| `cache:empty-trash`       | Permanently delete all trash                            |

### Server Mode

Run as an HTTP service with background processing.

```bash
bun run server
```

| Method | Endpoint      | Description                                      |
| ------ | ------------- | ------------------------------------------------ |
| POST   | `/generate`   | Start background generation (returns process ID) |
| GET    | `/status/:id` | Poll process status, progress, and logs          |
| GET    | `/health`     | Health check and active process count            |

#### Generate Request

Minimal request — name and description are derived from the inspiration URL:

```bash
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -d '{
    "envPath": "http://localhost:8000",
    "shopwareUser": "admin",
    "shopwarePassword": "shopware",
    "inspirationUrl": "https://some-music-shop.com"
  }'
```

Full request with explicit fields:

```bash
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -d '{
    "envPath": "http://localhost:8000",
    "salesChannel": "music",
    "description": "Musical instruments and accessories",
    "shopwareUser": "admin",
    "shopwarePassword": "shopware"
  }'
```

| Field              | Type    | Default                                  | Description                                                                     |
| ------------------ | ------- | ---------------------------------------- | ------------------------------------------------------------------------------- |
| `envPath`          | string  | _(required)_                             | Shopware URL                                                                    |
| `salesChannel`     | string  | derived from `inspirationUrl` hostname   | SalesChannel name; inferred from URL if omitted                                 |
| `description`      | string  | `brandDescription` from crawl or webshop | Context for AI generation; falls back to crawled `brandDescription`             |
| `productCount`     | number  | `90`                                     | Number of products                                                              |
| `shopwareUser`     | string  | -                                        | Shopware admin username                                                         |
| `shopwarePassword` | string  | -                                        | Shopware admin password                                                         |
| `skipProcessors`   | boolean | `false`                                  | Skip post-processors after sync                                                 |
| `skipTemplate`     | boolean | `false`                                  | Skip checking for pre-generated templates                                       |
| `inspirationUrl`   | string  | _(none)_                                 | Crawl this URL before blueprint creation; derives name + description if omitted |

#### Poll Status

```bash
curl http://localhost:3000/status/proc_xxx
# Returns: { "status": "running", "progress": {...}, "logs": [...] }
```

## Adding a New CLI Command

1. Implement the logic in `src/services/<category>-service.ts` (returns `string[]` for output)
2. Create a thin CLI handler in `src/cli/<category>.ts` that calls the service and prints lines
3. Add routing in `main.ts` switch statement
4. Add to `showHelp()` output
5. Add a thin MCP tool wrapper in `src/mcp/tools/<category>.ts` that calls the same service and joins lines
6. Add `package.json` script alias if appropriate
7. Update this reference and `src/mcp/AGENTS.md`
