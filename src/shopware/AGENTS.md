# Shopware Module Documentation

Internal documentation for AI agents working on the shopware module.

## Overview

The shopware module handles all API interactions with Shopware 6:

- Authentication (client credentials or user/password)
- Entity creation (products, categories, SalesChannels)
- Export/sync of existing data
- Cleanup operations

## Module Hierarchy

```
ShopwareClient (auth, base API)
 └── ShopwareHydrator (create operations, SalesChannels, category trees)
      └── ShopwareExporter (export/sync existing data)
           └── ShopwareCleanup (delete operations, SalesChannel-centric)
                └── DataHydrator (combines all via composition)
```

## Official API Client

We use the official `@shopware/api-client` package wrapped in helper classes:

### admin-client.ts

Thin wrapper around `createAdminAPIClient`:

```typescript
import { createShopwareAdminClient, createAdminClientFromEnv } from "./admin-client.js";

const client = createShopwareAdminClient({
    baseURL: "http://localhost:8000",
    clientId: "SWIA...",
    clientSecret: "xxx",
});
```

### api-helpers.ts

Convenience methods wrapping the official client:

```typescript
import { ShopwareApiHelpers, createApiHelpers } from "./api-helpers.js";

const api = createApiHelpers(client, baseURL, getAccessToken);

// Search
const products = await api.searchEntities("product", filters, { limit: 100 });

// Sync
await api.syncEntities({ operation: { entity: "product", action: "upsert", payload: [...] }});

// Delete
await api.deleteEntities("product_review", ids);

// Utilities
import { generateUUID } from "../utils/index.js";
const id = generateUUID();
const currencyId = await api.getCurrencyId("EUR");
```

## Key Classes

### ShopwareClient

Base client with authentication:

```typescript
const client = new ShopwareClient();
await client.authenticateWithClientCredentials(url, clientId, clientSecret);
const token = await client.getAccessToken();
```

**Storefront sales channel lookup** uses a two-step fallback:

1. Try exact name match (e.g., "Storefront")
2. If not found, search by Storefront type ID (`ShopwareClient.STOREFRONT_TYPE_ID`)

This ensures generation works even if the default Storefront was renamed or if the Shopware instance uses a different language.

### ShopwareHydrator

Create entities in Shopware:

```typescript
const hydrator = new ShopwareHydrator();
await hydrator.createSalesChannel({ name: "furniture", ... });
await hydrator.createCategoryTree(categories, rootId, salesChannelId);
await hydrator.hydrateEnvWithProducts(products, category, salesChannelName);
```

### ShopwareCleanup

Delete entities (SalesChannel-centric):

```typescript
const cleanup = new ShopwareCleanup();
await cleanup.cleanupSalesChannel("furniture", {
    deletePropertyGroups: true,
    deleteSalesChannel: true,
});
```

Note: Manufacturer cleanup is now handled by ManufacturerProcessor.

### ShopwareExporter

Export existing data:

```typescript
const exporter = new ShopwareExporter();
const result = await exporter.exportSalesChannel(salesChannel);
// Returns: { categories, products, propertyGroups, validation }
```

### DataHydrator

Combined class for backwards compatibility:

```typescript
const hydrator = new DataHydrator();
// Has methods from all above classes
```

## Cleanup SSOT

Each module/processor is the Single Source of Truth for entities it creates:

| Entity Type                           | Owner                  |
| ------------------------------------- | ---------------------- |
| Products, Categories, Property Groups | ShopwareCleanup        |
| SalesChannel                          | ShopwareCleanup        |
| CMS pages, Landing pages              | CMS Processor          |
| Product media, Category media         | Image Processor        |
| Manufacturers                         | Manufacturer Processor |
| Reviews                               | Review Processor       |
| Variants                              | Variant Processor      |

## Adding New Operations

1. Add method to appropriate file:
    - `hydrator.ts` for create operations
    - `cleanup.ts` for delete operations
    - `export.ts` for read operations

2. If new type needed, add to `types/shopware.ts`

3. Export from `types/index.ts`

## Export/Sync from Shopware

When a SalesChannel already exists, data is synced before generation:

```typescript
const exported = await hydrator.exportSalesChannel(existingSalesChannel);
// Returns: { categories, products, propertyGroups, productCount, validation }
```

Validation stats track data quality:

- `categoriesWithoutDescription` - Placeholder added
- `productsWithoutDescription` - Placeholder added
- `productsWithDefaultPrice` - Default €29.99
