# Shopware Catalog Generator

**A complete, realistic Shopware demo store from one command.** Describe a store ("an outdoor
gear shop", "a drugstore") and the generator builds a SalesChannel that looks and feels like
a real shop: a deep category tree, 90 products with believable names, prices and copy,
product photos from several angles, colour variants with their own recoloured images, fictional
brands, reviews, CMS pages, a themed storefront and a German translation, all written for that store.

Or skip the AI entirely and load one of six [ready-made templates](#catalog-templates) in minutes.

> **Architecture details:** See [CONCEPTS.md](CONCEPTS.md) for diagrams and in-depth explanations.

## Highlights

**Catalog content**

- **Any store type.** Every prompt is derived from your store name and description. Nothing is
  hardcoded for fashion, furniture or music.
- **Deep category trees** with AI names, descriptions and banner images. Categories without
  products are hidden from the navigation.
- **90 products** (configurable) with unique names, rich descriptions, store-specific
  properties, EANs, weights, delivery times, list prices, tiered prices and top sellers.
- **Realistic prices:** the AI picks a plausible price range per product, plus pack units
  ("Pair", "Pack", "Bag", "Roll") with reference prices where they make sense.
- **Fictional brands** that fit the store, and image prompts that avoid real trademarks.
- **Multi-view product images** (OpenAI or Pollinations), category banners, CMS images and a
  theme with AI brand colours, logo, favicon and share image.

**Variants and colours**

- **Variant products** with colour, size, material and other groups. Share of variant products,
  colours, options and the variant cap are all [configurable](src/cli/AGENTS.md#command-reference).
- **Recoloured images per colour variant:** the parent photos are edited once per colour, so
  every variant shows its own colour (needs OpenAI image editing).
- **Colour families as filter:** precise shade names ("Sage", "Burgundy") on the product, 16
  colour families ("Green", "Red") in the listing filter.

**Languages**

- **English and German storefronts** out of the box (USD and EUR domains), more locales with
  `--languages=fr-FR,nl-NL`.
- **Native-sounding translations**, not word-for-word: products, categories, properties, brands,
  CMS texts, reviews, promotions and image alt texts. Re-runs only translate what changed.

**Shop features for demos and QA**

- **CMS showcase pages** for every CMS element (text, images, video, commerce, forms), a
  homepage, footer and legal pages.
- **Demo customers** (incl. a B2B group), **promotion codes**, **cross-selling**, a **digital
  product** with download, and a **media showcase** with 3D models and videos.
- **Reviews** spread across the storefront languages.

**Built for real workflows**

- **Cost forecast before any AI call** (`blueprint estimate`) and actual token usage after.
- **Store inspiration:** crawl a real shop to borrow its category style, product examples and
  brand colours.
- **Version aware:** detects the Shopware version and feature flags, and only sends fields the
  shop supports. One template works on every version.
- **Idempotent and resumable:** re-runs update instead of duplicating, and a failed hydration
  heals itself on the next run.
- **CLI, HTTP server and MCP server** share one implementation, so AI assistants can drive
  every command.

## Tested Shopware Versions

Supported: **Shopware 6.6 and newer**. 6.5 runs, but is best-effort (a warning is printed).

The six [catalog templates](#catalog-templates) were generated with generator **2.0.0** and
tested end to end (upload, all post-processors, data verification, storefront domains) on these
lanes on **2026-11-11**:

| Lane    | Shopware                                  | Result                                                                                     |
| ------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `65`    | 6.5 development build                     | ✅ all 6 pass (6.6+ features skipped)                                                      |
| `66`    | 6.6 development build                     | ✅ all 6 pass (6.7+ features skipped)                                                      |
| `67`    | 6.7.16.0                                  | ✅ all 6 pass                                                                              |
| `68`    | 6.7 development build (`6.7.9999999-dev`) | ✅ all 6 pass                                                                              |
| `trunk` | 6.7 development build (`6.7.9999999-dev`) | ⚠️ 5 of 6 pass (music: imperial-units check failed on a SalesChannel that already existed) |

Each template's `template.json` records its exact results. To run the same matrix yourself, see
[E2E Testing](#e2e-testing).

## Quick Start

```bash
bun install
bun run build
```

Create a `.env` file:

```env
# AI Provider — pick one:
AI_PROVIDER=pollinations                # Free tier: enter.pollinations.ai
AI_API_KEY=pk_your_pollinations_key     # pk_ = free/sequential, sk_ = parallel
# AI_PROVIDER=openai                    # Paid, fastest
# AI_API_KEY=sk-your-openai-key

# Shopware connection (required to sync data)
SW_ENV_URL=http://localhost:8000
SW_CLIENT_ID=your-access-key-id      # Settings → System → Integrations
SW_CLIENT_SECRET=your-secret-key     # Settings → System → Integrations
```

The `SW_CLIENT_ID` and `SW_CLIENT_SECRET` authenticate against the Shopware Admin API. Create an integration in your Shopware Admin under **Settings → System → Integrations**, then copy the _Access key ID_ and _Secret access key_ into your `.env`.

Generate a full catalog:

```bash
bun run generate --name=music --description="Musical instruments and accessories for musicians of all levels"
```

This creates a SalesChannel named "music" with 3 top-level categories, ~90 products, AI-generated descriptions, properties, and optional images.

## Catalog Templates

Pre-generated, ready-to-use catalogs are available at **[shopware-catalog-templates](https://github.com/shopwareLabs/shopware-catalog-templates)**:

| Template      | Store                                                |
| ------------- | ---------------------------------------------------- |
| `beauty`      | Makeup, skincare and beauty tools                    |
| `drugstore`   | Beauty and personal care, health, household          |
| `electronics` | Computers, phones, wearables, TV and audio           |
| `fashion`     | Women's and men's fashion, shoes and accessories     |
| `garden`      | Outdoor furniture, plants, garden tools and watering |
| `music`       | Musical instruments, accessories, sheet music        |

Every template has 90 products (27 with variants and recoloured colour images), English and
German texts, CMS pages, a theme, and a `template.json` with the models used and the tested
Shopware versions.

When you run `generate`, the CLI automatically checks if a matching template exists. If found, it skips AI generation entirely and uploads the template directly:

```bash
# Uses a pre-generated template (instant, no AI needed)
bun run generate --name=music

# Force AI generation even if a template exists
bun run generate --name=music --no-template
```

Templates are downloaded anonymously over HTTPS (only `git` is needed, no GitHub account or SSH key).
Uploading a template makes no AI calls, so no `AI_API_KEY` is needed for it.

### Maintaining the Templates Repository

When regenerating all templates, squash the history to keep the repo size small. A maintenance script is included for this:

```bash
bash scripts/reset-templates-history.sh /path/to/shopware-catalog-templates
```

This creates a fresh single commit, cleans up all stale refs, and repackages the objects to the minimum possible size. Afterwards, a force-push is required.

## AI Providers & Performance

| Provider       | API Key  | Text       | Images                  | Best For                |
| -------------- | -------- | ---------- | ----------------------- | ----------------------- |
| `pollinations` | `pk_*`   | Sequential | Free (pollen preserved) | **Free setup**          |
| `pollinations` | `sk_*`   | Parallel   | Parallel (with key)     | Fast, no rate limits    |
| `openai`       | `sk-...` | Parallel   | Paid (gpt-image-1-mini) | Production, high volume |

> GitHub Models (`AI_PROVIDER=github-models`) was [retired on July 30, 2026](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/). The generator now stops with a hint to switch providers if it is still set.

### Free Setup (Pollinations)

Create a free publishable key at **[enter.pollinations.ai](https://enter.pollinations.ai)**. Text uses the default `openai` model (gpt-5.4-nano) and images use the Pollinations free tier, so the key's pollen is kept for text:

```env
AI_PROVIDER=pollinations
AI_API_KEY=pk_your_pollinations_key
```

No `IMAGE_PROVIDER` or `IMAGE_API_KEY` needed.

### Other Providers

```env
# Pollinations with secret key - parallel processing, no rate limits
AI_PROVIDER=pollinations
AI_API_KEY=sk_your_pollinations_secret_key

# OpenAI (full parallel processing, paid images)
AI_PROVIDER=openai
AI_API_KEY=sk-your-openai-key
```

> Get a Pollinations API key at **[enter.pollinations.ai](https://enter.pollinations.ai)**

**Optional settings:**

```env
AI_MODEL=gpt-6-luna          # OpenAI default (reasoning disabled)
IMAGE_PROVIDER=none          # Disable images
IMAGE_MODEL=gpt-image-1-mini # OpenAI default; optional: gpt-image-2.5-flare. Pollinations: flux (default), klein, zimage
IMAGE_QUALITY=low            # OpenAI only: low (fastest), medium, high, auto
```

OpenAI uses **GPT-6 Luna without reasoning** for cost-efficient catalog text. In our
[small live benchmark](docs/model-benchmark-2026-09-23.md), it cost about 93% less than
GPT-4.1 but took about twice as long. Set `AI_MODEL=gpt-4.1-2025-04-14` to retain the
previous, faster model. Explicit model overrides are preserved.

Images stay on **GPT Image 1 Mini / low**. Flare produced sharper detail in the sample,
but its estimated cost was about 54% higher and its speed advantage was small. Opt in
with `IMAGE_MODEL=gpt-image-2.5-flare`; existing image sizes and WebP caching work unchanged.
Pollinations image models remain `flux`, `klein`, and `zimage`.

### Expected Times (90 products)

These are historical estimates, not measurements of the new Luna text default.
Actual times depend on model, account limits, and generated content.

**Text generation only (blueprint hydration):**

| Provider              | Processing    | Time    |
| --------------------- | ------------- | ------- |
| OpenAI                | Parallel (5x) | ~5 min  |
| Pollinations (sk\_\*) | Parallel (5x) | ~5 min  |
| Pollinations (pk\_\*) | Sequential    | ~13 min |

**Full generation with images (~270 images at 3 views per product):**

| Provider           | Image Model      | Quality | Time       |
| ------------------ | ---------------- | ------- | ---------- |
| OpenAI             | gpt-image-1-mini | low     | ~8-12 min  |
| OpenAI             | gpt-image-1-mini | medium  | ~12-18 min |
| OpenAI             | gpt-image-1.5    | medium  | ~20-25 min |
| Pollinations       | flux (default)   | -       | ~15-20 min |
| Pollinations       | zimage           | -       | ~10-15 min |
| Any (images: none) | -                | -       | ~5-13 min  |

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
3. Copy the _Access key ID_ → `SW_CLIENT_ID`
4. Copy the _Secret access key_ → `SW_CLIENT_SECRET`

### Domains & Languages

Every generated SalesChannel gets an English domain plus one domain per extra locale
(German by default):

| Domain                     | Language | Currency |
| -------------------------- | -------- | -------- |
| `{name}.localhost:8000`    | English  | USD      |
| `{name}-de.localhost:8000` | German   | EUR      |

A locale's domain is only created if its language and snippet set are installed in Shopware. If not, a warning is logged and that domain is skipped.

> To install German: **Settings → Shop → Languages → Add language → German**.

### Translations

English is generated first. A separate AI pass then translates the catalog per locale, aiming
for copy a native speaker would write. The tone (du/Sie, tu/vous) is chosen per locale and
can be set with `--formality`.

```bash
bun run blueprint translate --name=music --languages=de-DE,fr-FR  # translate (shows a cost forecast first)
bun run generate --name=music --languages=de-DE                   # translate and upload in one go
```

`--languages` also takes `all` (every language of the SalesChannel) or `none`.
`TRANSLATION_LANGUAGES` sets the default. Unchanged texts are reused on re-runs.

## CLI Usage

For the complete reference with all flags and options, see **[CLI Reference](src/cli/AGENTS.md#command-reference)**.

### Generate

```bash
bun run generate --name=music --description="Musical instruments and accessories for musicians of all levels"
```

### Blueprint Workflow

For more control, run the 3-phase pipeline separately. See [CONCEPTS.md](CONCEPTS.md#running-phases-separately) for details.

```bash
# Optional: crawl a real store to guide AI generation (no AI calls, instant)
bun run blueprint inspire --name=music --url=https://some-music-shop.com

bun run blueprint create --name=music --description="Musical instruments and accessories"
bun run blueprint estimate --name=music  # optional: forecast AI cost, no AI calls
bun run blueprint hydrate --name=music   # uses inspiration.json automatically if present
bun run generate --name=music
```

`blueprint estimate` prints the expected tokens, image count and USD cost for the configured models. `blueprint hydrate` shows the same forecast before it starts and the actual token usage when it finishes.

Re-hydrate only one part of an existing catalog with `--only` (product names stay stable, so
images stay valid):

```bash
bun run blueprint hydrate --name=music --only=prices         # realistic prices and pack units
bun run blueprint hydrate --name=music --only=names          # unique product names
bun run blueprint hydrate --name=music --only=manufacturers  # fictional brands for the store
bun run blueprint hydrate --name=music --only=variants --variant-colors=6
bun run blueprint hydrate --name=music --only=variant-images # recolour images per colour variant
```

Other modes: `categories`, `properties`, `cms`. See the [CLI Reference](src/cli/AGENTS.md#command-reference).

`blueprint inspire` extracts categories, example products, brand colors, and a description from a real store's static HTML. The data is saved as `inspiration.json` and automatically picked up by `blueprint hydrate` to orient AI generation. No API keys needed — uses `cheerio` + `sharp`.

> Results depend on the site's structure. Sites with bot protection (Cloudflare, etc.) or full SPA rendering may yield partial or no data. A failed crawl never blocks generation.

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

| Processor          | Description                                      | Dependencies                         |
| ------------------ | ------------------------------------------------ | ------------------------------------ |
| `cms-home`         | Homepage layout with product listing             | customers, promotions, cross-selling |
| `cms-text`         | Text elements demo page                          | none                                 |
| `cms-images`       | Image elements demo page                         | none                                 |
| `cms-video`        | Video elements demo page                         | none                                 |
| `cms-text-images`  | Text & Images demo page                          | none                                 |
| `cms-commerce`     | Commerce elements demo page                      | images                               |
| `cms-form`         | Form elements demo page                          | none                                 |
| `cms-footer-pages` | Shared footer and legal pages                    | none                                 |
| `cross-selling`    | Category-based cross-selling via product streams | none                                 |
| `customers`        | Demo customer accounts with B2B group            | none                                 |
| `images`           | Upload pre-generated product/category images     | none                                 |
| `manufacturers`    | Fictional manufacturer creation                  | none                                 |
| `promotions`       | Tiered pricing and promotion codes               | none                                 |
| `reviews`          | Product reviews, spread across languages         | none                                 |
| `theme`            | Child theme with brand colors, logo, favicon     | none                                 |
| `variants`         | Variant product creation                         | manufacturers                        |
| `variant-images`   | Colour images and gallery per colour variant     | variants, images                     |
| `translations`     | Write cached translations per language (no AI)   | most other processors                |
| `digital-product`  | Digital product (Gift Card)                      | none                                 |
| `media-product`    | Product with 3D models and videos (6.6+)         | none                                 |
| `cms-testing`      | Testing category hierarchy                       | cms-\*, demo products                |

Processors run in parallel when possible, respecting dependency order. See [CONCEPTS.md](CONCEPTS.md#post-processor-system) for the execution diagram.

## Server Mode

Run as an HTTP service with background processing:

```bash
bun run server
```

| Method | Endpoint      | Description                             |
| ------ | ------------- | --------------------------------------- |
| POST   | `/generate`   | Start generation (returns process ID)   |
| GET    | `/status/:id` | Poll process status, progress, and logs |
| GET    | `/health`     | Health check and active process count   |

```bash
# Minimal: name and description are derived from the inspiration URL
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -d '{
    "envPath": "http://localhost:8000",
    "shopwareUser": "admin",
    "shopwarePassword": "shopware",
    "inspirationUrl": "https://some-music-shop.com"
  }'
```

When `inspirationUrl` is provided, the server crawls the URL **before** creating the blueprint — so the extracted `brandDescription` and brand colors are used to orient AI generation. The `salesChannel` name is derived from the URL hostname if not explicitly set. See [CLI Reference](src/cli/AGENTS.md#server-mode) for all request fields.

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
bun run test:mcp      # Automated MCP CLI checks (no credentials or external services)
bun run mcp:dev       # Interactive terminal testing
bun run mcp:inspect   # Web UI inspector
```

`test:mcp` launches the installed `@wong2/mcp-cli` against the real Bun MCP server.
It checks tool calls, blueprint creation, cache listing, argument validation, and schema
defaults using a temporary cache that is removed afterward. Use Node.js 24 for the CLI,
matching CI. To use it interactively, run `bunx --no-install mcp-cli bun run src/mcp/index.ts`
and select `list_processors` for a read-only check.

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
./test-e2e.sh                                                         # Full: create → hydrate → upload → verify
./test-e2e.sh --name=stabilo --description="Writing instruments" \
              --url=https://www.stabilo.com/com                        # With inspiration crawl
./test-e2e.sh --reuse=music                                           # Reuse existing blueprint
./test-e2e.sh --reuse=music --skip-hydrate                            # Skip AI, just upload
./test-e2e.sh --cleanup=music                                         # Cleanup only
./test-e2e.sh --sw-dev=67 --reuse=music --skip-hydrate                # Local sw-dev lane, temporary credentials
./test-e2e-lanes.sh --lanes=65,66,67,68,trunk --reuse=music           # Same store on several sw-dev lanes + summary
bun run test:verify --name=music                                      # Verify Shopware data
```

### Extending

See [AGENTS.md](AGENTS.md) for developer documentation on adding post-processors, AI providers, CMS fixtures, and CLI commands.

## License

This project is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
