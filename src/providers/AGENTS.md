# Providers Documentation

Internal documentation for AI agents working on the providers module.

## Overview

Providers abstract AI services for text and image generation. The module supports multiple backends with consistent interfaces.

## Interfaces

### TextProvider

```typescript
interface TextProvider {
    generateCompletion(messages: ChatMessage[], schema?: z.ZodTypeAny): Promise<string>;
    readonly isSequential: boolean; // Rate limit handling
    readonly maxConcurrency: number; // Parallel processing limit
    readonly name: string;
    readonly tokenLimit: number; // For payload chunking
}
```

### ImageProvider

```typescript
interface ImageProvider {
    generateImage(prompt: string, options?: ImageOptions): Promise<Buffer>;
    readonly name: string;
}
```

## Available Providers

### Text Providers

| Provider              | Name            | maxConcurrency | Notes                           |
| --------------------- | --------------- | -------------- | ------------------------------- |
| OpenAI                | `openai`        | 5              | High rate limits                |
| GitHub Models         | `github-models` | 2              | 2 concurrent request limit      |
| Pollinations (sk\_\*) | `pollinations`  | 5              | Secret keys have no rate limits |
| Pollinations (free)   | `pollinations`  | 1              | Sequential due to rate limits   |

### Image Providers

| Provider     | Name           | Model        | Notes                           |
| ------------ | -------------- | ------------ | ------------------------------- |
| OpenAI       | `openai`       | gpt-image-1.5 | Returns URL, fetched to base64 |
| Pollinations | `pollinations` | flux/turbo   | Direct base64 response          |
| Noop         | `none`         | -            | Disabled (no images)            |

**OpenAI Image Notes:**
- Uses `gpt-image-1.5` model (latest, Dec 2025)
- Supported sizes: `1024x1024`, `1536x1024` (landscape), `1024x1536` (portrait), `auto`
- Returns URL by default - provider fetches and converts to base64
- Does NOT support `response_format: "b64_json"` parameter
- Image generation has retry logic (3 retries, 5s backoff)

## Factory

Providers are created via factory from environment variables:

```typescript
import { createProvidersFromEnv } from "./providers/index.js";

const { text, image } = createProvidersFromEnv();
```

## Environment Variables

```env
AI_PROVIDER=pollinations|github-models|openai
AI_API_KEY=xxx
AI_MODEL=gpt-4o  # Optional override

IMAGE_PROVIDER=pollinations|openai|none
IMAGE_API_KEY=xxx
IMAGE_MODEL=flux|turbo|klein  # For Pollinations
```

## Adding a New Provider

1. Create `src/providers/my-provider.ts`:

```typescript
import type { TextProvider, ImageProvider } from "../types/index.js";

export class MyTextProvider implements TextProvider {
    readonly name = "my-provider";
    readonly isSequential = false;
    readonly maxConcurrency = 5;
    readonly tokenLimit = 8000;

    async generateCompletion(messages: ChatMessage[], schema?: z.ZodTypeAny): Promise<string> {
        // Implementation
    }
}
```

2. Add to factory in `src/providers/factory.ts`:

```typescript
case "my-provider":
    return new MyTextProvider(apiKey, model);
```

3. Add type to `AIProviderType` in `src/types/providers.ts`:

```typescript
export type AIProviderType = "openai" | "github-models" | "pollinations" | "my-provider";
```

4. Export from `src/providers/index.ts`

## Rate Limit Handling

Providers with rate limits should set `isSequential: true` or low `maxConcurrency`.

The application uses `executeWithRetry()` for automatic retry on 429 errors:

- Exponential backoff: 10s → 20s → 40s → 80s → 160s
- Max 5 retries
- Handles GitHub Models' 10 requests/60s limit
