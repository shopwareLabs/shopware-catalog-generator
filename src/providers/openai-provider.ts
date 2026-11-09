import type { z } from "zod";

import OpenAI, { toFile } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";

import type {
    ChatMessage,
    ImageGenerationOptions,
    ImageProvider,
    TextProvider,
    TokenUsage,
} from "../types/index.js";

import { PROVIDER_DEFAULTS } from "../types/index.js";
import { logger } from "../utils/index.js";

/**
 * OpenAI text generation provider
 * Supports parallel processing with high rate limits
 */
export class OpenAITextProvider implements TextProvider {
    private readonly client: OpenAI;
    private readonly model: string;
    private readonly usage: TokenUsage = {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
    };

    readonly isSequential = false;
    readonly maxConcurrency = 5;
    readonly name = "openai";
    readonly tokenLimit = PROVIDER_DEFAULTS.openai.tokenLimit;

    constructor(
        apiKey: string,
        model: string = PROVIDER_DEFAULTS.openai.textModel,
        baseUrl?: string
    ) {
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

        // Catalog copy does not need reasoning. Keep legacy/custom models' parameters unchanged.
        if (this.model === "gpt-6-luna") {
            requestOptions.reasoning_effort = "none";
        }

        if (schema && schemaName) {
            requestOptions.response_format = zodResponseFormat(schema, schemaName);
        }

        const completion = await this.client.chat.completions.create(requestOptions);
        this.recordUsage(completion.usage);

        return completion.choices[0]?.message.content || "";
    }

    getUsage(): TokenUsage {
        return { ...this.usage };
    }

    private recordUsage(usage: OpenAI.CompletionUsage | undefined): void {
        if (!usage) return;

        const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0;
        this.usage.calls++;
        this.usage.inputTokens += usage.prompt_tokens;
        this.usage.outputTokens += usage.completion_tokens;
        this.usage.reasoningTokens += reasoningTokens;

        logger.debug("OpenAI token usage", {
            data: {
                model: this.model,
                inputTokens: usage.prompt_tokens,
                outputTokens: usage.completion_tokens,
                reasoningTokens,
            },
        });
    }
}

/**
 * OpenAI image generation provider (GPT Image models)
 * Supports parallel processing with high rate limits
 * Concurrency is not a rate limit: image quotas depend on the account's usage tier.
 */
/** Per-request timeout for image edits (low quality edits normally take well under a minute) */
const IMAGE_EDIT_TIMEOUT_MS = 180_000;

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

            return await this.readImageData(response.data?.[0]);
        } catch (error) {
            logger.warn(`OpenAI image generation failed:`, { data: error });
            return null;
        }
    }

    /**
     * Edit an image (e.g. recolour a product). Sends the source as WebP or PNG,
     * returns WebP like generateImage.
     */
    async editImage(
        prompt: string,
        sourceBase64: string,
        options?: ImageGenerationOptions
    ): Promise<string | null> {
        try {
            const buffer = Buffer.from(sourceBase64, "base64");
            const type = detectImageMimeType(buffer);
            const image = await toFile(buffer, `source.${type.split("/")[1]}`, { type });
            const response = await this.client.images.edit(
                {
                    model: this.model,
                    image,
                    prompt,
                    size: this.mapToOpenAISize(options),
                    quality: this.quality,
                    output_format: "webp",
                    n: 1,
                },
                // The caller retries; without a timeout a stuck edit blocks for 10 min x 3 SDK attempts
                { timeout: IMAGE_EDIT_TIMEOUT_MS, maxRetries: 0 }
            );
            return await this.readImageData(response.data?.[0]);
        } catch (error) {
            logger.warn(`OpenAI image edit failed:`, { data: error });
            return null;
        }
    }

    private async readImageData(
        imageData: { b64_json?: string; url?: string } | undefined
    ): Promise<string | null> {
        if (!imageData) return null;
        if (imageData.b64_json) return imageData.b64_json;
        if (!imageData.url) return null;

        const imageResponse = await fetch(imageData.url);
        const buffer = await imageResponse.arrayBuffer();
        return Buffer.from(buffer).toString("base64");
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

/** WebP ("RIFF....WEBP"), JPEG or PNG from the file signature; PNG when unknown */
export function detectImageMimeType(buffer: Buffer): "image/webp" | "image/jpeg" | "image/png" {
    if (
        buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
        return "image/webp";
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
    return "image/png";
}
