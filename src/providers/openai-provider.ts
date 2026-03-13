import type { z } from "zod";

import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";

import type {
    ChatMessage,
    ImageGenerationOptions,
    ImageProvider,
    TextProvider,
} from "../types/index.js";

import { logger } from "../utils/index.js";

/**
 * OpenAI text generation provider
 * Supports parallel processing with high rate limits
 */
export class OpenAITextProvider implements TextProvider {
    private readonly client: OpenAI;
    private readonly model: string;

    readonly isSequential = false;
    readonly maxConcurrency = 5;
    readonly name = "openai";
    readonly tokenLimit = 128000; // GPT-4 Turbo context window

    constructor(apiKey: string, model: string = "gpt-4.1-2025-04-14", baseUrl?: string) {
        this.client = new OpenAI({
            apiKey,
            baseURL: baseUrl,
        });
        this.model = model;
    }

    async generateCompletion(
        messages: ChatMessage[],
        schema?: z.ZodTypeAny,
        schemaName?: string
    ): Promise<string> {
        const requestOptions: OpenAI.Chat.ChatCompletionCreateParams = {
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            model: this.model,
        };

        if (schema && schemaName) {
            requestOptions.response_format = zodResponseFormat(schema, schemaName);
        }

        const completion = await this.client.chat.completions.create(requestOptions);

        return completion.choices[0]?.message.content || "";
    }
}

/**
 * OpenAI image generation provider (GPT Image models)
 * Supports parallel processing with high rate limits
 * OpenAI Tier 1+ allows 50+ images/min, so 10 concurrent is safe
 */
export class OpenAIImageProvider implements ImageProvider {
    private readonly client: OpenAI;
    private readonly model: string;
    private readonly quality: "low" | "medium" | "high" | "auto";

    readonly isSequential = false;
    readonly maxConcurrency = 10;
    readonly name = "openai";

    constructor(apiKey: string, model: string = "gpt-image-1-mini", quality: string = "low") {
        this.client = new OpenAI({
            apiKey,
        });
        this.model = model;
        this.quality = this.parseQuality(quality);
    }

    async generateImage(prompt: string, options?: ImageGenerationOptions): Promise<string | null> {
        try {
            const size = this.mapToOpenAISize(options);
            const response = await this.client.images.generate({
                model: this.model,
                prompt,
                size,
                quality: this.quality,
                output_format: "webp",
                n: 1,
            });

            const imageData = response.data?.[0];
            if (!imageData) return null;

            if (imageData.b64_json) {
                return imageData.b64_json;
            }

            if (imageData.url) {
                const imageResponse = await fetch(imageData.url);
                const buffer = await imageResponse.arrayBuffer();
                return Buffer.from(buffer).toString("base64");
            }

            return null;
        } catch (error) {
            logger.warn(`OpenAI image generation failed:`, { data: error });
            return null;
        }
    }

    private parseQuality(quality: string): "low" | "medium" | "high" | "auto" {
        const valid = ["low", "medium", "high", "auto"] as const;
        const normalized = quality.toLowerCase();
        if (valid.includes(normalized as (typeof valid)[number])) {
            return normalized as "low" | "medium" | "high" | "auto";
        }
        return "low";
    }

    /**
     * Map width/height to closest supported OpenAI size.
     * Supported: 1024x1024, 1536x1024 (landscape), 1024x1536 (portrait)
     */
    private mapToOpenAISize(
        options?: ImageGenerationOptions
    ): "1024x1024" | "1536x1024" | "1024x1536" {
        if (!options?.width || !options?.height) return "1536x1024";

        const ratio = options.width / options.height;
        if (ratio > 1.2) return "1536x1024";
        if (ratio < 0.8) return "1024x1536";
        return "1024x1024";
    }
}
