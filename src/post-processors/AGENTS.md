# Post-Processors Documentation

Internal documentation for AI agents working on the post-processors module.

## Overview

Post-processors run after the initial Shopware upload to handle resource-intensive tasks:

- Image generation and upload
- Manufacturer creation
- Review generation
- Variant creation
- CMS page setup

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
    cache: DataCache;
    textProvider?: TextProvider;
    imageProvider?: ImageProvider;
    shopwareUrl: string;
    getAccessToken: () => Promise<string>;
    api?: ShopwareApiHelpers; // New: Shared API helpers
    options: PostProcessorOptions;
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

| Processor     | Name            | Dependencies | Has Cleanup |
| ------------- | --------------- | ------------ | ----------- |
| CMS           | `cms`           | none         | Yes         |
| Images        | `images`        | none         | Yes         |
| Manufacturers | `manufacturers` | none         | Yes         |
| Reviews       | `reviews`       | none         | Yes         |
| Variants      | `variants`      | none         | Yes         |

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
const id = context.api.createUUID();
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
