import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";

import type { ChatMessage, ImageProvider, TextProvider } from "../types/index.js";

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
 * OpenAI image generation provider (DALL-E)
 * Supports parallel processing with high rate limits
 */
export class OpenAIImageProvider implements ImageProvider {
    private readonly client: OpenAI;
    private readonly model: string;

    readonly isSequential = false;
    readonly maxConcurrency = 5;
    readonly name = "openai";

    constructor(apiKey: string, model: string = "gpt-image-1") {
        this.client = new OpenAI({
            apiKey,
        });
        this.model = model;
    }

    async generateImage(prompt: string): Promise<string | null> {
        try {
            // gpt-image-1 doesn't support response_format, returns URL by default
            // Supported sizes: 1024x1024, 1536x1024 (landscape), 1024x1536 (portrait)
            const response = await this.client.images.generate({
                model: this.model,
                prompt,
                size: "1792x1024", // Landscape ratio ~1.75:1
                n: 1,
            });

            // gpt-image-1 returns URL, need to fetch and convert to base64
            if (response.data[0]?.url) {
                const imageResponse = await fetch(response.data[0].url);
                const buffer = await imageResponse.arrayBuffer();
                return Buffer.from(buffer).toString("base64");
            }

            // Fallback for models that support b64_json
            if (response.data[0]?.b64_json) {
                return response.data[0].b64_json;
            }

            return null;
        } catch (error) {
            console.warn(`OpenAI image generation failed:`, error);
            return null;
        }
    }
}
