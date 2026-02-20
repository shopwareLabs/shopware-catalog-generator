# CLI Reference

Internal documentation for AI agents working on the CLI module, and complete reference for all commands.

## Module Overview

The CLI is a thin router in `main.ts` that parses args and delegates to focused modules:

- `blueprint.ts` — `blueprint create`, `blueprint hydrate`, `blueprint fix`
- `generate.ts` — `generate`, `process`
- `image-fix.ts` — `image fix`
- `shared.ts` — `CLIError`, validation helpers, `executePostProcessors`

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

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--name` | string | *(required)* | SalesChannel name (becomes subdomain) |
| `--description` | string | `"{name} webshop"` | Context for AI generation |
| `--products` | number | `90` | Number of products to generate |
| `--only` | string | *(all)* | Post-processors to run (comma-separated) |
| `--dry-run` | flag | `false` | Preview actions without making changes |
| `--no-template` | flag | `false` | Skip checking for pre-generated templates |

### Process

Run post-processors on an existing SalesChannel (already uploaded to Shopware).

```bash
bun run process --name=music --only=images,manufacturers
```

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--name` | string | *(required)* | SalesChannel name |
| `--only` | string | *(all)* | Processors to run (comma-separated) |
| `--dry-run` | flag | `false` | Preview actions without making changes |

### Blueprint Create

Phase 1: Generate blueprint structure without AI calls (instant).

```bash
bun run blueprint create --name=music --description="Musical instruments and accessories"
```

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--name` | string | *(required)* | SalesChannel name |
| `--description` | string | `"{name} webshop"` | Context for AI generation |
| `--products` | number | `90` | Number of products to generate |

**Output:** `generated/sales-channels/{name}/blueprint.json`

### Blueprint Hydrate

Phase 2: Fill blueprint with AI-generated content (names, descriptions, properties, images).

```bash
bun run blueprint hydrate --name=music
```

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--name` | string | *(required)* | SalesChannel name |
| `--only` | string | *(full hydration)* | Selective mode: `categories`, `properties`, or `cms` |
| `--force` | flag | `false` | Force full re-hydration (overwrites existing, changes product names) |

#### Hydration Modes

| Mode | What It Does |
| --- | --- |
| *(default, new blueprint)* | Full hydration: categories, products, properties, images |
| `--only=categories` | Only update category names/descriptions, preserve product data |
| `--only=properties` | Only update product properties, preserve names (image-stable) |
| `--only=cms` | Only hydrate CMS blueprint text (`cms-blueprint.json`) |
| `--force` | Force full re-hydration even if hydrated blueprint exists |

If a hydrated blueprint already exists, `--only` or `--force` is required to prevent accidental name changes.

**Output:** `generated/sales-channels/{name}/hydrated-blueprint.json`

### Blueprint Fix

Fix incomplete hydration by replacing placeholder names in a hydrated blueprint.

```bash
bun run blueprint fix --name=music
```

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--name` | string | *(required)* | SalesChannel name |

### Image Fix

Regenerate images for a specific product, category, or CMS page.

```bash
bun run image fix --name=music --product="Acoustic Guitar" --type=product
```

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--name` | string | *(required)* | SalesChannel name |
| `--product` | string | *(required)* | Product/category name or ID, or CMS page name |
| `--type` | string | `product` | Target type: `product`, `category`, or `cms` |
| `--dry-run` | flag | `false` | Preview without regenerating |

### Cleanup

Remove generated data from Shopware. Local cache is preserved.

```bash
bun run cleanup -- --salesChannel="music"
bun run cleanup -- --salesChannel="music" --full --delete
```

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--salesChannel` | string | *(required)* | SalesChannel to clean up |
| `--delete` | flag | `false` | Also delete the SalesChannel itself |
| `--props` | flag | `false` | Also delete property groups |
| `--manufacturers` | flag | `false` | Also delete manufacturers |
| `--processors` | string | *(none)* | Cleanup specific processor entities (comma-separated, or `all`) |
| `--full` | flag | `false` | Full cleanup: all processor cleanups, then core cleanup |
| `--dry-run` | flag | `false` | Preview what would be deleted |

#### Global Cleanup (no SalesChannel required)

```bash
bun run cleanup -- --unused-props        # Delete property groups with no used options
bun run cleanup -- --unused-options      # Delete individual unused property options
bun run cleanup -- --orphaned-media      # Delete media not linked to any product
```

| Flag | Type | Description |
| --- | --- | --- |
| `--unused-props` | flag | Delete property groups where no options are used by products |
| `--unused-options` | flag | Delete individual property options not used by any product |
| `--orphaned-media` | flag | Delete media where the linked product no longer exists |

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
bun run cache:empty-trash             # Permanently delete trash (irreversible)
```

| Command | Description |
| --- | --- |
| `cache:list` | List all cached SalesChannels with product/image counts |
| `cache:clear` | Move cache to `.trash/` (recoverable) |
| `cache:clear -- <name>` | Move specific SalesChannel cache to trash |
| `cache:trash` | Show trash contents |
| `cache:restore -- <item>` | Restore a specific item from trash |
| `cache:restore -- --all` | Restore everything from trash |
| `cache:empty-trash` | Permanently delete all trash |

### Server Mode

Run as an HTTP service with background processing.

```bash
bun run server
```

| Method | Endpoint | Description |
| --- | --- | --- |
| POST | `/generate` | Start background generation (returns process ID) |
| GET | `/status/:id` | Poll process status, progress, and logs |
| GET | `/health` | Health check and active process count |

#### Generate Request

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

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `envPath` | string | *(required)* | Shopware URL |
| `salesChannel` | string | *(required)* | SalesChannel name |
| `description` | string | `"{name} webshop"` | Context for AI generation |
| `productCount` | number | `90` | Number of products |
| `shopwareUser` | string | - | Shopware admin username |
| `shopwarePassword` | string | - | Shopware admin password |
| `skipProcessors` | boolean | `false` | Skip post-processors after sync |
| `skipTemplate` | boolean | `false` | Skip checking for pre-generated templates |

#### Poll Status

```bash
curl http://localhost:3000/status/proc_xxx
# Returns: { "status": "running", "progress": {...}, "logs": [...] }
```

## Adding a New CLI Command

1. Create handler function in the appropriate CLI module (or new file in `src/cli/`)
2. Add routing in `main.ts` switch statement
3. Add to `showHelp()` output
4. Add corresponding MCP tool in `src/mcp/tools/`
5. Add `package.json` script alias if appropriate
6. Update this reference
