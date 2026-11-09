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
 * OpenAI image models, USD image output cost per image at 1536x1024 (the provider's
 * default size), standard tier. Prompt text tokens are not included (a few cents per store).
 *
 * gpt-image-1-mini / 1.5: legacy per-image table in the image generation guide.
 * gpt-image-2 / 2.5 / 2.6: output tokens from the guide's token calculator at $30 per 1M.
 * gpt-image-2.6 uses more tokens than 2.5 at low and medium quality, so it costs more there.
 * Square images cost more than landscape for gpt-image-2+, and less for older models.
 */
export const OPENAI_IMAGE_PRICES: Record<string, ImageModelPrice> = {
    "gpt-image-1-mini": { low: 0.006, medium: 0.015, high: 0.052 },
    "gpt-image-1.5": { low: 0.013, medium: 0.05, high: 0.2 },
    "gpt-image-2": { low: 0.0047, medium: 0.0412, high: 0.1646 },
    "gpt-image-2.5-flare": { low: 0.0047, medium: 0.0103, high: 0.0412 },
    "gpt-image-2.5-sunburst": { low: 0.0047, medium: 0.0103, high: 0.0412 },
    "gpt-image-2.6-flare": { low: 0.0199, medium: 0.034, high: 0.0412 },
    "gpt-image-2.6-sunburst": { low: 0.0199, medium: 0.034, high: 0.0412 },
};
