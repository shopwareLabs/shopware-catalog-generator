# Agent Documentation

Internal documentation for AI agents working on this codebase.

## Runtime

This project uses **Bun** as the runtime instead of Node.js:

- Native TypeScript execution (no compilation for dev)
- Built-in test runner with `bun:test`
- Built-in HTTP server with `Bun.serve`
- Native fetch API (no axios)

**Key dependencies:** `zod` (schema validation), `openai` (API client), `sharp` (image post-processing — trim whitespace, resize to exact dimensions), `@shopware/api-client` (official Shopware client).

## Project Structure

```
src/
├── types/                    # All types - import from here
│   ├── AGENTS.md             # Types documentation
│   ├── index.ts              # Re-exports all types and schemas
│   ├── shopware.ts           # Shopware entities + Zod schemas
│   ├── blueprint.ts          # Blueprint types
│   ├── providers.ts          # AI provider interfaces (+ tokenLimit)
│   ├── cache.ts              # Cache configuration types
│   ├── export.ts             # Export types (ExportValidation, ExportResult)
│   └── property-cache.ts     # Property cache types
│
├── shopware/                 # Shopware API operations
│   ├── AGENTS.md             # Shopware module documentation
│   ├── index.ts              # DataHydrator (combines all) + exports
│   ├── admin-client.ts       # Official @shopware/api-client wrapper
│   ├── api-helpers.ts        # Convenience methods (searchEntities, syncEntities, etc.)
│   ├── api-types.ts          # API type definitions
│   ├── client.ts             # Legacy auth, base client with fetch API
│   ├── sync.ts               # Sync operations
│   ├── hydrator.ts           # Create products/categories/SalesChannels
│   ├── export.ts             # Export/sync existing data + getExistingPropertyGroups
│   └── cleanup.ts            # Delete operations (SalesChannel-centric)
│
├── providers/                # AI provider implementations
│   ├── AGENTS.md             # Provider documentation
│   ├── index.ts              # Exports + factory
│   ├── factory.ts            # Provider creation logic
│   ├── openai-provider.ts    # OpenAI (text + images)
│   ├── github-models-provider.ts  # GitHub Models (text only)
│   ├── pollinations-provider.ts   # Pollinations (text + images, free)
│   └── noop-provider.ts      # Disabled image provider
│
├── cli/                      # CLI command modules (main.ts delegates here)
│   ├── AGENTS.md             # CLI reference (all commands, flags, options)
│   ├── blueprint.ts          # blueprint create, hydrate, fix (thin wrappers)
│   ├── generate.ts           # generate (full pipeline), process (thin wrappers)
│   ├── image-fix.ts          # image fix - thin wrapper
│   └── shared.ts             # CLIError, validation helpers, executePostProcessors
│
├── services/                 # Shared application logic (used by both CLI and MCP)
│   ├── blueprint-service.ts  # createBlueprint, hydrateBlueprint, fixBlueprint
│   ├── generate-service.ts   # generate, runProcessorsForSalesChannel
│   └── image-fix-service.ts  # fixProductImages, fixCategoryImages, fixCmsImages, fixThemeImages
│
├── blueprint/                # Blueprint-based generation
│   ├── AGENTS.md             # Blueprint module documentation
│   ├── index.ts              # Re-exports all blueprint modules
│   ├── generator.ts          # Generate blueprint structure (no AI)
│   ├── hydrator.ts           # Orchestrates category + product hydration
│   ├── fix-placeholders.ts   # Fix incomplete hydration (placeholder names)
│   ├── variant-resolver.ts   # Variant configuration resolution via cache + AI
│   └── hydrators/            # Specialized hydration modules
│       ├── index.ts          # Re-exports all hydrators
│       ├── category.ts       # Category names/descriptions via AI
│       ├── product.ts        # Product content via AI (parallel branches)
│       ├── cms.ts            # CMS blueprint generation and AI text hydration
│       ├── image.ts          # Product/category/CMS/theme image pre-generation
│       └── theme.ts          # AI brand color generation
│
├── post-processors/          # Post-processors (parallel execution)
│   ├── AGENTS.md             # Post-processor documentation
│   ├── index.ts              # Interface, registry, ordered runner
│   ├── cms/                  # CMS demo page processors
│   │   ├── AGENTS.md         # CMS processor documentation
│   │   ├── index.ts          # Re-exports all CMS processors
│   │   ├── base-processor.ts # Abstract base class for CMS processors
│   │   ├── home-processor.ts # Homepage layout (root category)
│   │   ├── text-processor.ts # Text elements demo page
│   │   ├── images-processor.ts # Image elements demo page
│   │   ├── video-processor.ts # Video elements demo page
│   │   ├── text-images-processor.ts # Text & Images demo page
│   │   ├── commerce-processor.ts # Commerce elements demo page
│   │   ├── form-processor.ts # Form elements demo page
│   │   ├── footer-pages-processor.ts # Shared footer and legal pages
│   │   └── testing-processor.ts # Orchestrator (Testing hierarchy)
│   ├── cross-selling-processor.ts # Category-based cross-selling
│   ├── currency-utils.ts     # resolvePrimaryCurrencyId (base currency factor=1 → SalesChannel)
│   ├── customer-processor.ts     # Demo customer accounts with B2B group
│   ├── digital-product-processor.ts # Digital product with download
│   ├── image-processor.ts    # Multi-view product image generation
│   ├── category-image-processor.ts # Category banner images
│   ├── image-utils.ts        # Shared image utilities
│   ├── manufacturer-processor.ts # Fictional manufacturer creation
│   ├── promotion-processor.ts # Demo promotion codes (WELCOME10, SUMMER20, SAVE15, FREESHIP)
│   ├── variant-processor.ts  # Variant product creation
│   ├── review-processor.ts   # Variable review counts
│   └── theme-processor.ts    # Child theme with brand colors + media
│
├── fixtures/                 # Reusable data configurations
│   ├── AGENTS.md             # Fixtures documentation
│   ├── index.ts              # Re-exports all fixtures
│   ├── types.ts              # Fixture type definitions
│   ├── cms/                  # CMS page fixtures
│   │   ├── index.ts          # Re-exports all CMS fixtures
│   │   ├── testing-placeholder.ts # Testing entry page
│   │   ├── welcome.ts        # CMS Element Showcase page
│   │   ├── text.ts           # Text elements page
│   │   ├── images.ts         # Image elements page
│   │   ├── video.ts          # Video elements page
│   │   ├── text-images.ts    # Text & Images page
│   │   ├── commerce.ts       # Commerce elements page
│   │   ├── form.ts           # Form elements page
│   │   └── home-listing.ts   # Home listing page (root category)
│   ├── color-images/         # SVG color swatch images
│   ├── demo-customers.ts     # Demo customer accounts + B2B group
│   ├── digital-products.ts   # Gift card fixture (GIFT_CARD_50)
│   ├── promotions.ts         # Demo promotions (WELCOME10, SUMMER20, SAVE15, FREESHIP)
│   ├── property-groups.ts    # Universal property groups (Color with hex codes)
│   └── review-data.ts        # Reviewer names and review templates
│
├── templates/                # Pre-generated catalog templates
│   ├── AGENTS.md             # Templates documentation
│   ├── index.ts              # Exports
│   └── fetcher.ts            # TemplateFetcher for cloning template repo
│
├── utils/                    # Utility functions
│   ├── AGENTS.md             # Utilities documentation
│   ├── index.ts              # Re-exports all utilities
│   ├── validation.ts         # Subdomain validation
│   ├── blueprint-validation.ts # Validate blueprints before sync (duplicates, placeholders)
│   ├── retry.ts              # executeWithRetry, sleep, rate limit handling
│   ├── strings.ts            # normalizeString, stripHtml, capitalizeString, createShortHash, generateNumericHash
│   ├── category-tree.ts      # countCategories, getLeafCategories, etc.
│   ├── property-collector.ts # Collect, deduplicate, merge properties
│   ├── concurrency.ts        # ConcurrencyLimiter for parallel processing
│   ├── color-palette.ts      # HEX color values, fuzzy matching
│   ├── uuid.ts               # UUID generation
│   ├── arrays.ts             # Array utilities (randomPick, etc.)
│   ├── shopware-request.ts   # Shopware API request helpers
│   ├── clone.ts              # cloneDeep - typed structuredClone wrapper
│   └── logger.ts             # File-based logging (logs/ folder)
│
├── services/                 # Shared application logic (CLI + MCP)
│   ├── AGENTS.md             # Services documentation
│   ├── blueprint-service.ts  # createBlueprint, hydrateBlueprint, fixBlueprint
│   ├── generate-service.ts   # generate, runProcessorsForSalesChannel
│   ├── image-fix-service.ts  # fixProductImages, fixCategoryImages, fixCmsImages, fixThemeImages
│   └── shopware-context.ts   # createProcessorDeps (API helpers + providers bootstrap)
│
├── server/                   # HTTP server infrastructure
│   ├── AGENTS.md             # Server documentation
│   ├── index.ts              # Exports ProcessManager + types
│   └── process-manager.ts    # Background task management
│
├── mcp/                      # MCP server for Cursor AI integration
│   ├── AGENTS.md             # MCP server documentation
│   ├── index.ts              # MCP server entry point (stdio transport)
│   └── tools/                # Tool definitions by category
│       ├── index.ts          # Re-exports all tools
│       ├── blueprint.ts      # blueprint_create, blueprint_hydrate, blueprint_fix
│       ├── generate.ts       # generate, process
│       ├── image-fix.ts      # image_fix (regenerate product/category/CMS images)
│       ├── cache.ts          # cache_list, cache_clear, cache_trash, cache_restore
│       └── cleanup.ts        # cleanup, cleanup_media, cleanup_unused_props
│
├── cache.ts                  # DataCache class (+ blueprint storage)
├── image-cache.ts            # ImageCache (product/category/CMS/property media)
├── property-cache.ts         # PropertyCache (store-scoped property caching)
├── main.ts                   # CLI entry point (subcommand-based)
├── server.ts                 # HTTP server entry (Bun.serve)
├── cache-cli.ts              # Cache management CLI
├── cleanup-cli.ts            # Cleanup CLI (+ manufacturer cleanup)
└── migrate-variants.ts       # Variant migration script

scripts/
└── lint-no-cast.ts           # Custom lint rule: no type casting

tests/
├── unit/                     # Unit tests (mirrors src/ structure)
│   ├── blueprint/            # Blueprint tests
│   │   ├── generator.test.ts
│   │   ├── hydrator.test.ts
│   │   └── hydrators/
│   │       ├── cms.test.ts
│   │       ├── image.test.ts
│   │       └── theme.test.ts
│   ├── post-processors/      # Post-processor tests
│   │   ├── registry.test.ts
│   │   ├── customer-processor.test.ts
│   │   ├── image-processor.test.ts
│   │   ├── manufacturer-processor.test.ts
│   │   ├── review-processor.test.ts
│   │   ├── theme-processor.test.ts
│   │   ├── variant-processor.test.ts
│   │   ├── digital-product-processor.test.ts
│   │   ├── no-ai-in-processors.test.ts  # Architectural: no AI calls in post-processors
│   │   └── cms/              # CMS processor tests
│   │       ├── base-processor.test.ts
│   │       ├── commerce-processor.test.ts
│   │       ├── home-processor.test.ts
│   │       ├── images-processor.test.ts
│   │       ├── testing-processor.test.ts
│   │       └── simple-processors.test.ts
│   ├── providers/            # Provider tests
│   │   └── pollinations-provider.test.ts
│   ├── server/               # Server tests
│   │   └── process-manager.test.ts
│   ├── shopware/             # Shopware client tests
│   │   ├── entities.test.ts
│   │   ├── export.test.ts
│   │   ├── hydrator-ordering.test.ts
│   │   └── sync.test.ts
│   ├── templates/            # Template tests
│   │   └── fetcher.test.ts
│   ├── utils/                # Utility tests
│   │   ├── arrays.test.ts
│   │   ├── blueprint-validation.test.ts
│   │   ├── category-tree.test.ts
│   │   ├── color-palette.test.ts
│   │   ├── concurrency.test.ts
│   │   ├── logger.test.ts
│   │   ├── property-collector.test.ts
│   │   ├── property-validation.test.ts
│   │   ├── retry.test.ts
│   │   ├── strings.test.ts
│   │   ├── uuid.test.ts
│   │   └── validation.test.ts
│   ├── cache.test.ts         # Root-level src/ file tests
│   ├── property-cache.test.ts
│   └── saleschannel-cache.test.ts
├── integration/              # Integration tests
│   └── blueprint.test.ts     # Blueprint integration
├── e2e/                      # E2E tests
│   ├── verify.ts             # API verification script
│   └── browser-checks.md     # Browser verification guide
├── helpers/                  # Shared test factories
│   ├── blueprint-factory.ts  # createTestProduct, createTestCategory, createTestBlueprint
│   └── post-processor-context.ts # createTestContext — builds PostProcessorContext with mocks
└── mocks/                    # Test mocks
    ├── index.ts              # Re-exports + createMockProductMetadata
    ├── admin-client.mock.ts  # createMockAdminClient, createMockAdminClientWithInvoke
    ├── api-helpers.mock.ts   # createMockApiHelpers, MockApiHelpers
    ├── data-cache.mock.ts    # MockDataCache, MockImageCache, createMockDataCache
    ├── text-provider.mock.ts # MockTextProvider, createMockTextProviderWithProducts
    └── image-provider.mock.ts # MockImageProvider, FailingImageProvider, SlowImageProvider
```

## Module Documentation

Detailed documentation for each module is in their respective folders:

- **[src/blueprint/AGENTS.md](src/blueprint/AGENTS.md)** - Blueprint generator, hydrator, variant resolver, hydration flow
- **[src/cli/AGENTS.md](src/cli/AGENTS.md)** - CLI command reference (all commands, flags, options)
- **[src/fixtures/AGENTS.md](src/fixtures/AGENTS.md)** - Static data configurations (CMS pages, reviews, properties, promotions)
- **[src/mcp/AGENTS.md](src/mcp/AGENTS.md)** - MCP server for Cursor AI integration, adding tools
- **[src/post-processors/AGENTS.md](src/post-processors/AGENTS.md)** - Post-processor system, registry, cleanup, adding new processors
- **[src/providers/AGENTS.md](src/providers/AGENTS.md)** - AI provider interfaces, concurrency settings, adding new providers
- **[src/server/AGENTS.md](src/server/AGENTS.md)** - HTTP server, ProcessManager, background tasks, API endpoints
- **[src/services/AGENTS.md](src/services/AGENTS.md)** - Shared application logic for CLI and MCP (blueprint, generate, image-fix services)
- **[src/shopware/AGENTS.md](src/shopware/AGENTS.md)** - Shopware API client, hydrator, cleanup, official client wrapper
- **[src/templates/AGENTS.md](src/templates/AGENTS.md)** - Pre-generated catalog templates, template fetching
- **[src/types/AGENTS.md](src/types/AGENTS.md)** - Centralized types, Zod schemas, conventions
- **[src/utils/AGENTS.md](src/utils/AGENTS.md)** - Shared utilities (retry, strings, logging, cloneDeep, etc.)

## Architecture

### 3-Phase Pipeline

The architecture uses a 3-phase pipeline for faster generation:

1. **Phase 1: Blueprint Generation** - Create structure WITHOUT AI (instant)
2. **Phase 2: AI Hydration** - Fill blueprint with AI-generated text AND images (parallel when supported)
3. **Phase 3: Shopware Upload + Post-processors** - Upload cached data, run parallel processors (fast, no AI)

**Expected times for 90 products (text-only hydration):**

| Provider              | Processing    | Time    |
| --------------------- | ------------- | ------- |
| OpenAI                | Parallel (5x) | ~5 min  |
| Pollinations (sk\_\*) | Parallel (5x) | ~5 min  |
| GitHub Models         | Limited (2x)  | ~10 min |
| Pollinations (pk\_\*) | Sequential    | ~13 min |

**Full hydration with images (~270 product + ~20 CMS + category banners):**

| Provider              | Image Model      | Quality | Processing     | Time       |
| --------------------- | ---------------- | ------- | -------------- | ---------- |
| OpenAI                | gpt-image-1-mini | low     | Parallel (10x) | ~8-12 min  |
| OpenAI                | gpt-image-1-mini | medium  | Parallel (10x) | ~12-18 min |
| OpenAI                | gpt-image-1.5    | medium  | Parallel (10x) | ~20-25 min |
| Pollinations (sk\_\*) | flux             | -       | Parallel (5x)  | ~15-20 min |
| Pollinations (sk\_\*) | turbo            | -       | Parallel (5x)  | ~10-15 min |
| Pollinations (pk\_\*) | flux             | -       | Limited (2x)   | ~40-50 min |

> All AI generation (text + images) happens in Phase 2 (hydration). Phase 3 only uploads cached data to Shopware, typically completing in 1-3 minutes.

```
Phase 1: Blueprint          Phase 2: AI Hydration           Phase 3: Upload (no AI)
(instant, no AI)             (text + images)                 (cached data only)

Blueprint Generator          Text AI Calls                   Upload to Shopware
       │                          │                               │
       ▼                          ▼                          ┌────┼────┐
  blueprint.json ──────▶  hydrated-blueprint.json            │    │    │
                               │                             ▼    ▼    ▼
                               ▼                          Images  Mfr  Reviews
                         Image AI Calls                   Upload  Proc Proc
                               │
                               ▼
                          Image Cache ──────────────────▶
```

### SalesChannel-Centric Model

The architecture is centered around SalesChannels:

1. **Blueprint Creation**: Generate complete structure (categories, products) without AI
2. **AI Hydration**: Fill with names, descriptions, properties via multiple AI calls
3. **Shopware Upload**: Create SalesChannel, categories, products, property groups
4. **Post-processors**: Run image, manufacturer, review, variant processors in parallel

```typescript
// Generation flow
const generator = new BlueprintGenerator();
const blueprint = generator.generateBlueprint("music", "Musical instruments and accessories for musicians of all levels");

const hydrator = new BlueprintHydrator(textProvider);
const hydratedBlueprint = await hydrator.hydrate(blueprint, existingProperties);

// Upload to Shopware
await dataHydrator.createSalesChannel({ name: "music", ... });
await dataHydrator.createCategoryTree(categories, rootId, salesChannelId);

// Run post-processors
await runProcessors(context, ["images", "manufacturers", "reviews"]);
```

### Multi-Domain SalesChannels

Every SalesChannel is created with two domains automatically:

| Domain             | Language                  | Currency | Snippet Set      |
| ------------------ | ------------------------- | -------- | ---------------- |
| `{name}.{host}`    | English (from Storefront) | USD      | English          |
| `{name}-de.{host}` | German (`de-DE`)          | EUR      | German (`de-DE`) |

**Graceful fallback**: If German (`de-DE`) language or its snippet set is not installed in Shopware, a warning is logged and only the English/USD domain is created.

**Currency**: USD is used as the primary currency for the SalesChannel. If USD is not found in Shopware, the Storefront's default currency is used as fallback.

Both domains are created in a single `sync` call along with both languages and both currencies:

```typescript
// Domain resolution in createSalesChannel()
const [storefront, usdResult, eurResult, deLanguageResult, deSnippetResult, rootCategory] =
    await Promise.all([
        this.getFullSalesChannel("Storefront"),
        this.getCurrencyId("USD").catch(() => null), // null → fallback to storefront
        this.getCurrencyId("EUR").catch(() => null),
        this.getLanguageId("de-DE"), // null → skip German domain
        this.getSnippetSetId("de-DE"), // null → skip German domain
        this.createRootCategory(sanitizedName),
    ]);
```

New lookup methods on `ShopwareClient`:

- `getLanguageId(localeCode: string): Promise<string | null>` — searches `language` by `locale.code`
- `getSnippetSetId(iso: string): Promise<string | null>` — searches `snippet_set` by `iso`

### Post-Processor System

Post-processors run after initial Shopware upload for resource-intensive tasks:

```typescript
interface PostProcessor {
    readonly name: string;
    readonly description: string;
    readonly dependsOn: string[]; // Dependency ordering
    process(context: PostProcessorContext): Promise<PostProcessorResult>;
}

interface PostProcessorContext {
    salesChannelId: string;
    salesChannelName: string;
    blueprint: HydratedBlueprint;
    cache: DataCache;
    textProvider?: TextProvider;
    imageProvider?: ImageProvider;
    api: ShopwareApiHelpers; // Required — all API calls must go through this
    options: PostProcessorOptions;
}

interface PostProcessorOptions {
    dryRun: boolean;
    activeProcessors?: string[]; // Populated by runProcessors() — use for conditional rendering
}
```

**Available processors:**

| Processor          | Description                                      | Dependencies                               |
| ------------------ | ------------------------------------------------ | ------------------------------------------ |
| `cms-home`         | Homepage layout on root category                 | `customers`, `promotions`, `cross-selling` |
| `cms-text`         | Text elements demo page                          | none                                       |
| `cms-images`       | Image elements demo page                         | none                                       |
| `cms-video`        | Video elements demo page                         | none                                       |
| `cms-text-images`  | Text & Images demo page                          | none                                       |
| `cms-commerce`     | Commerce elements demo page                      | `images`                                   |
| `cms-form`         | Form elements demo page                          | none                                       |
| `cms-footer-pages` | Shared footer and legal pages                    | none                                       |
| `cross-selling`    | Category-based cross-selling via product streams | none                                       |
| `customers`        | Demo customer accounts with B2B group            | none                                       |
| `images`           | Upload pre-generated product/category images     | none                                       |
| `manufacturers`    | Fictional manufacturer creation                  | none                                       |
| `promotions`       | Tiered pricing and promotion codes               | none                                       |
| `reviews`          | Variable review counts (0-10 per product)        | none                                       |
| `theme`            | Child theme with brand colors, logo, favicon     | none                                       |
| `variants`         | Variant product creation                         | `manufacturers`                            |
| `digital-product`  | Digital product with download                    | none                                       |
| `cms-testing`      | Testing category hierarchy                       | cms-\*, digital-product                    |

Processors run in parallel when possible, respecting dependencies:

```typescript
await runProcessors(context, ["images", "manufacturers", "reviews"]);
// Runs: manufacturers → (images, reviews in parallel)
```

See [src/post-processors/cms/AGENTS.md](src/post-processors/cms/AGENTS.md) for CMS processor details.

### Provider System

Providers implement `TextProvider` or `ImageProvider` interfaces:

```typescript
interface TextProvider {
    generateCompletion(messages: ChatMessage[], schema?: z.ZodTypeAny): Promise<string>;
    readonly isSequential: boolean; // Rate limit handling
    readonly maxConcurrency: number; // Parallel processing limit
    readonly name: string;
    readonly tokenLimit: number; // For payload chunking
}

interface ImageProvider {
    generateImage(prompt: string, options?: ImageGenerationOptions): Promise<string | null>;
    readonly isSequential: boolean;
    readonly maxConcurrency: number;
    readonly name: string;
}

interface ImageGenerationOptions {
    width?: number; // Desired width in pixels
    height?: number; // Desired height in pixels
}
```

Providers may ignore `width`/`height` if they use a fixed size or prefer their own defaults.

**Provider concurrency settings:**

| Provider              | maxConcurrency | Notes                           |
| --------------------- | -------------- | ------------------------------- |
| OpenAI                | 5              | High rate limits                |
| GitHub Models         | 2              | 2 concurrent request limit      |
| Pollinations (sk\_\*) | 5              | Secret keys have no rate limits |
| Pollinations (pk\_\*) | 1              | Sequential processing           |

Factory in `providers/factory.ts` creates providers from env vars:

- `AI_PROVIDER`: openai | github-models | pollinations
- `IMAGE_PROVIDER`: openai | pollinations | none (auto-detected if not set)
- `IMAGE_QUALITY`: low | medium | high | auto (OpenAI only, default: low)

**Image provider auto-detection:** When `IMAGE_PROVIDER` is not set:
- `github-models` → Pollinations free tier (no key, no cost)
- `pollinations` with `sk_*` key → Pollinations with key (parallel)
- `pollinations` with `pk_*` key → Pollinations free tier (pollen preserved for text)
- `openai` → OpenAI images (paid)

### Shopware Module

Inheritance hierarchy:

```
ShopwareClient (auth, base API)
    └── ShopwareHydrator (create operations, SalesChannels, category trees)
    └── ShopwareExporter (export/sync existing data)
    └── ShopwareCleanup (delete operations, SalesChannel-centric)
    └── DataHydrator (combines all three via composition)
```

### Export/Sync from Shopware

When a SalesChannel already exists in Shopware, data is synced to cache before generation.
The `ShopwareExporter` class handles fetching and normalizing existing data:

```typescript
// In DataHydrator (delegates to ShopwareExporter)
const exported = await hydrator.exportSalesChannel(existingSalesChannel);
// Returns: ExportResult { categories, products, propertyGroups, productCount, validation }

// Validation stats track data quality (from types/export.ts):
interface ExportValidation {
    categoriesWithoutDescription: number; // Placeholder added
    categoriesWithImages: number; // Preserved
    productsWithoutDescription: number; // Placeholder added
    productsWithDefaultPrice: number; // Default €29.99
    propertyGroupsWithoutOptions: number; // Skipped
}
```

Data normalization (uses utilities from `utils/strings.ts`):

- Descriptions: HTML stripped, entities decoded, whitespace collapsed
- Prices: Rounded to 2 decimals, zero/missing → €29.99
- Names: Trimmed, whitespace collapsed
- Property groups: Must have options, colorHexCode defaults for color type

### Shared Utilities

Centralized utilities in `utils/` avoid code duplication:

```typescript
// Retry with exponential backoff (utils/retry.ts)
import { executeWithRetry, sleep } from "./utils/index.js";
await executeWithRetry(() => apiCall(), { maxRetries: 3, baseDelay: 2000 });

// String normalization and hashing (utils/strings.ts)
import {
    normalizeDescription,
    capitalizeString,
    createShortHash,
    generateNumericHash,
} from "./utils/index.js";
const clean = normalizeDescription("<p>HTML &amp; entities</p>"); // "HTML & entities"
const hash = createShortHash("long-option-name-suffix", 5); // deterministic 5-char alphanumeric hash
const digits = generateNumericHash("product-id-ean", 12); // 12-digit deterministic numeric string (for EANs)

// Category tree operations (utils/category-tree.ts)
import { countCategories, getLeafCategories, collectCategoryIdsByPath } from "./utils/index.js";
const leaves = getLeafCategories(categoryTree);
const ids = collectCategoryIdsByPath(categoryTree); // Map<path, id> (e.g., "Living Room > Sofas")

// Concurrency limiting (utils/concurrency.ts)
import { ConcurrencyLimiter } from "./utils/index.js";
const limiter = new ConcurrencyLimiter(5);
const results = await limiter.all(tasks.map((t) => () => processTask(t)));
```

### Caching (SalesChannel-scoped)

Cache is organized with universal properties at the root and store-specific data per SalesChannel:

```
generated/
├── properties/                     # Universal properties (Color only)
│   ├── color.json                  # Color with hex codes
│   └── index.json
└── sales-channels/
    └── {salesChannel}/
        ├── metadata.json           # SalesChannel info
        ├── blueprint.json          # Phase 1 output
        ├── hydrated-blueprint.json # Phase 2 output
        ├── cms-blueprint.json      # AI-hydrated CMS text (used by CMS processors)
        ├── categories.json         # Category tree
        ├── property-groups.json    # Property groups synced from Shopware
        ├── properties/             # Store-specific AI-generated properties
        │   ├── volume.json         # e.g., for beauty store
        │   ├── scent.json
        │   └── index.json
        ├── metadata/
        │   └── {productId}.json    # Per-product metadata
        └── images/                 # Reorganized by media type
            ├── product_media/
            │   └── {productId}.webp
            ├── category_media/
            │   └── {categoryId}.webp
            ├── cms_media/
            │   └── *.webp          # CMS block images
            ├── property_images/
            │   └── *.webp
            └── theme_media/
                ├── store-logo.webp
                ├── store-favicon.webp
                └── store-share.webp

logs/
└── generator-{timestamp}.log       # Detailed API logs (not in generated/)
```

**Property system:**

- **Universal properties** (only `Color`): Stored in `generated/properties/` with hex codes
- **Store-specific properties**: AI-generated based on store context, stored in each SalesChannel's `properties/` folder

## Code Conventions

### No Domain-Specific Hardcoding

**NEVER hardcode store-type-specific values (e.g., "furniture", "beauty", "garden").** This generator supports ANY store type that users might create.

```typescript
// Bad: Hardcoded domain examples
const prompt = `Generate category names for a furniture webshop.`;
const synonyms = { "pot size": "size", "blade material": "material" };
const prefixes = ["guitar", "piano", "plant", "flower"];

// Good: Use dynamic store context
const prompt = `Generate category names for this webshop.
Store: "${storeContext.name}"
Description: ${storeContext.description}`;

// Good: Generic pattern matching
if (normalizedName.endsWith(cachedName)) {
    return cachedName; // "Pot Size" matches cached "Size"
}
```

Key principles:

- AI prompts should derive context from `storeContext.name` and `storeContext.description`
- Property/category normalization should use generic pattern matching, not hardcoded synonyms
- Examples in prompts should be abstract or derived from the actual store type
- The only hardcoded property is `Color` (universal across all domains)

### AI Generation Timing

**AI generation happens ONLY during blueprint hydration, NEVER in post-processors.**

Post-processors must be fast and deterministic. All AI-generated content should be:

1. Generated during the blueprint hydration phase (Phase 2)
2. Stored in cache or fixtures for reuse
3. Loaded from fixtures/cache at runtime

This applies to both **text** and **all images**:

- **Text**: Hydrated via `BlueprintHydrator` (product/category) and `hydrateCmsBlueprint` (CMS pages)
- **CMS images**: Pre-generated via `hydrateCmsImages()` in `src/blueprint/hydrators/image.ts` (20 CMS images)
- **Product/category images**: Pre-generated via `hydrateProductImages()` in `src/blueprint/hydrators/image.ts`
- **Theme media**: Logo, favicon, share icon via `hydrateThemeMedia()` in `src/blueprint/hydrators/image.ts`

The image hydrator in `src/blueprint/hydrators/image.ts` centralizes ALL image generation.

**Image post-processing with `sharp`:** AI image generators (e.g. OpenAI) only support fixed canvas
sizes like 1024x1024 or 1536x1024. When specific dimensions are needed (e.g. 474x70 for a logo),
the `trimAndResize()` function trims whitespace borders and resizes to the exact target dimensions.
This is applied to all theme media (logo, favicon, share icon) during hydration.

| Theme Image     | Target Size | Purpose                      |
| --------------- | ----------- | ---------------------------- |
| `store-logo`    | 474×70      | Desktop/tablet/mobile header |
| `store-favicon` | 96×96       | Browser favicon              |
| `store-share`   | 1200×630    | Social media sharing card    |

Post-processors only read from cache and upload to Shopware. An architectural test
(`tests/unit/post-processors/no-ai-in-processors.test.ts`) enforces this rule by scanning
post-processor source files for `.generateImage(` and `.generateCompletion(` calls.

```typescript
// Bad: AI call in post-processor (slow, non-deterministic)
async process(context) {
    const description = await this.textProvider.generate("Create gift card description");
    await this.createProduct({ description });
}

// Bad: Image generation in post-processor
async process(context) {
    const image = await context.imageProvider.generateImage(prompt);
    await this.uploadImage(image);
}

// Good: Use pre-defined fixture content
import { GIFT_CARD_50 } from "../fixtures/digital-products.js";

async process(context) {
    await this.createProduct({
        name: GIFT_CARD_50.name,
        description: GIFT_CARD_50.description,
    });
}

// Good: Read pre-cached image (generated during hydration)
async process(context) {
    const mediaId = await this.getOrCreateCmsMedia(context, "img-slider-0");
}
```

Benefits:

- **Fast execution**: No waiting for AI API calls
- **Deterministic**: Same content every time
- **Testable**: Fixtures can be unit tested
- **Reusable**: Same content across all SalesChannels

### Idempotency

**All data creation operations MUST be idempotent.** Before creating any entity in Shopware, always check if it already exists:

```typescript
// Good: Check before creating
const existingId = await this.findCmsPageByName("Video Elements");
if (!existingId) {
    // Create the page
    console.log(`✓ Created CMS page "Video Elements"`);
} else {
    console.log(`⊘ CMS page "Video Elements" already exists`);
}

// Bad: Create without checking
await this.createCmsPage("Video Elements"); // May fail or create duplicates
```

Use these lookup methods from `ShopwareClient`:

- `findCmsPageByName(name)` - Find CMS page by name
- `getCmsPageById(id)` - Get full CMS page with associations
- `findCategoryByName(name, parentId)` - Find category under parent
- `getStandardSalesChannel(name)` - Find sales channel by name (with Storefront type fallback)
- `getFullSalesChannel(name)` - Full sales channel details for cloning (with Storefront type fallback)

Console output conventions for idempotent operations:

- `✓` - Successfully created new entity
- `⊘` - Entity already exists, skipped

### Fixtures

Static data configurations (CMS pages, review templates, etc.) belong in `src/fixtures/`:

```typescript
// Good: Import fixture from centralized location
import { VIDEO_ELEMENTS_PAGE, REVIEWER_NAMES } from "../fixtures/index.js";

// Bad: Inline large data structures in processor files
const FIRST_NAMES = ["Emma", "Liam", ...]; // Move to fixtures
```

Benefits:

- Easier to maintain and extend
- Can be reused across processors
- Type-safe with dedicated interfaces
- Cleaner processor code

### Unit Tests

**All new code MUST have unit tests.**

See **[tests/AGENTS.md](tests/AGENTS.md)** for detailed testing documentation including:

- Directory structure (must mirror `src/`)
- Test patterns and best practices
- Mock providers usage
- Running tests

### Imports

- Import types from `./types/index.js` (centralized)
- Use `import type` for type-only imports
- Imports are auto-sorted by `oxfmt`

```typescript
// Correct
import type { CategoryNode, SalesChannelInput } from "./types/index.js";
import { DataHydrator } from "./shopware/index.js";
```

### TypeScript

- Explicit types on all function parameters and returns
- Use interfaces over type aliases for objects
- Avoid `any` - use `unknown` or specific types
- Use `z.ZodTypeAny` instead of `z.ZodType<any>`

### Clean Code

Follow these principles for maintainable, readable code:

#### 1. Single Responsibility - One Function Does One Thing

```typescript
// Bad: Function does multiple things
async cleanup(context) {
    // 50 lines handling categories, landing pages, CMS pages, associations...
}

// Good: Break into focused functions
async cleanup(context) {
    const categoryResult = await this.cleanupCategories(context);
    const landingPageResult = await this.cleanupLandingPage(context);
    return this.mergeResults(categoryResult, landingPageResult);
}
```

#### 2. No Else Statements - Use Early Returns

```typescript
// Bad: Nested if/else pyramid
if (landingPageData) {
    if (isAssociated) {
        if (removed) {
            // deep nesting...
        } else {
            errors.push("Failed");
        }
    } else {
        console.log("Not associated");
    }
} else {
    // fallback...
}

// Good: Guard clauses with early returns
if (!landingPageData) {
    return this.deleteLandingPageDirectly(context, landingPageId);
}
if (!isAssociated) {
    console.log("Not associated");
    return { deleted: 0 };
}
const removed = await this.removeSalesChannel(...);
if (!removed) {
    return { errors: ["Failed to remove"] };
}
// Happy path continues flat...
```

#### 3. Maximum 2-3 Levels of Indentation

```typescript
// Bad: 5+ levels deep
async process() {
    if (x) {
        for (const item of items) {
            if (y) {
                try {
                    if (z) {  // Too deep!
                    }
                }
            }
        }
    }
}

// Good: Extract to functions
async process() {
    if (!x) return;
    await Promise.all(items.map(item => this.processItem(item)));
}
```

#### 4. Functional Programming - Prefer map/filter/reduce

```typescript
// Bad: Imperative loops with mutations
const salesChannelIds: string[] = [];
for (const sc of relData) {
    if (sc.id) salesChannelIds.push(sc.id);
}

// Good: Functional approach
const salesChannelIds = relData.filter((sc) => sc.id).map((sc) => sc.id);
```

#### 5. Descriptive Function Names - What, Not How

```typescript
// Bad: Generic or implementation-focused names
async handleLandingPage() { ... }
async doCleanup() { ... }

// Good: Describes intent clearly
async ensureSalesChannelAssociated() { ... }
async removeSalesChannelFromLandingPage() { ... }
async deleteOrphanedLandingPage() { ... }
```

#### 6. Return Early, Return Often

```typescript
// Bad: Single return at end with result variable
async findEntity(id: string): Promise<Entity | null> {
    let result = null;
    if (id) {
        const data = await fetch(...);
        if (data) {
            result = data;
        }
    }
    return result;
}

// Good: Return as soon as you know the answer
async findEntity(id: string): Promise<Entity | null> {
    if (!id) return null;
    const data = await fetch(...);
    return data ?? null;
}
```

#### 7. DRY - Don't Repeat Yourself

```typescript
// Bad: Same logic duplicated in multiple places
async cleanupMusic() {
    const sc = await this.findSalesChannel("music");
    if (!sc) return;
    await this.deleteCategories(sc.id);
    await this.deleteLandingPage(sc.id);
}

async cleanupBeauty() {
    const sc = await this.findSalesChannel("beauty");
    if (!sc) return;
    await this.deleteCategories(sc.id);
    await this.deleteLandingPage(sc.id);
}

// Good: Extract shared logic into reusable function
async cleanupSalesChannel(name: string) {
    const sc = await this.findSalesChannel(name);
    if (!sc) return;
    await this.deleteCategories(sc.id);
    await this.deleteLandingPage(sc.id);
}
```

#### 8. Reuse Existing Functions - Check Before Creating

Before writing a new function, search the codebase for existing utilities:

```typescript
// Bad: Creating a new helper that already exists
function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// Good: Use existing utility from utils/
import { capitalizeString } from "./utils/index.js";
```

Common utilities already available in `utils/`:

- `executeWithRetry()` - Retry with exponential backoff
- `normalizeDescription()` - Strip HTML, decode entities
- `capitalizeString()` - Capitalize first letter
- `createShortHash()` - Deterministic short hash for unique suffixes
- `countCategories()`, `getLeafCategories()` - Tree operations
- `ConcurrencyLimiter` - Parallel processing with limits

#### 9. Organized File Structure - Right Place for Everything

See [Project Structure](#project-structure) for the full directory layout. Key principle:

```typescript
// Bad: Utility function buried in a processor file
// src/post-processors/image-processor.ts
function generateRandomHex(): string { ... }  // Should be in utils/

// Good: Utilities in dedicated location
// src/utils/strings.ts
export function generateRandomHex(): string { ... }
```

#### 10. Extract When Used Twice

If you write the same code in two places, extract it:

```typescript
// Bad: Same pattern in multiple files
// file1.ts
const salesChannelIds =
    data.relationships?.salesChannels?.data?.filter((sc) => sc.id).map((sc) => sc.id) ?? [];

// file2.ts
const salesChannelIds =
    data.relationships?.salesChannels?.data?.filter((sc) => sc.id).map((sc) => sc.id) ?? [];

// Good: Extract to utility
// utils/shopware.ts
export function extractSalesChannelIds(data: ShopwareEntity): string[] {
    return data.relationships?.salesChannels?.data?.filter((sc) => sc.id).map((sc) => sc.id) ?? [];
}
```

### MCP Server Sync

**All CLI commands MUST be exposed via the MCP server.**

When adding a new command to any CLI entry point (`main.ts`, `cache-cli.ts`, `cleanup-cli.ts`):

1. Create or update the corresponding tool in `src/mcp/tools/`
2. Use Zod schemas matching the CLI parameters
3. Import and call the same underlying functions (don't duplicate logic)
4. Test with `bun run mcp:dev`

This ensures AI assistants can discover and use all commands without manual lookup.

```typescript
// Good: MCP tool calls the same function as CLI
server.addTool({
    name: "blueprint_create",
    parameters: z.object({
        name: z.string(),
        products: z.number().default(90),
    }),
    execute: async (args) => {
        // Reuse existing logic
        const generator = new BlueprintGenerator({ totalProducts: args.products });
        const blueprint = generator.generateBlueprint(args.name, description);
        cache.saveBlueprint(args.name, blueprint);
        return `Blueprint created for ${args.name}`;
    },
});
```

### Linting & Formatting

- **Linter:** `oxlint` (via `bun run lint`)
- **TypeCheck:** `tsc --noEmit` (included in `bun run lint`)
- **Formatter:** `oxfmt` (via `bun run format`). Scripts use `npx oxfmt` so formatting runs under Node; under Bun, oxfmt’s worker threads trigger DataCloneError for JSON/markdown (see [bun#25610](https://github.com/oven-sh/bun/issues/25610)).
- **Build:** `bun run build` runs lint + format + bun build

## Environment Variables

```env
# AI Provider — pick one:
AI_PROVIDER=github-models              # Free with GitHub Copilot (recommended)
AI_API_KEY=ghp_your_github_token       # github.com/settings/tokens
# AI_PROVIDER=pollinations             # Alternative: enter.pollinations.ai
# AI_API_KEY=sk_your_pollinations_key  # sk_ = parallel, pk_ = sequential

# Optional overrides
AI_MODEL=gpt-4o
IMAGE_PROVIDER=pollinations|openai|none  # Auto-detected: github-models/pk_ → free Pollinations
IMAGE_API_KEY=xxx                        # Not needed for github-models or pk_ keys
IMAGE_MODEL=gpt-image-1-mini  # Default; or gpt-image-1, gpt-image-1.5, flux, turbo, klein
IMAGE_QUALITY=low  # OpenAI only: low (fastest/cheapest), medium, high, auto

# Shopware connection
SW_ENV_URL=http://localhost:8000
SW_CLIENT_ID=xxx
SW_CLIENT_SECRET=xxx

# Cache
CACHE_DIR=./generated
CACHE_ENABLED=true

# Server
SERVER_PORT=3000
```

## CLI Usage

```bash
# Phase 1: Create blueprint (no AI)
bun run blueprint create --name=music --description="Musical instruments and accessories for musicians of all levels"

# Phase 2: Hydrate with AI
bun run blueprint hydrate --name=music

# Phase 2b: Selective re-hydration (preserves product names for image stability)
bun run blueprint hydrate --name=music --only=categories  # Categories only
bun run blueprint hydrate --name=music --only=properties  # Properties only
bun run blueprint hydrate --name=music --rehydrate        # Full re-hydration

# Phase 2c: Fix placeholder names (if hydration was incomplete)
bun run blueprint fix --name=music

# Phase 3: Upload to Shopware
bun run generate --name=music

# Run post-processors separately
bun run process --name=music --only=images,manufacturers

# Full pipeline (creates blueprint, hydrates, and uploads if needed)
bun run generate --name=music --description="Musical instruments and accessories for musicians of all levels"
```

### Blueprint Options

```bash
bun run blueprint create \
  --name=NAME              # Required: SalesChannel name (becomes subdomain)
  --description=TEXT       # Context for AI generation (default: "{name} webshop")
  --products=N             # Products to generate (default: 90)
```

### Hydration Options

```bash
bun run blueprint hydrate \
  --name=NAME              # Required: SalesChannel name
  --only=MODE              # Selective: "categories", "properties", or "cms"
  --rehydrate              # Force full re-hydration (changes names, triggers image regen)
```

Hydration modes:

- **Default (new)**: Full hydration, generates everything
- **--only=categories**: Only update category names/descriptions, preserve all product data
- **--only=properties**: Only update product properties, preserve names (for image stability)
- **--only=cms**: Only hydrate CMS blueprint text (`cms-blueprint.json`)
- **--rehydrate**: Force full re-hydration even if hydrated blueprint exists

Safety: If hydrated blueprint exists, requires `--only` or `--rehydrate` to prevent accidental name changes.

### Generate Options

```bash
bun run generate \
  --name=NAME              # Required: SalesChannel name
  --description=TEXT       # Description (default: "{name} webshop")
```

### Process Options

```bash
bun run process \
  --name=NAME              # Required: SalesChannel name
  --only=PROCESSORS        # Run specific processors (images,manufacturers,reviews,variants,customers)
  --dry-run                # Preview without making changes
```

### Image Fix Options

```bash
bun run image fix \
  --name=NAME              # Required: SalesChannel name
  --target=TARGET          # Product/category name or ID, CMS page name, or theme media key
  --type=TYPE              # "product" (default), "category", "cms", or "theme"
  --dry-run                # Preview without regenerating

# Theme media examples
bun run image fix --name=music --type=theme                  # Regenerate all theme media
bun run image fix --name=music --type=theme --target=logo    # Regenerate logo only
```

### Cleanup (SalesChannel-centric)

```bash
bun run cleanup -- --salesChannel="music"                  # Delete products + categories
bun run cleanup -- --salesChannel="music" --props          # Also delete property groups
bun run cleanup -- --salesChannel="music" --manufacturers  # Also delete manufacturers
bun run cleanup -- --salesChannel="music" --delete         # Also delete SalesChannel
bun run cleanup -- --salesChannel="music" --processors=cms # Cleanup specific processor entities
bun run cleanup:media                                      # Delete orphaned product images
```

**Processor-specific cleanup:** Use `--processors=<list>` to cleanup only entities created by specific
post-processors. Each processor implements its own `cleanup()` method that knows how to remove its entities.
Available processors with cleanup: `cms`, `customers`.

### E2E Testing

```bash
./test-e2e.sh                              # Full E2E test pipeline
./test-e2e.sh --reuse=music               # Reuse existing blueprint
./test-e2e.sh --reuse=music --skip-hydrate # Skip AI, just upload
./test-e2e.sh --cleanup=music             # Only cleanup specific SalesChannel
bun run test:verify --name=music          # Verify Shopware data
```

## Testing

```bash
bun test                    # Run all tests
bun test --watch            # Watch mode
bun test --coverage         # With coverage report
```

See **[tests/AGENTS.md](tests/AGENTS.md)** for detailed testing documentation.

## Development Commands

```bash
# Build (includes lint + format + typecheck)
bun run build

# Run in dev mode with watch
bun run dev

# Start HTTP server
bun run server

# Cache management
bun run cache:list                    # List cached SalesChannels
bun run cache:clear                   # Move all cache to trash
bun run cache:clear -- music         # Move specific SalesChannel to trash
bun run cache:trash                   # List trash contents
bun run cache:restore -- <item>       # Restore item from trash
bun run cache:restore -- --all        # Restore all items from trash
bun run cache:empty-trash             # Permanently delete trash

# Log management
bun run logs:clear

# Cleanup Shopware data
bun run cleanup -- --salesChannel="test"
bun run cleanup -- --salesChannel="test" --props --manufacturers
bun run cleanup -- --salesChannel="test" --processors=cms  # Cleanup specific processor entities
bun run cleanup:props
bun run cleanup:media

# MCP Server (Cursor AI integration)
bun run mcp             # Run MCP server (stdio)
bun run mcp:dev         # Interactive terminal testing
bun run mcp:inspect     # Web UI inspector
```

## MCP Server (Cursor Integration)

This project includes an MCP server that exposes CLI commands as tools for Cursor AI.
This enables auto-discovery of available commands without grepping the codebase.

### Why MCP?

Instead of grepping the codebase to discover commands, Cursor auto-discovers tools via MCP:

- **Self-documenting**: All commands have schemas with parameters, types, and descriptions
- **Validated**: Parameters are validated before execution
- **Structured output**: JSON responses instead of parsing stdout

### Available Tools

| Tool                   | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| `blueprint_create`     | Generate blueprint.json (no AI)                        |
| `blueprint_hydrate`    | Fill blueprint with AI content (supports `--only=cms`) |
| `blueprint_fix`        | Fix placeholder names                                  |
| `image_fix`            | Regenerate images (product/category/cms by type)       |
| `generate`             | Full pipeline: create + hydrate + upload               |
| `process`              | Run post-processors                                    |
| `cache_list`           | List cached SalesChannels                              |
| `cache_clear`          | Clear cache to trash                                   |
| `cache_trash`          | List trash contents                                    |
| `cache_restore`        | Restore from trash                                     |
| `cache_empty_trash`    | Permanently delete trash                               |
| `list_saleschannels`   | List available SalesChannels                           |
| `cleanup`              | Delete SalesChannel data                               |
| `cleanup_media`        | Delete orphaned media                                  |
| `cleanup_unused_props` | Delete unused property groups                          |
| `list_processors`      | List available post-processors                         |

### Testing the MCP Server

```bash
# Interactive terminal testing (mcp-cli)
bun run mcp:dev

# Web UI inspector
bun run mcp:inspect
```

The inspector opens a web UI where you can:

- See all discovered tools with their schemas
- Test tools with different parameters
- Inspect responses in real-time

### Cursor Configuration

The `.cursor/mcp.json` uses `/bin/sh` to resolve `$HOME` dynamically, so it works on any machine without editing:

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

If your `bun` is installed elsewhere, adjust the path in the `args` accordingly. Restart Cursor to load the MCP server.

## Common Tasks

### Adding a New Provider

1. Create `src/providers/new-provider.ts`
2. Implement `TextProvider` and/or `ImageProvider`
3. Add to factory switch statement in `factory.ts`
4. Add type to `AIProviderType` in `types/providers.ts`
5. Export from `providers/index.ts`

### Adding Shopware Operations

1. Add method to appropriate file:
    - `shopware/hydrator.ts` for create operations
    - `shopware/cleanup.ts` for delete operations
2. If new type needed, add to `types/shopware.ts`
3. Export from `types/index.ts`

### Adding New Types

1. Add interface to appropriate file in `types/`
2. Export from `types/index.ts`
3. Import from `./types/index.js` where needed

### Adding New CLI Commands

When adding a new CLI command, you MUST also add it to the MCP server:

1. Implement the command logic in the appropriate CLI file (`main.ts`, `cache-cli.ts`, `cleanup-cli.ts`)
2. Add corresponding MCP tool in `src/mcp/tools/<category>.ts`
3. Use Zod schemas that match CLI parameters
4. Register the tool in `src/mcp/index.ts` if creating a new category
5. Test with `bun run mcp:dev`

This ensures Cursor can discover and use new commands without manual documentation lookup.

### Adding Post-Processor Cleanup

Post-processors can optionally implement a `cleanup()` method to remove entities they created:

```typescript
async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
    const errors: string[] = [];
    let deleted = 0;

    if (context.options.dryRun) {
        console.log(`    [DRY RUN] Would delete entities...`);
        return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
    }

    // Delete entities in reverse order (children before parents)
    // ... deletion logic ...

    return { name: this.name, deleted, errors, durationMs: 0 };
}
```

Run cleanup via CLI: `bun run cleanup -- --salesChannel="name" --processors=processor1,processor2`

### Rate Limit Handling

All API calls use `executeWithRetry()` for automatic retry on 429 errors:

```typescript
const result = await executeWithRetry(() =>
    this.textProvider.generateCompletion([...])
);
```

Exponential backoff: 10s → 20s → 40s → 80s → 160s, max 5 retries.
Handles GitHub Models' 10 requests/60s limit.

### Logging

**Convention: Never use `console.*` in library modules.** Use `logger.info/warn/error("msg", { cli: true })` for user-facing output and `logger.info/warn/error()` for diagnostics.

```typescript
import { logger } from "./utils/index.js";

// User-facing output (file + console, respects MCP mode)
logger.info("✓ Created SalesChannel", { cli: true });
logger.warn("⚠ Rate limited", { cli: true });
logger.error("✗ Failed", { cli: true });

// Diagnostic logging (file only)
logger.debug("Debug info", { data: someData });
logger.info("Info message");
logger.warn("Recoverable issue", { data: context });
logger.error("Operation failed", { data: error });

// File + console with data
logger.info("Created entity", { cli: true, data: { id, name } });

// Shopware API errors (file + console unless MCP mode)
logger.apiError("endpoint", 500, response);

// Cleanup old logs (keeps last 10 by default)
logger.cleanup(10);
```

Logs are written to `logs/generator-{timestamp}.log`. Clear with `bun run logs:clear`.

**Allowed `console.*` usage:**

- CLI entry points only: `main.ts`, `*-cli.ts`, `server.ts`
- The `logger.ts` file itself
