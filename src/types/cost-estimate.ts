/**
 * Cost estimate types - forecast what a hydration run will cost before any AI call.
 */

import type { AIProviderType, ImageProviderType } from "./providers.js";

/** Hydration scope the estimate covers (mirrors `blueprint hydrate --only`) */
export type HydrationScope = "full" | "categories" | "properties" | "cms";

/** Resolved provider/model selection (what the factory will actually use) */
export interface ModelSelection {
    textProvider: AIProviderType;
    textModel: string;
    imageProvider: ImageProviderType;
    /** Undefined when images are disabled */
    imageModel?: string;
    /** OpenAI only: low | medium | high | auto */
    imageQuality?: string;
    /** True when Pollinations images run on the keyless free tier */
    imageFreeTier: boolean;
}

/** Token usage accumulated by a text provider */
export interface TokenUsage {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    /** Reasoning tokens (already included in outputTokens, billed as output) */
    reasoningTokens: number;
}

/** USD price per 1M tokens for a text model */
export interface TextModelPrice {
    inputPerMillion: number;
    outputPerMillion: number;
}

/** USD price per generated image by quality level */
export interface ImageModelPrice {
    low: number;
    medium: number;
    high: number;
}

/** One line item of the text forecast */
export interface TextCostItem {
    label: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
}

/** One line item of the image forecast */
export interface ImageCostItem {
    label: string;
    /** Images that will be generated (cached ones excluded) */
    count: number;
}

/** Image counts that the estimator should charge for */
export interface PendingImageCounts {
    cms: number;
    product: number;
    category: number;
    theme: number;
}

/** Complete cost forecast for one hydration run */
export interface CostEstimate {
    scope: HydrationScope;
    selection: ModelSelection;
    text: {
        items: TextCostItem[];
        calls: number;
        inputTokens: number;
        outputTokens: number;
        /** Null when no price data exists for the model/provider */
        usd: number | null;
    };
    images: {
        items: ImageCostItem[];
        count: number;
        /** Price per image used for the forecast, null when unknown */
        unitUsd: number | null;
        /** Null when no price data exists for the model/provider */
        usd: number | null;
    };
    /** Null when any priced part is unknown */
    totalUsd: number | null;
    notes: string[];
}
