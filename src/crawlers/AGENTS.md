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
├── site-crawler.ts       # Main crawl function — orchestrates all phases
├── page-classifier.ts    # classifyPage() — classifies HTML as product/category/cms/unknown
└── extractors/
    ├── index.ts          # Re-exports all extractor functions
    ├── image-color.ts    # Brand color extraction from brand images (apple-touch-icon, SVG, PNG)
    ├── json-ld.ts        # Parse schema.org JSON-LD blocks from <script> tags
    ├── meta.ts           # Parse meta tags, CSS vars, and nav links
    └── sitemap.ts        # discoverFromSitemap(), sampleUrls() — URL discovery via sitemap.xml
```

## Public API

```typescript
import { crawlForInspiration } from "./crawlers/index.js";
import type { InspirationData } from "./crawlers/index.js";

const inspiration = await crawlForInspiration("https://some-music-shop.com");
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

## Architecture: Page Classifier + Type-Appropriate Extraction

The v2 crawler classifies each page before extracting anything.
No URL depth heuristics, no nav scraping, no platform-specific CSS classes.

### Phase 0: Homepage — brand data only

Fetch the homepage. Extract:

- Brand description: JSON-LD `Organization/WebSite.description` → `og:description` → `meta[name=description]`
- Brand colors: brand image analysis (`image-color.ts`) → CSS custom property scan → `meta[name=theme-color]`

### Phase 1: Sitemap URL discovery (`sitemap.ts`)

`discoverFromSitemap(baseUrl)` tries in order:

1. `robots.txt` — collects all `Sitemap:` directives; editorial ones (magazin/blog) are sorted last
2. `{origin}/sitemap.xml` — canonical location
3. `{origin}{basePath}/sitemap.xml` — locale-specific candidate (e.g. `/de/de/sitemap.xml`)

Handles: gzip sitemaps (`.gz` URLs via `arrayBuffer()` + `Bun.gunzipSync()`), sitemap index files,
sub-sitemaps at any origin (S3/CDN). Returns up to ~300 URLs.

`sampleUrls(urls, n)` distributes the sample across top-level path branches to maximize coverage.

### Phase 2: Page classifier (`page-classifier.ts`)

```typescript
classifyPage(html: string, $: CheerioAPI): "product" | "category" | "cms" | "unknown"
```

Applies Tier 1 → 2 → 3 in order — first match wins:

**Tier 1 — JSON-LD Schema.org `@type`:**

- `Product`, `ProductGroup`, `ProductModel`, `IndividualProduct`, `Vehicle` → `product`
- `ItemList`, `OfferCatalog`, `ProductCollection`, `CollectionPage` (not `BreadcrumbList`) → `category`
- `AboutPage`, `ContactPage`, `FAQPage`, `Article`, `BlogPosting`, `Recipe`, etc. → `cms`

**Tier 2 — Microdata (`itemprop`):**

- `itemtype` contains `schema.org/Product` → `product`
- `itemtype` contains `schema.org/ItemList` (not BreadcrumbList) → `category`
- ≥3 `itemprop="price"` elements → `category`

**Tier 3 — Price count + cart-text count (regex, no DOM):**

- Price regex: `/\d{1,4}[.,]\d{2}\s*[€£$]|[€£$]\s*\d{1,4}[.,]\d{2}/g`
- Cart regex: `/in\s*den\s*warenkorb|add\s*to\s*cart|jetzt\s*kaufen|buy\s*now/gi`
- `priceCount >= 10` → `category`
- `cartCount >= 2` → `category`
- `priceCount >= 6 && cartCount === 0` → `category` (Hyva/Adobe Commerce listing pages)
- `priceCount >= 1 && priceCount <= 9 && cartCount <= 1` → `product`
- Otherwise → `unknown`

### Phase 3: Type-appropriate extraction

**Product pages:**

- Name: JSON-LD `Product.name` → `itemprop="name"` in product scope → single `h1` (3–120 chars)
- Category hierarchy: JSON-LD `BreadcrumbList` → microdata BreadcrumbList → `.breadcrumb a`
- Shopware 6 category pages: `data-product-information` JSON attribute

**Category pages:**

- Category name: JSON-LD `BreadcrumbList` last non-root item → `h1`
- Products from: JSON-LD `ItemList` with `@type: Product` items → `itemprop="name"` in product scope → `data-product-information`

### Phase 4: Follow category page links (when < 5 products found)

Crawls links found on category pages to find product detail pages. Follows up to 2 levels.

### Brand Colors

1. Brand image analysis (`image-color.ts`) — tried first (most reliable):
    - `<link rel="apple-touch-icon">`, SVG icons (`fill`/`stroke`), PNG icons
    - `<meta property="og:image">` — last resort
2. CSS/meta fallback (only when no image found):
    - `<meta name="theme-color">` — skipped if near-white (luminance > 0.85)
    - CSS custom properties: `--primary-color`, `--color-primary`, `--brand-color`, etc.

### Brand Description

1. JSON-LD `Organization.description` or `WebSite.description`
2. `<meta property="og:description">`
3. `<meta name="description">`

## Fetch Strategy

All requests use browser-like headers to avoid bot detection (many shops block minimal UA requests):

```
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8
Accept-Language: de-DE,de;q=0.9,en;q=0.8
```

## Limitations

> **No guarantee of continued compatibility.** Real websites change their HTML structure, add bot
> protection, or block headless requests at any time without notice.

- **Static HTML only** — JavaScript-rendered content (SPAs) won't be visible. However, JSON-LD blocks are almost always server-rendered for SEO.
- **Bot protection** — Sites using Cloudflare, Akamai, or similar WAFs may return 403/429. Nothing can be done without a real browser.
- **No auth** — Can't crawl pages behind login walls.
- **Rate limiting** — 15-second timeout per request; no delays between requests.

## Tested Stores

Run `bun run test:crawlers` to re-validate against live sites.

> **Results are inherently flaky.** Stores can add bot protection, restructure sitemaps, or change
> their HTML at any time. When thresholds need updating, change the spec in
> `scripts/validate-crawlers.ts` rather than patching the crawler for a single site.

Last verified: 2026-05-05

| Store                  | URL                                   | Platform              | Categories | Products | Brand Colors | Notes                                                                                   |
| ---------------------- | ------------------------------------- | --------------------- | ---------- | -------- | ------------ | --------------------------------------------------------------------------------------- |
| Gymshark               | `https://www.gymshark.com`            | Shopify Plus          | ✅ 9       | ✅ 19    | ✅ `#000000` | JSON-LD ProductGroup + BreadcrumbList; og:type=product                                  |
| STABILO                | `https://www.stabilo.com/de/`         | Shopware 6            | ✅ 3       | ✅ 60    | ✅ `#ff0000` | Products from `data-product-information` on category pages (no product URLs in sitemap) |
| schuhe24.de            | `https://www.schuhe24.de`             | Shopware 5            | ✅ 9       | ✅ 8     | ✅ `#e00000` | Categories from microdata BreadcrumbList on product pages                               |
| IKEA                   | `https://www.ikea.com/de/de/`         | Custom                | ✅ 16      | ✅ 30    | ✅ `#0058a3` | JSON-LD ItemList products; locale prefix filtering                                      |
| Media Markt            | `https://www.mediamarkt.de`           | Shopware 6            | ✅ 63      | ✅ 26    | ✅ `#c00000` | og:type `og:product` (prefixed) normalised; JSON-LD Product on detail pages             |
| Foot Locker            | `https://www.footlocker.de`           | Custom                | ✅ 30      | ✅ ~10   | ✅ `#000000` | Products via Phase 4 two-level link-follow; product sitemaps return `{}` (useless)      |
| Koro Drogerie          | `https://www.korodrogerie.de/`        | Shopware 6            | ✅ 21      | ✅ 9     | ✅ `#000000` | JSON-LD is FAQPage (not Product); products from h1 of og:type=product pages             |
| YT Industries          | `https://www.yt-industries.com/de-eu` | Shopware 6 (Nuxt)     | ✅ 6       | ✅ ~8    | ✅ `#000000` | Gzip sitemap via pathPrefix fallback; Tier 3 price signal                               |
| bergzeit.de            | `https://www.bergzeit.de`             | Magento 2             | ✅ 20      | ✅ 30    | ✅ `#000000` | robots.txt lists magazine sitemap first; editorial sitemaps deprioritized               |
| forestwholefoods.co.uk | `https://www.forestwholefoods.co.uk`  | WooCommerce           | ✅ 55      | ✅ 29    | ✅ `#808000` | JSON-LD Product + BreadcrumbList; standard WooCommerce schema output                    |
| mey.com                | `https://www.mey.com/`                | Hyva + Adobe Commerce | ✅ 30      | ✅ ~2    | ✅ `#000000` | Tier 3 gap rule: 6–9 prices + 0 cart → category; product listings JS-rendered           |

**Known non-starters (not included in `test:crawlers`):**

- **Bot-blocked** (Zara, H&M): Returns `403 Forbidden` even with browser-like headers.
- **CMS / non-shop sites** (Edeka): No product categories.

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
├── image-color.test.ts       # SVG fill parsing, PNG pixel analysis, priority chain, fallbacks
├── json-ld.test.ts           # BreadcrumbList, Product, ItemList, @graph, microdata, ProductGroup.category
├── meta.test.ts              # theme-color, CSS vars, og:description, nav link filtering
├── page-classifier.test.ts   # Tier 1–3 classification, gap rules, all page types
├── sitemap.test.ts           # Sitemap discovery, gzip, index following, robots.txt multi-directive, URL sampling
└── site-crawler.test.ts      # Full crawl with URL-routing mocks, error handling, all extraction paths
```
