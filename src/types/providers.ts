import type { z } from "zod";

/**
 * AI Provider types and interfaces
 */

/** Message format for chat completions */
export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

/** Text generation provider interface */
export interface TextProvider {
    /**
     * Generate a chat completion with optional structured output
     * @param messages - Array of chat messages
     * @param schema - Optional Zod schema for structured output
     * @param schemaName - Name for the schema (required if schema is provided)
     * @returns The generated text content
     */
    generateCompletion(
        messages: ChatMessage[],
        schema?: z.ZodTypeAny,
        schemaName?: string
    ): Promise<string>;

    /** Whether this provider requires sequential processing due to rate limits */
    readonly isSequential: boolean;

    /** Maximum concurrent requests this provider supports (1 = sequential) */
    readonly maxConcurrency: number;

    /** Provider name for logging */
    readonly name: string;

    /** Token limit for this provider's model (for payload size checks) */
    readonly tokenLimit: number;
}

/** Image generation provider interface */
export interface ImageProvider {
    /**
     * Generate an image from a text prompt
     * @param prompt - Text description of the image to generate
     * @returns Base64-encoded image data, or null if generation failed
     */
    generateImage(prompt: string): Promise<string | null>;

    /** Whether this provider requires sequential processing due to rate limits */
    readonly isSequential: boolean;

    /** Maximum concurrent image requests this provider supports (1 = sequential) */
    readonly maxConcurrency: number;

    /** Provider name for logging */
    readonly name: string;
}

/** Supported AI providers */
export type AIProviderType = "openai" | "github-models" | "pollinations";

/** Supported image providers */
export type ImageProviderType = "openai" | "pollinations" | "none";

/** Provider configuration from environment variables */
export interface ProviderConfig {
    /** Main AI provider for text generation */
    aiProvider: AIProviderType;

    /** API key for paid providers (optional for pollinations) */
    apiKey?: string;

    /** Override the default text model */
    textModel?: string;

    /** Override the image provider (defaults based on aiProvider) */
    imageProvider?: ImageProviderType;

    /** Separate API key for image provider if different from text */
    imageApiKey?: string;

    /** Override the default image model */
    imageModel?: string;
}

/** Provider defaults for each AI provider type */
export const PROVIDER_DEFAULTS: Record<
    AIProviderType,
    {
        baseUrl?: string;
        textModel: string;
        imageModel?: string;
        supportsImages: boolean;
        isSequential: boolean;
        requiresApiKey: boolean;
        tokenLimit: number;
    }
> = {
    openai: {
        textModel: "gpt-4.1-2025-04-14",
        imageModel: "gpt-image-1.5",
        supportsImages: true,
        isSequential: false,
        requiresApiKey: true,
        tokenLimit: 128000, // GPT-4 Turbo context window
    },
    "github-models": {
        baseUrl: "https://models.inference.ai.azure.com",
        textModel: "gpt-4o",
        supportsImages: false,
        isSequential: true,
        requiresApiKey: true,
        tokenLimit: 128000, // GPT-4o context window
    },
    pollinations: {
        baseUrl: "https://gen.pollinations.ai/v1",
        textModel: "openai",
        imageModel: "flux",
        supportsImages: true,
        isSequential: true,
        requiresApiKey: false,
        tokenLimit: 32000, // Conservative limit for free tier
    },
};
