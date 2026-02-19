# Tests Documentation

Internal documentation for AI agents working on tests in this codebase.

## Directory Structure (MUST Mirror src/)

**CRITICAL:** Unit test files MUST be placed in a folder structure that mirrors `src/`.

```
src/utils/logger.ts             →  tests/unit/utils/logger.test.ts
src/providers/openai.ts         →  tests/unit/providers/openai.test.ts
src/blueprint/generator.ts      →  tests/unit/blueprint/generator.test.ts
src/blueprint/hydrator.ts       →  tests/unit/blueprint/hydrator.test.ts
src/blueprint/hydrators/cms.ts  →  tests/unit/blueprint/hydrators/cms.test.ts
src/shopware/export.ts          →  tests/unit/shopware/export.test.ts
src/shopware/hydrator.ts        →  tests/unit/shopware/hydrator-ordering.test.ts
src/cache.ts                    →  tests/unit/cache.test.ts (root-level files stay at root)
```

This convention:

- Makes it easy to find tests for any source file
- Keeps related tests organized together
- Prevents flat directory with dozens of unrelated files

### Folder Overview

```
tests/
├── unit/                     # Unit tests (mirrors src/ structure)
│   ├── blueprint/            # src/blueprint/ tests
│   ├── post-processors/      # src/post-processors/ tests
│   ├── providers/            # src/providers/ tests
│   ├── server/               # src/server/ tests
│   ├── shopware/             # src/shopware/ tests
│   ├── templates/            # src/templates/ tests
│   ├── utils/                # src/utils/ tests
│   ├── cache.test.ts         # Root-level src/*.ts tests
│   ├── property-cache.test.ts
│   └── saleschannel-cache.test.ts
├── integration/              # Integration tests
│   └── blueprint.test.ts
├── e2e/                      # End-to-end tests
│   ├── verify.ts             # API verification script
│   └── browser-checks.md     # Browser verification guide
└── mocks/                    # Shared test mocks
    ├── index.ts
    ├── api-helpers.mock.ts
    ├── text-provider.mock.ts
    └── image-provider.mock.ts
```

## Running Tests

```bash
bun test                              # All tests
bun test tests/unit/                  # Unit tests only
bun test tests/unit/utils/            # Utils tests only
bun test tests/unit/post-processors/  # Post-processor tests
bun test --watch                      # Watch mode
bun test --coverage                   # With coverage report
bun test tests/unit/cache.test.ts     # Specific test file
```

## Test Requirements

**All new code MUST have unit tests.** Follow these guidelines:

1. **Post-processors**: Test metadata, dry-run mode, and API interactions
2. **Utilities**: Test pure functions with edge cases
3. **Providers**: Test constructor options, concurrency settings
4. **Fixtures**: Test that fixture data has expected structure

## Best Practices

### 1. No Non-Null Assertions (`!`)

Use type guards instead of `!` operator:

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

### 2. Use `bun:test` Imports

Always use Bun's native test runner:

```typescript
import { describe, expect, test, mock, beforeEach } from "bun:test";
```

### 3. Mock External Dependencies

Use `mock()` from `bun:test` or dedicated mocks in `tests/mocks/`:

```typescript
import { createMockApiHelpers } from "../../mocks/index.js";

const mockApi = createMockApiHelpers();
mockApi.mockPostResponse("search/product", { data: [...] });
```

### 4. Test Structure

Group related tests with `describe()`, use descriptive test names:

```typescript
describe("ModuleName", () => {
    describe("methodName", () => {
        test("returns expected result for valid input", () => { ... });
        test("throws error for invalid input", () => { ... });
        test("handles edge case X", () => { ... });
    });
});
```

### 5. Avoid Test Interdependence

Each test should be independent and not rely on state from other tests.

### 6. Test Edge Cases

Always test:

- Empty arrays
- null/undefined
- Boundary values
- Error conditions

### 7. Keep Tests Focused

One assertion concept per test (multiple `expect()` calls are fine if testing the same behavior).

## Test Patterns

### Post-Processor Tests

```typescript
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

    describe("cleanup", () => {
        test("filters by SalesChannel", async () => { ... });
        test("deletes related entities", async () => { ... });
    });
});
```

### Utility Function Tests

```typescript
describe("utilityFunction", () => {
    test("returns expected result for typical input", () => {
        expect(utilityFunction("input")).toBe("expected");
    });

    test("handles empty input", () => {
        expect(utilityFunction("")).toBe("");
    });

    test("handles edge case", () => {
        expect(utilityFunction(null)).toBeNull();
    });
});
```

## Mock Providers

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

## Adding Tests for New Code

When adding a new source file:

1. **Determine the location**: Mirror the `src/` path in `tests/unit/`
2. **Create the test file**: Name it `<source-file>.test.ts`
3. **Add imports**: Use `bun:test` and relative paths to source
4. **Write tests**: Cover happy path, edge cases, and error conditions
5. **Run tests**: `bun test tests/unit/<path>/<file>.test.ts`

Example for a new utility:

```bash
# Source file
src/utils/my-utility.ts

# Test file (create this)
tests/unit/utils/my-utility.test.ts

# Run the test
bun test tests/unit/utils/my-utility.test.ts
```
