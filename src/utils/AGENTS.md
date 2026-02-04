# Utilities Documentation

Internal documentation for AI agents working on the utils module.

## Overview

The utils module provides shared utility functions to avoid code duplication across the codebase.

## Available Utilities

### retry.ts

Retry logic with exponential backoff:

```typescript
import { executeWithRetry, sleep } from "./utils/index.js";

// Retry with backoff
const result = await executeWithRetry(() => apiCall(), {
    maxRetries: 3,
    baseDelay: 2000,
});

// Simple sleep
await sleep(1000);
```

Settings:

- Exponential backoff: 10s → 20s → 40s → 80s → 160s
- Max 5 retries
- Handles 429 (rate limit) errors automatically

### strings.ts

String normalization:

```typescript
import { normalizeDescription, stripHtml, capitalizeString } from "./utils/index.js";

const clean = normalizeDescription("<p>HTML &amp; entities</p>"); // "HTML & entities"
const text = stripHtml("<b>Bold</b> text"); // "Bold text"
const title = capitalizeString("hello"); // "Hello"
```

### category-tree.ts

Category tree operations:

```typescript
import { countCategories, getLeafCategories, collectCategoryIdsByPath } from "./utils/index.js";

const count = countCategories(tree);
const leaves = getLeafCategories(tree);
const ids = collectCategoryIdsByPath(tree); // Map<path, id> (e.g., "Living Room > Sofas")
```

### concurrency.ts

Concurrency limiting for parallel operations:

```typescript
import { ConcurrencyLimiter } from "./utils/index.js";

const limiter = new ConcurrencyLimiter(5);
const results = await limiter.all(tasks.map((t) => () => processTask(t)));
```

### color-palette.ts

Color handling and fuzzy matching:

```typescript
import { getHexColor, findClosestColor } from "./utils/index.js";

const hex = getHexColor("red"); // "#FF0000"
const match = findClosestColor("burgundy"); // { name: "Red", hex: "#FF0000" }
```

### property-collector.ts

Collect and deduplicate property groups:

```typescript
import { PropertyCollector } from "./utils/index.js";

const collector = new PropertyCollector();
collector.addFromProducts(products);
const groups = collector.getPropertyGroups();
```

### validation.ts

Input validation:

```typescript
import { validateSubdomainName } from "./utils/index.js";

const result = validateSubdomainName("My Store");
// { valid: true, sanitized: "my-store" }
```

### blueprint-validation.ts

Blueprint validation before syncing to Shopware:

```typescript
import { validateBlueprint, hasValidationIssues } from "./utils/index.js";

// Validate with auto-fix
const result = validateBlueprint(blueprint, { autoFix: true, logFixes: true });
// { valid: true, issues: [], fixesApplied: 2 }

// Quick check without auto-fix
if (hasValidationIssues(blueprint)) {
    logger.cli("Blueprint has issues", "error");
}
```

Checks for:

**Errors (block sync):**

- **Duplicate product names** (auto-fixable: appends "(2)", "(3)" suffix)
- **Placeholder names** (e.g., "Product 1", "Top Category 1")
- **Missing required fields** (salesChannel.name, products, categories)
- **Empty property options** in property groups
- **Products with no categories** assigned
- **Invalid category references** (products referencing non-existent categories)

**Warnings (allow sync but log):**

- **Duplicate category names** at same level
- **Products only in top-level categories** (should have subcategory assignments)
- **Missing color hex codes** for color properties
- **Orphan property references** (products referencing non-existent groups)
- **Products without image descriptions**
- **Products with empty image prompts**
- **Products without properties**
- **Products without manufacturer**

Used automatically in the sync flow before uploading to Shopware.

### logger.ts

File-based logging with MCP-safe console output:

```typescript
import { logger } from "./utils/index.js";

// User-facing output (file + console, respects MCP mode)
logger.cli("✓ Created SalesChannel");           // info level (default)
logger.cli("⚠ Rate limited", "warn");           // warn level
logger.cli("✗ Upload failed", "error");         // error level

// Diagnostic logging (file only)
logger.debug("Debug info", { data });
logger.info("Info message");
logger.warn("Recoverable issue", { context });
logger.error("Operation failed", { error });

// Special methods
logger.apiError("endpoint", 500, response);     // File + console (unless MCP)

// Log cleanup (keeps last 10 files by default)
const deleted = logger.cleanup(10);
```

Logs are written to `logs/generator-{timestamp}.log`.

**Convention: Never use `console.*` directly in library modules.**

- Use `logger.cli()` for user-facing output (respects MCP mode)
- Use `logger.info/warn/error()` for diagnostic logging (file only)
- Only CLI entry points (`main.ts`, `*-cli.ts`, `server.ts`) may use `console.*` directly

## Import Pattern

Always import from the index for consistency:

```typescript
import {
    executeWithRetry,
    logger,
    validateSubdomainName,
    ConcurrencyLimiter,
} from "./utils/index.js";
```

## Adding New Utilities

1. Create `src/utils/my-utility.ts`
2. Export from `src/utils/index.ts`
3. Add tests in `tests/unit/my-utility.test.ts`
