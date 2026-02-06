# Shopware Catalog Generator

Generate synthetic demo data with AI and hydrate your Shopware environment. Creates SalesChannels with category trees, products, descriptions, images, reviews, and properties.

> **Architecture details:** See [CONCEPTS.md](CONCEPTS.md) for diagrams and in-depth explanations.

## Quick Start

```bash
bun install
bun run build
```

Create `.env` file:

```env
AI_PROVIDER=pollinations
AI_API_KEY=sk_your_pollinations_key  # Get key at https://enter.pollinations.ai
SW_ENV_URL=http://localhost:8000
```

Generate products:

```bash
bun run generate --name=music --description="Musical instruments and accessories for musicians of all levels"
```

## Provider Options

| Provider        | API Key  | Images | Parallel        | Best For                 |
| --------------- | -------- | ------ | --------------- | ------------------------ |
| `pollinations`  | Required | Yes    | With `sk_*` key | Testing, demos (default) |
| `github-models` | Required | N/A    | Limited (2x)    | GitHub/Copilot users     |
| `openai`        | Required | Paid   | Yes (5x)        | Production, high volume  |

> Get a Pollinations API key at **[enter.pollinations.ai](https://enter.pollinations.ai)**

### Configuration

```env
# Pollinations with secret key - parallel processing, no rate limits
# Get key at https://enter.pollinations.ai
AI_PROVIDER=pollinations
AI_API_KEY=sk_your_pollinations_secret_key

# GitHub Models (limited parallelism, images via Pollinations)
AI_PROVIDER=github-models
AI_API_KEY=ghp_your_github_token

# OpenAI (full parallel processing)
AI_PROVIDER=openai
AI_API_KEY=sk-your-openai-key
```

**Optional settings:**

```env
AI_MODEL=gpt-4o              # Override text model
IMAGE_PROVIDER=none          # Disable images
IMAGE_MODEL=turbo            # Pollinations: flux (default), turbo (fast), klein (quality)
```

## CLI Reference

### Generate

```bash
# Basic usage (90 products across categories)
bun run generate --name=music --description="Musical instruments and accessories for musicians of all levels"

# Custom product count
bun run generate --name=music --description="Musical instruments and accessories for musicians of all levels" --products=50
```

| Flag            | Description                                  |
| --------------- | -------------------------------------------- |
| `--name`        | SalesChannel name (required)                 |
| `--description` | Context for AI generation                    |
| `--products`    | Number of products to generate (default: 90) |
| `--only`        | Post-processors to run (comma-separated)     |
| `--dry-run`     | Preview actions without making changes       |
| `--no-template` | Skip checking for pre-generated templates    |

### Blueprint Workflow

For more control, run the pipeline phases separately:

```bash
# Phase 1: Create structure (instant, no AI)
bun run blueprint create --name=music --description="Musical instruments and accessories for musicians of all levels"

# Phase 2: Fill with AI content
bun run blueprint hydrate --name=music

# Phase 3: Upload to Shopware
bun run generate --name=music
```

### Post-Processors

Run specific post-processors after upload:

```bash
bun run process --name=music --only=images,reviews
bun run process --name=music --dry-run
```

| Processor       | Description                             |
| --------------- | --------------------------------------- |
| `cms`           | CMS landing pages (Video Elements demo) |
| `images`        | Product and category images             |
| `manufacturers` | Fictional manufacturer creation         |
| `reviews`       | Product reviews (0-10 per product)      |
| `variants`      | Variant product creation                |

### Cleanup

Remove data from Shopware (local cache preserved):

```bash
# Core cleanup
bun run cleanup -- --salesChannel="music"           # Products + categories
bun run cleanup -- --salesChannel="music" --props   # Also property groups
bun run cleanup -- --salesChannel="music" --delete  # Also SalesChannel

# Processor-specific
bun run cleanup -- --salesChannel="music" --processors=cms
bun run cleanup -- --salesChannel="music" --processors=all

# Full cleanup
bun run cleanup -- --salesChannel="music" --full --delete
```

### Cache Management

Local files in `generated/`:

```bash
bun run cache:list                    # Show cached SalesChannels
bun run cache:clear                   # Move all to trash
bun run cache:clear -- music         # Move specific to trash
bun run cache:trash                   # List trash
bun run cache:restore -- <item>       # Restore from trash
bun run cache:empty-trash             # Permanently delete
```

## Property System

Properties are generated contextually based on your store type. The AI infers appropriate property groups from the store name, description, and product categories.

### How It Works

- **Universal properties (Color)**: Stored globally in `generated/properties/` with comprehensive hex codes
- **Store-specific properties**: Generated by AI and stored in `generated/sales-channels/{store}/properties/`

This ensures:

- Music stores get properties like `Brand`, `Material`, `Instrument Type`
- Beauty stores get properties like `Volume`, `Scent`, `Skin Type`
- Fashion stores get properties like `Size`, `Fabric`, `Fit`

No manual property configuration needed - the AI derives appropriate properties from context.

### Migration (for existing stores)

If you have stores generated before the store-scoped property system, run the migration script:

```bash
# Preview what would change
bun run scripts/migrate-properties.ts --dry-run

# Apply migration
bun run scripts/migrate-properties.ts
```

After migration, re-run generation to sync new properties:

```bash
bun run generate --name=<store>
```

## Shopware Connection

```env
SW_ENV_URL=http://localhost:8000
SW_CLIENT_ID=your-client-id
SW_CLIENT_SECRET=your-client-secret
```

## Server Mode

Run as a service with background processing:

```bash
bun run server
```

| Method | Endpoint      | Description                             |
| ------ | ------------- | --------------------------------------- |
| POST   | `/generate`   | Start generation (returns process ID)   |
| GET    | `/status/:id` | Poll process status, progress, and logs |
| GET    | `/health`     | Health check and active process count   |

### Background Processing

The server runs generation tasks in the background:

```bash
# Start generation
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -d '{
    "envPath": "http://localhost:8000",
    "salesChannel": "music",
    "description": "Musical instruments and accessories for musicians of all levels",
    "shopwareUser": "admin",
    "shopwarePassword": "shopware"
  }'
# Returns: { "processId": "proc_xxx", "statusUrl": "/status/proc_xxx" }

# Poll status
curl http://localhost:3000/status/proc_xxx
# Returns: { "status": "running", "progress": {...}, "logs": [...] }
```

**Generate options:**

| Field              | Description                               | Default          |
| ------------------ | ----------------------------------------- | ---------------- |
| `envPath`          | Shopware URL (required)                   | -                |
| `salesChannel`     | SalesChannel name (required)              | -                |
| `description`      | Context for AI generation                 | "{name} webshop" |
| `productCount`     | Number of products                        | 90               |
| `shopwareUser`     | Shopware admin username                   | -                |
| `shopwarePassword` | Shopware admin password                   | -                |
| `skipProcessors`   | Skip post-processors after sync           | false            |
| `skipTemplate`     | Skip checking for pre-generated templates | false            |

## Performance

Expected times for 90 products:

**Text generation only (blueprint hydration):**

| Provider              | Processing    | Time    |
| --------------------- | ------------- | ------- |
| OpenAI                | Parallel (5x) | ~5 min  |
| Pollinations (sk\_\*) | Parallel (5x) | ~5 min  |
| GitHub Models         | Limited (2x)  | ~10 min |
| Pollinations (pk\_\*) | Sequential    | ~13 min |

**Full generation with images (~270 images at 3 views per product):**

| Provider           | Image Model    | Time       |
| ------------------ | -------------- | ---------- |
| OpenAI             | gpt-image-1.5  | ~35-40 min |
| Pollinations       | flux (default) | ~15-20 min |
| Pollinations       | turbo (fast)   | ~10-15 min |
| Any (images: none) | -              | ~5-13 min  |

> **Note:** Image generation is the primary time factor. OpenAI's `gpt-image-1.5` averages ~35s per image. Use `IMAGE_PROVIDER=none` to skip images for faster testing.

## Testing

```bash
bun test              # Run all tests
bun test --watch      # Watch mode
bun test --coverage   # With coverage
```

## Development

```bash
bun run dev           # Watch mode
bun run lint          # Lint + typecheck
bun run format        # Format code
bun run build         # Build
```

## MCP Server (AI Assistant Integration)

This project includes an MCP server for seamless AI assistant integration in Cursor IDE. All CLI commands are exposed as auto-discoverable tools.

### Setup

Copy the example config and restart Cursor:

```bash
cp .cursor/mcp.json.example .cursor/mcp.json
```

If `bun` isn't in Cursor's PATH, edit `.cursor/mcp.json` to use the absolute path:

```json
"command": "/home/youruser/.bun/bin/bun"
```

### Testing

```bash
# Test interactively
bun run mcp:dev

# Inspect tools in web UI
bun run mcp:inspect
```

The MCP server exposes all CLI commands as tools that Cursor can discover and call directly.
See [AGENTS.md](AGENTS.md) for details on adding new commands.

## Extending

See [AGENTS.md](AGENTS.md) for developer documentation:

- Adding post-processors
- Adding AI providers
- Adding CMS fixtures

## Catalog Templates

Pre-generated templates available at:

> **[github.com/shopwareLabs/shopware-catalog-templates](https://github.com/shopwareLabs/shopware-catalog-templates)**

Ready-to-use SalesChannel configurations without running AI generation.

### How Templates Work

When you run `generate --name=<name>`, the CLI automatically checks if a matching template exists:

1. Clones the template repository (first run) or pulls updates
2. If a template matches the name, copies data to local cache
3. Skips blueprint creation and AI hydration phases
4. Proceeds directly to Shopware upload

```bash
# Uses template if "beauty" exists in the repository
bun run generate --name=beauty

# Force AI generation even if template exists
bun run generate --name=beauty --no-template
```

### Environment Variables

```env
# Override template repository URL (default: git@github.com:shopwareLabs/shopware-catalog-templates.git)
TEMPLATE_REPO_URL=git@github.com:your-org/your-templates.git

# Override local clone directory (default: .template-repo)
TEMPLATE_CACHE_DIR=.my-templates
```

Templates require git access via SSH keys or credential helper.

## License

MIT
