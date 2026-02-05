# CMS Processors Documentation

Internal documentation for AI agents working on the CMS post-processors module.

## Overview

CMS processors create demonstration pages for all Shopware CMS block types. The architecture uses a multi-processor approach with an orchestrator that builds the final category hierarchy.

## Category Hierarchy

```
Testing (testing-placeholder.ts)
├── CMS (welcome.ts - CMS Element Showcase)
│   ├── Text (text.ts)
│   ├── Images (images.ts)
│   ├── Video (video.ts)
│   ├── Text & Images (text-images.ts)
│   ├── Commerce (commerce.ts)
│   └── Form (form.ts)
└── Products (navigation category)
    ├── Simple Product (link to product)
    ├── Variant Product (link to product)
    └── Digital Product (link to product)
```

## Architecture

### BaseCmsProcessor

Abstract base class providing shared functionality for all CMS processors:

```typescript
abstract class BaseCmsProcessor {
    abstract readonly name: string;
    abstract readonly description: string;
    abstract readonly pageFixture: CmsPageFixture;
    readonly dependsOn: string[] = [];

    // CMS page operations
    protected findCmsPageByName(context, name): Promise<string | null>;
    protected createCmsPage(context, fixture): Promise<string | null>;

    // Landing page operations
    protected findLandingPageByName(context, name): Promise<string | null>;
    protected createLandingPage(context, name, cmsPageId): Promise<string | null>;
    protected ensureSalesChannelAssociated(context, landingPageId, name, errors): Promise<void>;

    // Entity operations
    protected deleteEntity(context, entity, id): Promise<boolean>;

    // Inter-processor cache
    protected saveLandingPageId(context, processorName, landingPageId): void;
    protected getLandingPageIds(context): Record<string, string>;
}
```

### Element Processors

Simple processors that extend `BaseCmsProcessor`:

| Processor | Name | Fixture | Description |
|-----------|------|---------|-------------|
| TextProcessor | `cms-text` | text.ts | Text blocks, heroes, teasers, HTML |
| ImagesProcessor | `cms-images` | images.ts | Image, gallery, slider |
| VideoProcessor | `cms-video` | video.ts | YouTube, Vimeo embeds |
| TextImagesProcessor | `cms-text-images` | text-images.ts | Combined text/image layouts |
| CommerceProcessor | `cms-commerce` | commerce.ts | Product boxes, sliders, buy boxes |
| FormProcessor | `cms-form` | form.ts | Contact and newsletter forms |

### Dynamic Data Population

Some processors override `process()` to fetch and populate dynamic data:

**ImagesProcessor**: Fetches media IDs from products and the media endpoint to populate `image-slider` and `image-gallery` blocks.

**CommerceProcessor**: Fetches product IDs and media to populate `product-box`, `product-slider`, and `gallery-buybox` blocks.

### TestingProcessor (Orchestrator)

The orchestrator runs last and creates the full category hierarchy:

1. Creates Testing placeholder landing page
2. Creates "Testing" main category
3. Creates CMS showcase landing page
4. Creates "CMS" sub-category
5. Creates element sub-categories (Text, Images, etc.)
6. Creates "Products" navigation category
7. Creates product type links (Simple, Variant, Digital)

Dependencies: All element processors + `digital-product`

## Inter-Processor Communication

Processors communicate via a shared JSON cache file:

```
generated/sales-channels/{store}/cms-landing-pages.json
```

Each element processor saves its landing page ID:

```typescript
// In element processor
this.saveLandingPageId(context, this.name, landingPageId);

// In TestingProcessor
const landingPages = this.getLandingPageIds(context);
// { "cms-text": "abc123", "cms-images": "def456", ... }
```

## Validation Approach

**API-only validation**: If the Shopware sync API returns 200, the CMS page structure is valid. The API enforces:

- Required block/slot structure
- Valid block types
- Proper configuration values
- Association integrity

No additional validation layer is needed. Browser rendering issues (like empty sliderItems) are prevented by dynamic population in processors.

## Fixtures Location

All CMS page fixtures are in `src/fixtures/cms/`:

```
src/fixtures/cms/
├── index.ts              # Re-exports all fixtures
├── types.ts              # CmsPageFixture interface
├── testing-placeholder.ts # Testing entry page
├── welcome.ts            # CMS showcase page
├── text.ts               # Text elements
├── images.ts             # Image elements
├── video.ts              # Video elements
├── text-images.ts        # Text & images elements
├── commerce.ts           # Commerce elements
└── form.ts               # Form elements
```

## Adding a New CMS Demo Page

1. Create fixture in `src/fixtures/cms/new-element.ts`:

```typescript
import type { CmsPageFixture } from "../types.js";

export const NEW_ELEMENTS_PAGE: CmsPageFixture = {
    name: "New Elements",
    type: "landingpage",
    sections: [{ ... }],
};
```

2. Export from `src/fixtures/cms/index.ts` and `src/fixtures/index.ts`

3. Create processor in `src/post-processors/cms/new-processor.ts`:

```typescript
import { BaseCmsProcessor } from "./base-processor.js";
import { NEW_ELEMENTS_PAGE } from "../../fixtures/index.js";

class NewProcessorImpl extends BaseCmsProcessor {
    readonly name = "cms-new";
    readonly description = "Create New Elements demo page";
    readonly pageFixture = NEW_ELEMENTS_PAGE;
}

export const NewProcessor = new NewProcessorImpl();
```

4. Export from `src/post-processors/cms/index.ts`

5. Register in `src/post-processors/index.ts`

6. Add to `CMS_CATEGORIES` in `testing-processor.ts`

7. Add unit tests in `tests/unit/post-processors/cms/`

## Cleanup

All CMS processors support cleanup via `--processors=cms-*`:

```bash
# Cleanup specific processor
bun run cleanup -- --salesChannel="garden" --processors=cms-text

# Cleanup all CMS processors
bun run cleanup -- --salesChannel="garden" --processors=cms-testing
```

The TestingProcessor cleanup deletes in reverse order (deepest categories first).
