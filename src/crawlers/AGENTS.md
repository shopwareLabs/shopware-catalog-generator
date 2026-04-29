# Crawlers Documentation

Internal documentation for AI agents working on the crawlers module.

## Overview

The `crawlers/` module extracts real-world context from an existing store's website.
The extracted data (`InspirationData`) is injected into AI hydration prompts so that
generated catalogs feel like they belong to the same store — matching the naming style,
product range, and brand identity.

No API keys are required. Uses `cheerio` (MIT, jQuery-like HTML parsing) + native `fetch`.

## Module Structure

```
crawlers/
├── index.ts              # Public API: crawlForInspiration, InspirationData, InspirationDataSchema
├── types.ts              # InspirationData + ExampleProduct types with Zod schemas
├── site-crawler.ts       # Main crawl function — orchestrates all extractors
└── extractors/
    ├── index.ts          # Re-exports all extractor functions
    ├── image-color.ts    # Brand color extraction from brand images (apple-touch-icon, SVG, PNG)
    ├── json-ld.ts        # Parse schema.org JSON-LD blocks from <script> tags
    └── meta.ts           # Parse meta tags, CSS vars, and nav links
```

## Public API

```typescript
import { crawlForInspiration } from "./crawlers/index.js";
import type { InspirationData } from "./crawlers/index.js";

const inspiration = await crawlForInspiration("https://some-music-shop.com", {
    followCategoryPages: true, // default true — follow up to 2 category links for products
});
// → InspirationData
```

### InspirationData shape

```typescript
interface InspirationData {
    sourceUrl: string;
    crawledAt: string; // ISO 8601
    brandDescription?: string;
    brandColors?: {
        primary: string; // lowercase hex, e.g. "#2d3a4a"
        secondary: string;
    };
    categories: string[]; // real category names from the store
    exampleProducts: ExampleProduct[]; // up to ~20 products from category pages
}

interface ExampleProduct {
    name: string;
    description?: string;
}
```

## Extraction Strategy

The crawler fetches the root URL and applies a priority chain for each field:

### Categories

1. JSON-LD `BreadcrumbList.itemListElement[].name`
2. Fallback: `<nav a>` link text (deduped, generic nav words skipped)

### Example Products

1. JSON-LD `Product.name` / `ItemList.itemListElement[].item.name` on the root page
2. Follow up to 2 category links found in `<nav>` and fetch those pages for more products

### Brand Colors

Image-based extraction is tried first (most reliable). CSS/meta tags are only used as a fallback
when no usable image is found, and near-white values are filtered out.

**1. Brand image analysis** (`image-color.ts`) — candidate images tried in order:

- `<link rel="apple-touch-icon">` — explicitly designed as brand icon, clearest colors
- `<link rel="apple-touch-icon-precomposed">` — same
- `<link rel="icon" type="image/svg+xml">` / SVG icons — colors parsed from `fill`/`stroke` attributes directly (no rasterization needed; works great for IKEA-style vector logos)
- `<link rel="icon" type="image/png">` or known large sizes (192×192, 180×180, …) — rasterized with `sharp`
- `<meta name="msapplication-TileImage">` — Microsoft tile
- Well-known fallback paths: `/apple-touch-icon.png`, `/apple-touch-icon-180x180.png`, `/apple-touch-icon-precomposed.png`
- `<meta property="og:image">` — last resort; may be a product/lifestyle photo

For raster images: resized to 80×80 with `sharp`, dominant saturated color found via bucket quantization.
Two passes: first colored pixels only, then near-black if nothing found (supports monochrome logos).
Secondary color = most visually distinct color from primary (channel distance > 80).

For SVG images: `fill`/`stroke`/`stop-color` hex values parsed from markup; pure black/white skipped.

**2. CSS/meta fallback** (only when image analysis yields nothing):

- `<meta name="theme-color">` content — skipped if near-white (luminance > 0.85)
- CSS custom properties in `<style>` tags:
    - Primary: `--primary-color`, `--brand-color`, `--main-color`, `--accent-color`, `--color-primary`, `--color-brand`
    - Secondary: `--secondary-color`, `--accent-color`, `--highlight-color`, `--color-secondary`, `--color-accent`

**3. Derived secondary**: if only a primary was found, secondary is computed by shifting lightness ±60 (dark primary → lighter, light primary → darker).

### Brand Description

1. JSON-LD `Organization.description` or `WebSite.description`
2. `<meta property="og:description">`
3. `<meta name="description">`

## Limitations

- **Static HTML only** — JavaScript-rendered content (SPAs) won't be visible. However, `<nav>`, meta tags, and JSON-LD blocks are almost always server-rendered for SEO.
- **No auth** — Can't crawl pages behind login walls.
- **Rate limiting** — Respects `fetch` with a 15-second timeout. Does not implement delays between requests.

## Adding New Extractors

1. Create `src/crawlers/extractors/my-extractor.ts`
2. Export a function `extractSomething($: CheerioAPI): SomeType`
3. Export from `src/crawlers/extractors/index.ts`
4. Call from `site-crawler.ts` and merge into `InspirationData`
5. Update `src/crawlers/types.ts` if the schema changes
6. Add tests in `tests/unit/crawlers/my-extractor.test.ts`

## Tests

```
tests/unit/crawlers/
├── image-color.test.ts   # SVG fill parsing, PNG pixel analysis, priority chain, fallbacks
├── json-ld.test.ts       # BreadcrumbList, Product, ItemList, @graph, Organization/WebSite
├── meta.test.ts          # theme-color, CSS vars, og:description, nav link filtering
└── site-crawler.test.ts  # Full crawl with mocked fetch, error handling, nav fallback
```
