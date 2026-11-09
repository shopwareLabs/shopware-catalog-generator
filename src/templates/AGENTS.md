# Templates Documentation

Internal documentation for AI agents working on the templates module.

## Overview

The templates module provides pre-generated catalog data from a GitHub repository. When a user requests a SalesChannel that matches a template name, the data is copied to local cache instead of running AI generation.

**Key optimization:** Uses Git sparse checkout to only download the specific sales channel and properties folder needed, rather than the entire repository with all templates.

## Template Repository

Templates are stored in a private GitHub repository:

- **Repository:** `github.com/shopwareLabs/shopware-catalog-templates`
- **Structure:** Same as `generated/` folder

```
shopware-catalog-templates/
├── sales-channels/
│   ├── beauty/
│   │   ├── blueprint.json
│   │   ├── hydrated-blueprint.json
│   │   ├── images/
│   │   └── metadata/
│   ├── furniture/
│   └── music/
└── properties/
    ├── color.json
    ├── size.json
    └── ...
```

Each template contains:

- `blueprint.json` - Original blueprint structure
- `hydrated-blueprint.json` - AI-hydrated blueprint with all data
- `images/` - Product and category images (webp + json metadata)
- `metadata/` - Individual product metadata files
- `manufacturers.json` - Manufacturer data
- `generation.json` - Generator version and models of each hydration/translation step
- `template.json` - Template metadata (see below)

## Template Metadata (`template.json`)

Every hydration and translation records its run in `generation.json` (key per step:
`hydrate`, `hydrate:categories`, `hydrate:properties`, `hydrate:cms`, `translate:<locale>`;
the last run of a step wins). A translation run that only reused cached entries is not
recorded. `bun run template metadata` combines it with the catalog and the lane results
into `template.json`:

```json
{
    "schemaVersion": 1,
    "name": "beauty",
    "description": "...",
    "createdAt": "2026-11-09T10:00:00.000Z",
    "generator": { "version": "2.0.0", "commit": "9dce378" },
    "content": { "products": 90, "categories": 25, "languages": ["en", "de-DE"] },
    "models": {
        "text": { "provider": "openai", "model": "gpt-6-luna" },
        "image": { "provider": "openai", "model": "gpt-image-2.5-flare", "quality": "medium" }
    },
    "steps": { "hydrate": { "at": "...", "generator": {}, "text": {}, "image": {} } },
    "testedOn": [
        {
            "lane": "67",
            "shopwareVersion": "6.7.9999999.9999999-dev",
            "passed": true,
            "testedAt": "2026-11-09"
        }
    ]
}
```

```bash
./test-e2e-lanes.sh --reuse=beauty --skip-hydrate
bun run template metadata --name=beauty --e2e=e2e-results/<timestamp>
```

- `--e2e` reads `<lane>/steps.tsv` and `version.txt` (fallback `verify.json`) of a lane run.
  A lane passes when no step failed and `verify` passed. Results of the same lane replace
  older ones, other lanes are kept. A run of another store (`summary.md` heading) is rejected.
- `models` is missing when the template was hydrated before `generation.json` existed.
- `generate` prints a one-line summary when it uses a template that has `template.json`.
- Types and zod schemas: `src/types/template.ts`. Logic: `src/services/template-service.ts`.

## TemplateFetcher Class

```typescript
class TemplateFetcher {
    // Fetch a specific template (sparse checkout)
    async ensureTemplate(name: string): Promise<boolean>;

    // List locally available templates (already fetched)
    listTemplates(): string[];

    // Check if a template is locally available
    hasTemplate(name: string): boolean;

    // Copy template to local cache
    copyToCache(name: string, cache: DataCache): boolean;

    // Copy properties folder to cache
    copyPropertiesToCache(cache: DataCache): boolean;

    // Convenience: fetch + copy template and properties
    async tryUseTemplate(name: string, cache: DataCache): Promise<boolean>;
}
```

## Environment Variables

```env
# Repository URL (SSH or HTTPS)
TEMPLATE_REPO_URL=git@github.com:shopwareLabs/shopware-catalog-templates.git

# Local directory for cloning (relative to project root)
TEMPLATE_CACHE_DIR=.shopware-catalog-templates

# Enable/disable auto-update on each check
TEMPLATE_AUTO_UPDATE=true
```

## Usage

### CLI

```bash
# Uses template if "beauty" exists in the repository
bun run generate --name=beauty

# Forces AI generation even if template exists
bun run generate --name=beauty --no-template
```

### Server API

```json
{
    "salesChannel": "beauty",
    "skipTemplate": true
}
```

### Programmatic

```typescript
import { createTemplateFetcherFromEnv } from "./templates/index.js";

const fetcher = createTemplateFetcherFromEnv();

// Try to use a template
const used = await fetcher.tryUseTemplate("beauty", cache);
if (used) {
    logger.info("Using pre-generated template", { cli: true });
} else {
    logger.info("No template found, generating from scratch", { cli: true });
}

// Or step by step
await fetcher.ensureRepo();
const templates = fetcher.listTemplates();
logger.info(`Available templates: ${templates.join(", ")}`, { cli: true });
```

## Git Operations (Sparse Checkout)

The fetcher uses Git's sparse checkout feature to minimize download size:

1. **Repository init:** `git clone --filter=blob:none --sparse --depth 1`
    - Downloads only git metadata, no actual files
    - Very fast (~2 minutes)

2. **Fetch specific template:** `git sparse-checkout add sales-channels/<name> properties`
    - Downloads only the requested sales channel folder
    - Downloads the shared properties folder
    - Much faster than cloning everything

3. **Updates:** `git pull --ff-only`
    - Only updates files in sparse checkout
    - If the fast-forward fails because the history was reset
      (`scripts/reset-templates-history.sh` + force push), the clone is reset to the
      remote (`git fetch --depth 1` + `git reset --hard FETCH_HEAD`) and old objects are
      pruned. The clone is only a cache, so nothing is lost.

Authentication uses existing git credentials (SSH keys or credential helper).

## Error Handling

The fetcher is designed to fail gracefully:

- Clone fails → Continue with normal generation
- Pull fails → Use existing cached repo
- Template not found → Continue with normal generation

Errors are logged as warnings, never thrown.

## Adding New Templates

1. Generate a SalesChannel using the normal flow
2. Import it on every lane: `./test-e2e-lanes.sh --reuse=<name> --skip-hydrate`
3. Write the metadata: `bun run template metadata --name=<name> --e2e=e2e-results/<timestamp>`
4. Copy `generated/sales-channels/<name>/` to the template repository
5. Commit and push to the repository

Templates are automatically available after the next `git pull`.
