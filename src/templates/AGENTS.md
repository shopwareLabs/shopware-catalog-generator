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

## TemplateFetcher Class

```typescript
class TemplateFetcher {
    // Fetch a specific template (sparse checkout)
    async ensureTemplate(name: string): Promise<boolean>

    // List locally available templates (already fetched)
    listTemplates(): string[]

    // Check if a template is locally available
    hasTemplate(name: string): boolean

    // Copy template to local cache
    copyToCache(name: string, cache: DataCache): boolean

    // Copy properties folder to cache
    copyPropertiesToCache(cache: DataCache): boolean

    // Convenience: fetch + copy template and properties
    async tryUseTemplate(name: string, cache: DataCache): Promise<boolean>
}
```

## Environment Variables

```env
# Repository URL (SSH or HTTPS)
TEMPLATE_REPO_URL=git@github.com:shopwareLabs/shopware-catalog-templates.git

# Local directory for cloning (relative to project root)
TEMPLATE_CACHE_DIR=.template-repo

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
    console.log("Using pre-generated template");
} else {
    console.log("No template found, generating from scratch");
}

// Or step by step
await fetcher.ensureRepo();
const templates = fetcher.listTemplates();
console.log("Available templates:", templates);
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

Authentication uses existing git credentials (SSH keys or credential helper).

## Error Handling

The fetcher is designed to fail gracefully:

- Clone fails → Continue with normal generation
- Pull fails → Use existing cached repo
- Template not found → Continue with normal generation

Errors are logged as warnings, never thrown.

## Adding New Templates

1. Generate a SalesChannel using the normal flow
2. Copy `generated/sales-channels/<name>/` to the template repository
3. Commit and push to the repository

Templates are automatically available after the next `git pull`.
