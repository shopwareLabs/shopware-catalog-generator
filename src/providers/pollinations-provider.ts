import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";

import type { ChatMessage, ImageProvider, TextProvider } from "../types/index.js";

/** Pollinations.ai text generation provider (see README for details) */
export class PollinationsTextProvider implements TextProvider {
    private readonly client: OpenAI;
    private readonly model: string;

    readonly isSequential: boolean;
    readonly maxConcurrency: number;
    readonly name = "pollinations";
    readonly tokenLimit = 32000; // Conservative limit for free tier

    constructor(model: string = "openai", apiKey?: string) {
        this.client = new OpenAI({
            apiKey: apiKey || "pollinations", // Use API key if provided, otherwise dummy
            baseURL: "https://gen.pollinations.ai/v1",
        });
        this.model = model;

        // Secret keys (sk_*) have no rate limits - enable parallel processing
        // Publishable keys (pk_*) or no key - sequential only
        if (apiKey?.startsWith("sk_")) {
            this.isSequential = false;
            this.maxConcurrency = 5;
        } else {
            this.isSequential = true;
            this.maxConcurrency = 1;
        }
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

/** Available Pollinations image models (see README for pricing) */
const POLLINATIONS_IMAGE_MODELS = ["flux", "klein", "turbo"] as const;

/** Pollinations.ai image generation provider */
export class PollinationsImageProvider implements ImageProvider {
    readonly isSequential: boolean;
    readonly maxConcurrency: number;
    readonly name = "pollinations";

    private readonly apiKey?: string;
    private readonly model: string;

    constructor(apiKey?: string, model: string = "klein") {
        this.apiKey = apiKey;
        this.model = model;

        // Secret keys (sk_*) have no rate limits - enable parallel processing
        // Publishable keys (pk_*) or no key - limited parallelism
        if (apiKey?.startsWith("sk_")) {
            this.isSequential = false;
            this.maxConcurrency = 5;
        } else {
            this.isSequential = true;
            this.maxConcurrency = 2; // Allow some parallelism even without key
        }
    }

    async generateImage(prompt: string): Promise<string | null> {
        try {
            // Truncate prompt to avoid URL length limits (URLs max ~2000 chars)
            // After URL encoding, characters can triple in size, so limit to ~500 chars
            const truncatedPrompt = prompt.length > 500 ? prompt.slice(0, 500) : prompt;
            const encodedPrompt = encodeURIComponent(truncatedPrompt);
            // Landscape ratio ~1.75:1, matches Shopware product images (775x430)
            let url = `https://gen.pollinations.ai/image/${encodedPrompt}?width=1792&height=1024&model=${this.model}`;

            // Add API key if available
            if (this.apiKey) {
                url += `&key=${this.apiKey}`;
            }

            // Add timeout (2 minutes for image generation)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 120000);

            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) {
                await this.handleErrorResponse(response);
                return null;
            }

            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString("base64");

            return base64;
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                console.warn("Pollinations image generation timed out after 2 minutes");
                console.info(
                    "TIP: Try a different model with IMAGE_MODEL=flux or IMAGE_MODEL=turbo"
                );
            } else {
                console.warn("Pollinations image generation failed:", error);
            }
            return null;
        }
    }

    /**
     * Parse and display helpful error messages from Pollinations API
     */
    private async handleErrorResponse(response: Response): Promise<void> {
        const statusText = `${response.status} ${response.statusText}`;

        try {
            const errorData = (await response.json()) as {
                error?: { message?: string };
                message?: string;
            };

            // Try to extract the actual error message
            let errorMessage = errorData.error?.message || errorData.message || "";

            // Parse nested JSON error if present
            if (errorMessage.startsWith("{")) {
                try {
                    const nestedError = JSON.parse(errorMessage) as { message?: string };
                    errorMessage = nestedError.message || errorMessage;
                } catch {
                    // Keep original message if parsing fails
                }
            }

            console.error(`\n❌ Pollinations image generation failed: ${statusText}`);

            if (errorMessage) {
                console.error(`   Error: ${errorMessage}`);
            }

            // Provide helpful tips based on error
            if (errorMessage.includes("No active") && errorMessage.includes("servers available")) {
                const otherModels = POLLINATIONS_IMAGE_MODELS.filter((m) => m !== this.model);
                console.info(`\n💡 TIP: The "${this.model}" model is currently unavailable.`);
                console.info(`   Try switching to a different model in your .env file:`);
                otherModels.forEach((m) => {
                    console.info(`   IMAGE_MODEL=${m}`);
                });
            } else if (response.status === 401) {
                console.info(
                    `\n💡 TIP: Authentication failed. Check your API key or try without one.`
                );
            } else if (response.status === 429) {
                console.info(
                    `\n💡 TIP: Rate limited. Wait a moment or get an API key from enter.pollinations.ai`
                );
            }

            console.log(""); // Empty line for readability
        } catch {
            // If JSON parsing fails, just show the status
            console.error(`Pollinations image generation failed: ${statusText}`);
            console.info(`TIP: Try a different model with IMAGE_MODEL=flux or IMAGE_MODEL=klein`);
        }
    }
}
