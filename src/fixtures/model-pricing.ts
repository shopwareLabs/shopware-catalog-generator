/**
 * Model pricing fixture - USD list prices used by the hydration cost forecast.
 *
 * Prices change. Keep PRICING_AS_OF current when editing and verify against
 * https://platform.openai.com/docs/pricing before relying on exact numbers.
 * Unknown models are reported without a price instead of guessing.
 */

import type { ImageModelPrice, TextModelPrice } from "../types/index.js";

/** Date the prices below were last checked */
export const PRICING_AS_OF = "2026-11";

/** OpenAI text models, USD per 1M tokens (standard tier, no batch/caching discount) */
export const OPENAI_TEXT_PRICES: Record<string, TextModelPrice> = {
    "gpt-6-luna": { inputPerMillion: 0.1, outputPerMillion: 0.5 },
    "gpt-5.4-mini": { inputPerMillion: 0.75, outputPerMillion: 4.5 },
    "gpt-5.4-nano": { inputPerMillion: 0.2, outputPerMillion: 1.25 },
    "gpt-4.1": { inputPerMillion: 2.0, outputPerMillion: 8.0 },
    "gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6 },
    "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10.0 },
};

/**
 * OpenAI image models, USD per image at 1536x1024 (the provider's default size).
 * Square images are slightly cheaper, so these act as an upper bound.
 */
export const OPENAI_IMAGE_PRICES: Record<string, ImageModelPrice> = {
    "gpt-image-1-mini": { low: 0.006, medium: 0.015, high: 0.052 },
    "gpt-image-1.5": { low: 0.011, medium: 0.019, high: 0.065 },
    "gpt-image-1": { low: 0.016, medium: 0.063, high: 0.25 },
};
