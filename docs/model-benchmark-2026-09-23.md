# OpenAI model benchmark — 2026-09-23

## Decision

- Default OpenAI text to `gpt-6-luna` with `reasoning_effort: "none"`: about 93% lower estimated cost, but 2.17× the elapsed time of GPT-4.1 in these samples.
- Keep `gpt-image-1-mini` / `low` as the image default. Flare looked sharper, but cost about 54% more; its average elapsed time was only about 7% lower.
- Preserve `AI_MODEL=gpt-4.1-2025-04-14` as an explicit speed-oriented alternative and `IMAGE_MODEL=gpt-image-2.5-flare` as an optional image upgrade. No endpoint migration required.

## Method

Live API requests using OpenAI SDK 7.23.0 and Bun 1.4.0. No mocked responses. No Shopware uploads or changes to existing catalogs.

Text: two fictional stores (outdoor equipment and handmade pottery), each with the same generated blueprint cloned for all three candidates: one root category, two children, four products, no variants. The actual `BlueprintHydrator` called its existing category, brand-color, and product prompts through an instrumented provider using the same Chat Completions / Zod request format. Category and color calls ran concurrently, followed by products. Candidates ran concurrently; stores ran sequentially. Maximum 8,000 completion tokens per request; SDK retries disabled. All requests finished normally, without hitting the cap.

Images: identical product-photo and hero-banner prompts per model, `1536x1024`, `quality: low`, `output_format: webp`, one image per request. Models ran concurrently; prompts ran sequentially within each model. Timings include transfer and image decoding. Inspected all four saved images visually.

This is a small smoke comparison, not a statistically reliable quality or latency benchmark. Generated category choices differ between candidates, so downstream product prompts also differ. Prices are usage-based estimates, not invoice amounts; they exclude taxes and credits. These results do not establish production throughput or test live Shopware upload, CMS, or variants.

## Text results

| Model / reasoning  | Outdoor seconds | Pottery seconds | Estimated cost, both catalogs | Validation |
| ------------------ | --------------: | --------------: | ----------------------------: | ---------- |
| GPT-4.1-2025-04-14 |           14.14 |           14.08 |                     $0.038348 | Pass       |
| GPT-6 Luna / none  |           30.35 |           30.87 |                     $0.002650 | Pass       |
| GPT-6 Luna / low   |           40.56 |           38.06 |                     $0.003183 | Pass       |

All 18 text responses validated against their schemas (brand colors also checked as hex JSON). Each catalog retained four product IDs, positive blueprint prices, descriptions, and non-placeholder category/product names. Names and properties matched the store themes on inspection. Some marketing claims and color names are creative; this is demo content, not verified product information. Luna's low reasoning setting did not show a useful benefit for this task.

Pricing per million tokens: GPT-4.1 input $2, cached input $0.50, output $8; Luna input $0.10, cached input $0.01, cache writes $0.125, output $0.50. Estimates include reported cache writes and reasoning tokens. Sources: [GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).

## Image results

| Model               | Product seconds | Hero seconds | Estimated cost, both images | Output tokens per image |
| ------------------- | --------------: | -----------: | --------------------------: | ----------------------: |
| GPT Image 1 Mini    |           11.84 |        10.90 |                   $0.006772 |                     400 |
| GPT Image 2.5 Flare |            9.06 |        12.01 |                   $0.010410 |                     158 |

Both returned valid WebP files at the requested dimensions, without text or watermarks. Both product photos followed the shape, color, handle, and white-background instructions. Flare showed crisper ceramic texture. Both banners left room for a headline; Flare added a decorative branch and offered more negative space. No clear failure justifies changing the cheaper image default.

Input text tokens: 84 for the product prompt, 102 for the hero. Estimated costs use the reported tokens and published rates: Mini text input $2 / image output $8 per million tokens; Flare text input $5 / image output $30. The Mini usage-derived estimate is lower than its published approximate per-image price table; actual billing was not verified. Sources: [Mini](https://developers.openai.com/api/docs/models/gpt-image-1-mini), [Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare).

## Artifacts and regression checks

The ignored local directory `generated/model-benchmark/` contains the runner (`run.ts`), input blueprints, hydrated outputs, four images, and `results.json` with timings, full text responses, and usage. It contains no credentials. Re-running it makes paid requests; use a fresh directory to preserve this run. Total estimated benchmark cost: $0.0614, excluding the subsequent small production-provider smoke request.

The changed production provider also passed a separate live structured-output request through `createProvidersFromEnv`. Unit tests cover Luna's default request, Zod structured output, legacy/custom model overrides without reasoning parameters, environment-based rollback, Mini image defaults, and the Flare override. Existing regression tests cover the rest of the application without paid generation.

Verification: build (including lint, source/test type checks, Knip and no-cast checks), formatting, and the full suite passed: **1,206 passed, 1 skipped**. An initial full run timed out on the first MCP CLI call at its 10-second subprocess deadline; all five MCP tests passed in isolation, then the entire unchanged suite passed in 9.87 seconds. The timeout was intermittent; its underlying cause was not established.
