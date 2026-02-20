# Shopware Catalog Generator

Generate AI-powered demo catalogs for Shopware. Creates SalesChannels with category trees, products, descriptions, images, reviews, variants, and CMS pages.

> **Architecture details:** See [CONCEPTS.md](CONCEPTS.md) for diagrams and in-depth explanations.

## Quick Start

```bash
bun install
bun run build
```

Create a `.env` file:

```env
# AI Provider (generates product names, descriptions, images)
AI_PROVIDER=pollinations
AI_API_KEY=sk_your_pollinations_key   # Get key at https://enter.pollinations.ai

# Shopware connection (required to sync data)
SW_ENV_URL=http://localhost:8000
SW_CLIENT_ID=your-access-key-id      # Settings → System → Integrations
SW_CLIENT_SECRET=your-secret-key     # Settings → System → Integrations
```

The `SW_CLIENT_ID` and `SW_CLIENT_SECRET` authenticate against the Shopware Admin API. Create an integration in your Shopware Admin under **Settings → System → Integrations**, then copy the *Access key ID* and *Secret access key* into your `.env`.

Generate a full catalog:

```bash
bun run generate --name=music --description="Musical instruments and accessories for musicians of all levels"
```

This creates a SalesChannel named "music" with 3 top-level categories, ~90 products, AI-generated descriptions, properties, and optional images.

## Catalog Templates

Pre-generated, ready-to-use catalogs are available at **[shopware-catalog-templates](https://github.com/shopwareLabs/shopware-catalog-templates)**. Currently included: `music`, `garden`, and `beauty`.

When you run `generate`, the CLI automatically checks if a matching template exists. If found, it skips AI generation entirely and uploads the template directly:

```bash
# Uses a pre-generated template (instant, no AI needed)
bun run generate --name=music

# Force AI generation even if a template exists
bun run generate --name=music --no-template
```

Templates require git access via SSH keys or credential helper.

## AI Providers & Performance

| Provider | API Key | Images | Parallel | Best For |
| --- | --- | --- | --- | --- |
| `pollinations` | Required | Yes | With `sk_*` key | Testing, demos (default) |
| `github-models` | Required | N/A | Limited (2x) | GitHub/Copilot users |
| `openai` | Required | Paid | Yes (5x) | Production, high volume |

> Get a Pollinations API key at **[enter.pollinations.ai](https://enter.pollinations.ai)**

### Configuration

```env
# Pollinations with secret key - parallel processing, no rate limits
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

### Expected Times (90 products)

**Text generation only (blueprint hydration):**

| Provider | Processing | Time |
| --- | --- | --- |
| OpenAI | Parallel (5x) | ~5 min |
| Pollinations (sk\_\*) | Parallel (5x) | ~5 min |
| GitHub Models | Limited (2x) | ~10 min |
| Pollinations (pk\_\*) | Sequential | ~13 min |

**Full generation with images (~270 images at 3 views per product):**

| Provider | Image Model | Time |
| --- | --- | --- |
| OpenAI | gpt-image-1.5 | ~35-40 min |
| Pollinations | flux (default) | ~15-20 min |
| Pollinations | turbo (fast) | ~10-15 min |
| Any (images: none) | - | ~5-13 min |

> Image generation is the primary time factor. Use `IMAGE_PROVIDER=none` to skip images for faster testing.

## Shopware Connection

```env
SW_ENV_URL=http://localhost:8000
SW_CLIENT_ID=your-access-key-id
SW_CLIENT_SECRET=your-secret-key
```

To create integration credentials:

1. Open Shopware Admin → **Settings → System → Integrations**
2. Click **Add integration**
3. Copy the *Access key ID* → `SW_CLIENT_ID`
4. Copy the *Secret access key* → `SW_CLIENT_SECRET`

### Domains & Languages

Every generated SalesChannel automatically gets two domains:

| Domain | Language | Currency |
| --- | --- | --- |
| `{name}.localhost:8000` | English | USD |
| `{name}-de.localhost:8000` | German | EUR |

The German domain is only created if `de-DE` language and its snippet set are installed in Shopware. If not, a warning is logged and only the English domain is created.

> To install German: **Settings → Shop → Languages → Add language → German**.

## CLI Usage

For the complete reference with all flags and options, see **[CLI Reference](src/cli/AGENTS.md#command-reference)**.

### Generate

```bash
bun run generate --name=music --description="Musical instruments and accessories for musicians of all levels"
```

### Blueprint Workflow

For more control, run the 3-phase pipeline separately. See [CONCEPTS.md](CONCEPTS.md#running-phases-separately) for details.

```bash
bun run blueprint create --name=music --description="Musical instruments and accessories"
bun run blueprint hydrate --name=music
bun run generate --name=music
```

### Post-Processors

Run specific post-processors after upload:

```bash
bun run process --name=music --only=images,reviews
```

### Cleanup

```bash
bun run cleanup -- --salesChannel="music"                    # Products + categories
bun run cleanup -- --salesChannel="music" --full --delete    # Everything
```

### Cache Management

```bash
bun run cache:list                    # Show cached SalesChannels
bun run cache:clear -- music          # Move to trash
bun run cache:restore -- --all        # Restore from trash
```

## Post-Processors

Post-processors run after upload for resource-intensive tasks (images, reviews, CMS pages, etc.).

| Processor | Description | Dependencies |
| --- | --- | --- |
| `cms-home` | Homepage layout with product listing | none |
| `cms-text` | Text elements demo page | none |
| `cms-images` | Image elements demo page | none |
| `cms-video` | Video elements demo page | none |
| `cms-text-images` | Text & Images demo page | none |
| `cms-commerce` | Commerce elements demo page | images |
| `cms-form` | Form elements demo page | none |
| `cms-footer-pages` | Shared footer and legal pages | none |
| `images` | Upload pre-generated product/category images | none |
| `manufacturers` | Fictional manufacturer creation | none |
| `reviews` | Product reviews (0-10 per product) | none |
| `variants` | Variant product creation | manufacturers |
| `digital-product` | Digital product (Gift Card) | none |
| `cms-testing` | Testing category hierarchy | cms-\*, digital-product |

Processors run in parallel when possible, respecting dependency order. See [CONCEPTS.md](CONCEPTS.md#post-processor-system) for the execution diagram.

## Server Mode

Run as an HTTP service with background processing:

```bash
bun run server
```

| Method | Endpoint | Description |
| --- | --- | --- |
| POST | `/generate` | Start generation (returns process ID) |
| GET | `/status/:id` | Poll process status, progress, and logs |
| GET | `/health` | Health check and active process count |

```bash
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -d '{"envPath":"http://localhost:8000","salesChannel":"music","description":"Musical instruments"}'
```

See [CLI Reference](src/cli/AGENTS.md#server-mode) for all request fields.

## MCP Server (AI Assistant Integration)

This project includes an MCP server for AI assistant integration in Cursor IDE. All CLI commands are exposed as auto-discoverable tools.

### Setup

The MCP config at `.cursor/mcp.json` uses `/bin/sh` to resolve `$HOME` dynamically:

```json
{
    "mcpServers": {
        "catalog-generator": {
            "command": "/bin/sh",
            "args": ["-c", "\"$HOME/.bun/bin/bun\" run src/mcp/index.ts"]
        }
    }
}
```

If your `bun` is installed elsewhere, adjust the path accordingly.

### Testing

```bash
bun run mcp:dev       # Interactive terminal testing
bun run mcp:inspect   # Web UI inspector
```

## Contributing

### Development

```bash
bun run dev           # Watch mode
bun run lint          # Lint + typecheck (oxlint + tsc)
bun run format        # Format code (oxfmt)
bun run build         # Build (lint + format + bundle)
```

### Testing

```bash
bun test              # Run all tests
bun test --watch      # Watch mode
bun test --coverage   # With coverage report
```

### E2E Testing

```bash
./test-e2e.sh                              # Full: create → hydrate → upload → verify
./test-e2e.sh --reuse=music                # Reuse existing blueprint
./test-e2e.sh --reuse=music --skip-hydrate # Skip AI, just upload
./test-e2e.sh --cleanup=music              # Cleanup only
bun run test:verify --name=music           # Verify Shopware data
```

### Extending

See [AGENTS.md](AGENTS.md) for developer documentation on adding post-processors, AI providers, CMS fixtures, and CLI commands.

## License

MIT
