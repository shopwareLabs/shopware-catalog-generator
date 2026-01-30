# Agent Documentation

Internal documentation for AI agents working on this codebase.

## Runtime

This project uses **Bun** as the runtime instead of Node.js:

- Native TypeScript execution (no compilation for dev)
- Built-in test runner with `bun:test`
- Built-in HTTP server with `Bun.serve`
- Native fetch API (no axios)

## Project Structure

```
src/
├── types/                    # All types - import from here
│   ├── index.ts              # Re-exports all types and schemas
│   ├── shopware.ts           # Shopware entities + Zod schemas
│   ├── blueprint.ts          # Blueprint types (v2)
│   ├── providers.ts          # AI provider interfaces (+ tokenLimit)
│   ├── cache.ts              # Cache configuration types
│   └── export.ts             # Export types (ExportValidation, ExportResult)
│
├── shopware/                 # Shopware API operations
│   ├── index.ts              # DataHydrator (combines all) + exports
│   ├── admin-client.ts       # Official @shopware/api-client wrapper
│   ├── api-helpers.ts        # Convenience methods (searchEntities, syncEntities, etc.)
│   ├── client.ts             # Legacy auth, base client with fetch API
│   ├── hydrator.ts           # Create products/categories/SalesChannels
│   ├── export.ts             # Export/sync existing data + getExistingPropertyGroups
│   └── cleanup.ts            # Delete operations (SalesChannel-centric)
│
├── providers/                # AI provider implementations
│   ├── index.ts              # Exports + factory
│   ├── factory.ts            # Provider creation logic
│   ├── openai-provider.ts    # OpenAI (text + images)
│   ├── github-models-provider.ts  # GitHub Models (text only)
│   ├── pollinations-provider.ts   # Pollinations (text + images, free)
│   └── noop-provider.ts      # Disabled image provider
│
├── generators/               # v2 Blueprint-based generation
│   ├── index.ts              # Exports
│   ├── blueprint-generator.ts    # Generate blueprint structure (no AI)
│   └── blueprint-hydrator.ts     # AI fills blueprint with token limits
│
├── post-processors/          # v2 Post-processors (parallel execution)
│   ├── index.ts              # Interface, registry, ordered runner
│   ├── cms-processor.ts      # CMS landing pages + category links
│   ├── image-processor.ts    # Multi-view image generation
│   ├── manufacturer-processor.ts # Fictional manufacturer creation
│   ├── variant-processor.ts  # Simple v2.0 (marking only)
│   └── review-processor.ts   # Variable review counts
│
├── fixtures/                 # Reusable data configurations
│   ├── index.ts              # Re-exports all fixtures
│   ├── types.ts              # Fixture type definitions
│   ├── cms-pages.ts          # CMS page configurations (video-elements, etc.)
│   └── review-data.ts        # Reviewer names and review templates
│
├── utils/                    # Utility functions
│   ├── index.ts              # Re-exports all utilities
│   ├── validation.ts         # Subdomain validation
│   ├── blueprint-validation.ts # Validate blueprints before sync (duplicates, placeholders)
│   ├── retry.ts              # executeWithRetry, sleep, rate limit handling
│   ├── strings.ts            # normalizeString, stripHtml, capitalizeString
│   ├── category-tree.ts      # countCategories, getLeafCategories, etc.
│   ├── property-collector.ts # Collect, deduplicate, merge properties (v2)
│   ├── concurrency.ts        # ConcurrencyLimiter for parallel processing
│   ├── color-palette.ts      # HEX color values, fuzzy matching
│   └── logger.ts             # File-based logging (logs/ folder)
│
├── server/                   # HTTP server infrastructure
│   ├── index.ts              # Exports ProcessManager + types
│   └── process-manager.ts    # Background task management
│
├── cache.ts                  # DataCache class (+ blueprint storage)
├── main.ts                   # CLI entry point (v2 subcommand-based)
├── server.ts                 # HTTP server entry (Bun.serve)
├── cache-cli.ts              # Cache management CLI
└── cleanup-cli.ts            # Cleanup CLI (+ manufacturer cleanup)

tests/
├── unit/                     # Unit tests
│   ├── blueprint-generator.test.ts  # v2 blueprint tests
│   ├── property-collector.test.ts   # v2 property collector
│   ├── post-processors/             # Post-processor tests
│   │   ├── registry.test.ts
│   │   ├── cms-processor.test.ts
│   │   ├── image-processor.test.ts
│   │   ├── manufacturer-processor.test.ts
│   │   ├── review-processor.test.ts
│   │   └── variant-processor.test.ts
│   ├── cache.test.ts
│   ├── concurrency.test.ts          # ConcurrencyLimiter tests
│   ├── color-palette.test.ts        # Color matching tests
│   ├── entities.test.ts
│   ├── validation.test.ts
│   ├── saleschannel-cache.test.ts
│   ├── shopware-export.test.ts
│   ├── retry.test.ts
│   ├── strings.test.ts
│   └── category-tree.test.ts
├── integration/              # Integration tests
│   └── blueprint.test.ts     # v2 blueprint integration
├── e2e/                      # E2E tests
│   ├── verify.ts             # API verification script
│   └── browser-checks.md     # Browser verification guide
└── mocks/                    # Test mocks
    ├── index.ts
    ├── text-provider.mock.ts
    └── image-provider.mock.ts
```

## Module Documentation

Detailed documentation for each module is in their respective folders:

- **[src/post-processors/AGENTS.md](src/post-processors/AGENTS.md)** - Post-processor system, registry, cleanup, adding new processors
- **[src/providers/AGENTS.md](src/providers/AGENTS.md)** - AI provider interfaces, concurrency settings, adding new providers
- **[src/server/AGENTS.md](src/server/AGENTS.md)** - HTTP server, ProcessManager, background tasks, API endpoints
- **[src/shopware/AGENTS.md](src/shopware/AGENTS.md)** - Shopware API client, hydrator, cleanup, official client wrapper
- **[src/utils/AGENTS.md](src/utils/AGENTS.md)** - Shared utilities (retry, strings, logging, etc.)

## Architecture

### v2 3-Phase Pipeline

The v2 architecture uses a 3-phase pipeline for faster generation:

1. **Phase 1: Blueprint Generation** - Create structure WITHOUT AI (instant)
2. **Phase 2: AI Hydration** - Fill blueprint with AI-generated content (parallel when supported)
3. **Phase 3: Shopware Upload + Post-processors** - Upload and run parallel processors

**Expected times for 90 products:**

| Provider                      | Processing    | Time    |
| ----------------------------- | ------------- | ------- |
| OpenAI                        | Parallel (5x) | ~5 min  |
| Pollinations (sk\_\*)         | Parallel (5x) | ~5 min  |
| GitHub Models                 | Limited (2x)  | ~10 min |
| Pollinations (pk\_\* or free) | Sequential    | ~13 min |

```
flowchart LR
    subgraph Phase1[Phase 1: Blueprint]
        BP[Blueprint Generator] --> JSON[blueprint.json]
    end

    subgraph Phase2[Phase 2: AI Hydration]
        JSON --> AI[Multiple AI Calls]
        AI --> Hydrated[hydrated-blueprint.json]
    end

    subgraph Phase3[Phase 3: Upload + Post-processors]
        Hydrated --> SW[Upload to Shopware]
        SW --> PP1[Image Processor]
        SW --> PP2[Manufacturer Processor]
        SW --> PP3[Review Processor]
    end
```

### SalesChannel-Centric Model

The architecture is centered around SalesChannels:

1. **Blueprint Creation**: Generate complete structure (categories, products) without AI
2. **AI Hydration**: Fill with names, descriptions, properties via multiple AI calls
3. **Shopware Upload**: Create SalesChannel, categories, products, property groups
4. **Post-processors**: Run image, manufacturer, review, variant processors in parallel

```typescript
// v2 Flow
const generator = new BlueprintGenerator();
const blueprint = generator.generateBlueprint("furniture", "Wood furniture store");

const hydrator = new BlueprintHydrator(textProvider);
const hydratedBlueprint = await hydrator.hydrate(blueprint, existingProperties);

// Upload to Shopware
await dataHydrator.createSalesChannel({ name: "furniture", ... });
await dataHydrator.createCategoryTree(categories, rootId, salesChannelId);

// Run post-processors
await runProcessors(context, ["images", "manufacturers", "reviews"]);
```

### Post-Processor System

Post-processors run after initial Shopware upload for resource-intensive tasks:

```typescript
interface PostProcessor {
    readonly name: string;
    readonly description: string;
    readonly dependsOn: string[];  // Dependency ordering
    process(context: PostProcessorContext): Promise<PostProcessorResult>;
}

// Available processors
- cms: CMS landing pages + category links (Video Elements demo page)
- images: Multi-view product/category images
- manufacturers: Fictional manufacturer creation
- variants: Simple tagging (v2.0) - full creation in v2.1
- reviews: Variable review counts (0-10 per product)
```

Processors run in parallel when possible, respecting dependencies:

```typescript
await runProcessors(context, ["images", "manufacturers", "reviews"]);
// Runs: manufacturers → (images, reviews in parallel)
```

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
```

**Provider concurrency settings:**

| Provider                     | maxConcurrency | Notes                           |
| ---------------------------- | -------------- | ------------------------------- |
| OpenAI                       | 5              | High rate limits                |
| GitHub Models                | 2              | 2 concurrent request limit      |
| Pollinations (sk\_\*)        | 5              | Secret keys have no rate limits |
| Pollinations (no key/pk\_\*) | 1              | Sequential due to rate limits   |

Factory in `providers/factory.ts` creates providers from env vars:

- `AI_PROVIDER`: openai | github-models | pollinations
- `IMAGE_PROVIDER`: openai | pollinations | none

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

// String normalization (utils/strings.ts)
import { normalizeDescription, capitalizeString } from "./utils/index.js";
const clean = normalizeDescription("<p>HTML &amp; entities</p>"); // "HTML & entities"

// Category tree operations (utils/category-tree.ts)
import { countCategories, getLeafCategories, collectCategoryIds } from "./utils/index.js";
const leaves = getLeafCategories(categoryTree);
const ids = collectCategoryIds(categoryTree); // Map<name, id>

// Concurrency limiting (utils/concurrency.ts)
import { ConcurrencyLimiter } from "./utils/index.js";
const limiter = new ConcurrencyLimiter(5);
const results = await limiter.all(tasks.map((t) => () => processTask(t)));
```

### Caching (SalesChannel-scoped)

All cache is organized by SalesChannel:

```
generated/
└── sales-channels/
    └── {salesChannel}/
        ├── metadata.json           # SalesChannel info
        ├── categories.json         # Category tree
        ├── property-groups.json    # Property groups with option IDs
        ├── products/
        │   └── {category}/
        │       ├── products.json         # Products per category
        │       └── property-options.json # Option ID->name mapping (for future remapping)
        └── images/
            └── {productId}.webp    # Product images

logs/
└── generator-{timestamp}.log       # Detailed API logs (not in generated/)
```

The `property-options.json` file stores the id-to-name mapping for property options
used in that category's products. This enables future remapping if property groups
are recreated with new IDs.

## Code Conventions

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
- `getStandardSalesChannel(name)` - Find sales channel by name

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

**All new code MUST have unit tests.** Follow these guidelines:

1. **Post-processors**: Test metadata, dry-run mode, and API interactions
2. **Utilities**: Test pure functions with edge cases
3. **Fixtures**: Test that fixture data has expected structure

Test file locations:

- `tests/unit/` - Unit tests for individual modules
- `tests/unit/post-processors/` - Post-processor tests
- `tests/integration/` - Integration tests
- `tests/e2e/` - End-to-end tests

```typescript
// Test pattern for post-processors
describe("ProcessorName", () => {
    describe("metadata", () => {
        test("has correct name", () => { ... });
        test("has description", () => { ... });
        test("has dependencies", () => { ... });
    });

    describe("process - dry run mode", () => {
        test("logs actions without making API calls", async () => { ... });
    });

    describe("process - API calls", () => {
        test("checks for existing entities (idempotency)", async () => { ... });
        test("creates new entities when needed", async () => { ... });
        test("skips creation when entities exist", async () => { ... });
    });
});
```

Run tests:

```bash
bun test                              # All tests
bun test tests/unit/                  # Unit tests only
bun test tests/unit/post-processors/  # Post-processor tests
bun test --watch                      # Watch mode
```

#### Unit Test Best Practices

1. **No Non-Null Assertions (`!`)**: Use type guards instead of `!` operator

```typescript
// Bad: Non-null assertion
expect(meta.variantConfigs!.length).toBeGreaterThan(0);

// Good: Type guard in condition
if (meta.variantConfigs) {
    expect(meta.variantConfigs.length).toBeGreaterThan(0);
}

// Good: Assign after check for multiple uses
const configs = meta.variantConfigs;
if (configs) {
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) { ... }
}
```

2. **Use `bun:test` imports**: Always use Bun's native test runner

```typescript
import { describe, expect, test, mock, beforeEach } from "bun:test";
```

3. **Mock external dependencies**: Use `mock()` from `bun:test` or dedicated mocks in `tests/mocks/`

```typescript
import { createMockApiHelpers } from "../../mocks/index.js";

const mockApi = createMockApiHelpers();
mockApi.mockPostResponse("search/product", { data: [...] });
```

4. **Test structure**: Group related tests with `describe()`, use descriptive test names

```typescript
describe("ModuleName", () => {
    describe("methodName", () => {
        test("returns expected result for valid input", () => { ... });
        test("throws error for invalid input", () => { ... });
        test("handles edge case X", () => { ... });
    });
});
```

5. **Avoid test interdependence**: Each test should be independent and not rely on state from other tests

6. **Test edge cases**: Empty arrays, null/undefined, boundary values, error conditions

7. **Keep tests focused**: One assertion concept per test (multiple `expect()` calls are fine if testing the same behavior)

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
const salesChannelIds = relData
    .filter(sc => sc.id)
    .map(sc => sc.id);
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
const salesChannelIds = data.relationships?.salesChannels?.data
    ?.filter(sc => sc.id)
    .map(sc => sc.id) ?? [];

// file2.ts
const salesChannelIds = data.relationships?.salesChannels?.data
    ?.filter(sc => sc.id)
    .map(sc => sc.id) ?? [];

// Good: Extract to utility
// utils/shopware.ts
export function extractSalesChannelIds(data: ShopwareEntity): string[] {
    return data.relationships?.salesChannels?.data
        ?.filter(sc => sc.id)
        .map(sc => sc.id) ?? [];
}
```

### Linting & Formatting

- **Linter:** `oxlint` (via `bun run lint`)
- **TypeCheck:** `tsc --noEmit` (included in `bun run lint`)
- **Formatter:** `oxfmt` (via `bun run format`)
- **Build:** `bun run build` runs lint + format + bun build

## Environment Variables

```env
# Required for paid providers
AI_PROVIDER=pollinations|github-models|openai
AI_API_KEY=xxx

# Optional overrides
AI_MODEL=gpt-4o
IMAGE_PROVIDER=pollinations|openai|none
IMAGE_API_KEY=xxx
IMAGE_MODEL=flux|turbo|klein

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

## CLI Usage (v2 Subcommand-based)

```bash
# Phase 1: Create blueprint (no AI)
bun run blueprint create --name=furniture --description="Wood furniture store"

# Phase 2: Hydrate with AI
bun run blueprint hydrate --name=furniture

# Phase 2b: Fix placeholder names (if hydration was incomplete)
bun run blueprint fix --name=furniture

# Phase 3: Upload to Shopware
bun run generate --name=furniture

# Run post-processors separately
bun run process --name=furniture --only=images,manufacturers

# Full pipeline (creates blueprint, hydrates, and uploads if needed)
bun run generate --name=furniture --description="Wood furniture store"
```

### Blueprint Options

```bash
bun run blueprint create \
  --name=NAME              # Required: SalesChannel name (becomes subdomain)
  --description=TEXT       # Context for AI generation (default: "{name} webshop")
  --products=N             # Products to generate (default: 90)
```

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
  --only=PROCESSORS        # Run specific processors (images,manufacturers,reviews,variants)
  --dry-run                # Preview without making changes
```

### Cleanup (SalesChannel-centric)

```bash
bun run cleanup -- --salesChannel="furniture"                  # Delete products + categories
bun run cleanup -- --salesChannel="furniture" --props          # Also delete property groups
bun run cleanup -- --salesChannel="furniture" --manufacturers  # Also delete manufacturers
bun run cleanup -- --salesChannel="furniture" --delete         # Also delete SalesChannel
bun run cleanup -- --salesChannel="furniture" --processors=cms # Cleanup specific processor entities
bun run cleanup:media                                          # Delete orphaned product images
```

**Processor-specific cleanup:** Use `--processors=<list>` to cleanup only entities created by specific
post-processors. Each processor implements its own `cleanup()` method that knows how to remove its entities.
Available processors with cleanup: `cms`.

### E2E Testing

```bash
./test-e2e.sh                              # Full E2E test pipeline
./test-e2e.sh --reuse=furniture            # Reuse existing blueprint
./test-e2e.sh --reuse=furniture --skip-hydrate  # Skip AI, just upload
./test-e2e.sh --cleanup=furniture          # Only cleanup specific SalesChannel
bun run test:verify --name=furniture       # Verify Shopware data
```

## Testing

```bash
# Run all tests
bun test

# Run tests with watch mode
bun test --watch

# Run tests with coverage
bun test --coverage

# Run specific test file
bun test tests/unit/validation.test.ts
```

### Mock Providers

Test mocks support both static and dynamic responses:

```typescript
// Static response
textProvider.setResponse("products", { products: [...] });

// Dynamic response (parses prompt to determine count)
textProvider.setDynamicResponse("products", (messages) => {
    const prompt = messages[0]?.content || "";
    const match = prompt.match(/for (\d+) different products/);
    const count = match ? parseInt(match[1], 10) : 5;
    return { products: generateMockProducts(count) };
});
```

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
bun run cache:clear -- furniture      # Move specific SalesChannel to trash
bun run cache:trash                   # List trash contents
bun run cache:restore -- <item>       # Restore item from trash
bun run cache:empty-trash             # Permanently delete trash

# Log management
bun run logs:clear

# Cleanup Shopware data
bun run cleanup -- --salesChannel="test"
bun run cleanup -- --salesChannel="test" --props --manufacturers
bun run cleanup -- --salesChannel="test" --processors=cms  # Cleanup specific processor entities
bun run cleanup:props
bun run cleanup:media
```

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

File-based logging keeps CLI clean while preserving debug info:

```typescript
import { logger } from "./utils/index.js";

logger.debug("Debug info", { data }); // File only
logger.info("Info message"); // File only
logger.warn("Warning"); // File + console
logger.apiError("endpoint", 500, response); // File (full) + console (brief)
```

Logs are written to `logs/generator-{timestamp}.log`. Clear with `bun run logs:clear`.
