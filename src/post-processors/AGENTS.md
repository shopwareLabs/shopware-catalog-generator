# Post-Processors Documentation

Internal documentation for AI agents working on the post-processors module.

## Overview

Post-processors run after the initial Shopware upload to handle resource-intensive tasks:

- Image generation and upload
- Manufacturer creation
- Review generation
- Variant creation
- Cross-selling relationships
- Demo customer accounts (B2B group)
- CMS page setup
- Theme customization (brand colors, logo, favicon, share icon)

## Architecture

### Post-Processor Interface

```typescript
interface PostProcessor {
    readonly name: string;
    readonly description: string;
    readonly dependsOn: string[]; // Dependency ordering

    process(context: PostProcessorContext): Promise<PostProcessorResult>;
    cleanup?(context: PostProcessorContext): Promise<PostProcessorCleanupResult>;
}
```

### PostProcessorContext

All processors receive a shared context:

```typescript
interface PostProcessorContext {
    salesChannelId: string;
    salesChannelName: string;
    blueprint: HydratedBlueprint;
    cache: DataCacheApi; // Cache API interface (not the full DataCache class)
    textProvider?: TextProvider;
    imageProvider?: ImageProvider;
    api: ShopwareApiHelpers; // Required — always use this for API calls
    options: PostProcessorOptions;
}
```

`shopwareUrl` and `getAccessToken` have been removed. All API calls MUST go through `context.api`.

`PostProcessorOptions`:

```typescript
interface PostProcessorOptions {
    batchSize: number; // Batch size for parallel operations (default: 5)
    dryRun: boolean;
    activeProcessors?: string[]; // List of selected processors for conditional rendering
}
```

### Registry and Execution

Processors are registered in a global registry and run with dependency ordering:

```typescript
// Register a processor
registry.register(MyProcessor);

// Run selected processors
const results = await runProcessors(context, ["images", "reviews"]);

// Run processor cleanup
const cleanupResults = await cleanupProcessors(context, ["images", "reviews"]);
```

## Available Processors

| Processor        | Name               | Dependencies                               | Has Cleanup |
| ---------------- | ------------------ | ------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------- |
| CMS Homepage     | `cms-home`         | `customers`, `promotions`, `cross-selling` | Yes         | Conditionally renders credential table, promotion codes, and Cross-Selling bullet based on `activeProcessors` |
| CMS Text         | `cms-text`         | none                                       | Yes         |
| CMS Images       | `cms-images`       | none                                       | Yes         |
| CMS Video        | `cms-video`        | none                                       | Yes         |
| CMS Text+Images  | `cms-text-images`  | none                                       | Yes         |
| CMS Commerce     | `cms-commerce`     | `images`                                   | Yes         |
| CMS Form         | `cms-form`         | none                                       | Yes         |
| CMS Footer Pages | `cms-footer-pages` | none                                       | Yes         |
| CMS Testing      | `cms-testing`      | all `cms-*`, `digital-product`             | Yes         |
| Cross-Selling    | `cross-selling`    | none                                       | Yes         |
| Customers        | `customers`        | none                                       | Yes         |
| Digital Product  | `digital-product`  | none                                       | Yes         |
| Images           | `images`           | none                                       | Yes         |
| Manufacturers    | `manufacturers`    | none                                       | Yes         |
| Promotions       | `promotions`       | none                                       | Yes         |
| Reviews          | `reviews`          | none                                       | Yes         |
| Theme            | `theme`            | none                                       | Yes         |
| Variants         | `variants`         | `manufacturers`                            | Yes         |

## Cleanup Implementation

All processors should implement cleanup with SalesChannel scoping:

```typescript
async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
    // Step 1: Get products in THIS SalesChannel only
    const products = await context.api.searchEntities("product", [
        { type: "equals", field: "visibilities.salesChannelId", value: context.salesChannelId }
    ]);

    // Step 2: Find related entities
    const productIds = products.map(p => p.id);

    // Step 3: Delete only entities for those products
    // ... cleanup logic

    return { name: this.name, deleted: count, errors: [], durationMs: 0 };
}
```

### Critical: SalesChannel Scoping

All cleanup queries MUST filter by SalesChannel to avoid deleting entities from other SalesChannels.

## Conditional Rendering with `activeProcessors`

The `HomeProcessor` and similar processors can conditionally render content based on which processors are actually running. Use `context.options.activeProcessors` to gate optional features:

```typescript
// Only show "Create an account" section when customers processor is active
const showCustomers = context.options.activeProcessors?.includes("customers") ?? true;
if (showCustomers) {
    html += `<p>Create an account for faster checkout.</p>`;
}
```

The `runProcessors()` function populates `context.options.activeProcessors` automatically with the full list of selected processor names before execution.

The `HomeProcessor` checks all three related processors (`customers`, `promotions`, `cross-selling`) and gates each feature section independently. The `HomeFeatures` interface used by `buildHeroText`/`buildReferenceText`/`buildFeaturesHtml` has:

```typescript
interface HomeFeatures {
    includeCredentials: boolean; // customers processor active
    includePromotions: boolean; // promotions processor active
    includeCrossSelling: boolean; // cross-selling processor active
}
```

## Adding a New Processor

1. Create `src/post-processors/my-processor.ts`:

```typescript
import type { PostProcessor, PostProcessorContext, PostProcessorResult } from "./index.js";

class MyProcessorImpl implements PostProcessor {
    readonly name = "my-processor";
    readonly description = "Does something";
    readonly dependsOn: string[] = []; // Add dependencies if needed

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        // Implementation
    }

    async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        // Cleanup implementation (recommended)
    }
}

export const MyProcessor = new MyProcessorImpl();
```

2. Register in `src/post-processors/index.ts`:

```typescript
import { MyProcessor } from "./my-processor.js";
registry.register(MyProcessor);
export { MyProcessor } from "./my-processor.js";
```

3. Add tests in `tests/unit/post-processors/my-processor.test.ts`

## Shared Utilities

### currency-utils.ts

Currency resolution for processors that need a primary currency ID:

```typescript
import { resolvePrimaryCurrencyId } from "./currency-utils.js";

const currencyId = await resolvePrimaryCurrencyId(context.api, context.salesChannelId);
```

Fallback order mirrors `createSalesChannel()`:

1. **USD** — project's primary currency
2. **EUR** — secondary fallback
3. **SalesChannel's own currency** — last resort

Each lookup is independent (a missing USD does not prevent the EUR lookup). Throws if all three fail.

Used by `variant-processor` and `digital-product-processor`.

### Direct API helpers (theme processor)

Most processors use `context.api` exclusively. The `theme` processor is an exception — it
calls `apiPost`/`apiPatch` from `utils/shopware-request.ts` directly for theme-specific
endpoints that are not exposed by `ShopwareApiHelpers`. This is intentional and limited to
that processor.

## Using API Helpers

Processors should use `context.api` for Shopware operations:

```typescript
// Search entities
const products = await context.api.searchEntities("product", filters, { limit: 100 });

// Sync (create/update)
await context.api.syncEntities({
    operation: { entity: "product", action: "upsert", payload: [...] }
});

// Delete
await context.api.deleteEntities("product_review", reviewIds);

// Generate UUID
import { generateUUID } from "../utils/index.js";
const id = generateUUID();
```

## Testing

Each processor should have comprehensive tests:

```typescript
describe("MyProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => { ... });
        test("has description", () => { ... });
        test("has dependencies", () => { ... });
    });

    describe("process - dry run mode", () => {
        test("logs actions without making API calls", async () => { ... });
    });

    describe("cleanup", () => {
        test("filters by SalesChannel", async () => { ... });
        test("deletes related entities", async () => { ... });
    });
});
```
