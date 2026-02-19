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

/** Pollinations.ai text generation provider (requires API key from enter.pollinations.ai) */
export class PollinationsTextProvider implements TextProvider {
    private readonly client: OpenAI;
    private readonly model: string;

    readonly isSequential: boolean;
    readonly maxConcurrency: number;
    readonly name = "pollinations";
    readonly tokenLimit = 32000;

    constructor(model: string = "openai", apiKey: string) {
        this.client = new OpenAI({
            apiKey,
            baseURL: "https://gen.pollinations.ai/v1",
        });
        this.model = model;

        // Secret keys (sk_*) have no rate limits - enable parallel processing
        // Publishable keys (pk_*) - sequential only
        if (apiKey.startsWith("sk_")) {
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

        try {
            const completion = await this.client.chat.completions.create(requestOptions);
            return completion.choices[0]?.message.content || "";
        } catch (error) {
            this.handleApiError(error);
            throw error;
        }
    }

    /**
     * Parse API errors and provide helpful messages
     */
    private handleApiError(error: unknown): void {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const status = this.extractStatusCode(error);

        logger.error(`\n❌ Pollinations AI text generation failed`);
        logger.error(`   Error: ${errorMessage}`);

        if (
            status === 401 ||
            errorMessage.includes("401") ||
            errorMessage.includes("Invalid API key")
        ) {
            logger.info(`\n💡 TIP: Authentication failed with Pollinations.`, { cli: true });
            logger.info(`   Check your AI_API_KEY in .env is correct.`, { cli: true });
            logger.info(`   Get a key at https://enter.pollinations.ai`, { cli: true });
        } else if (
            status === 429 ||
            errorMessage.includes("429") ||
            errorMessage.includes("rate")
        ) {
            logger.info(`\n💡 TIP: Rate limited by Pollinations.`, { cli: true });
            logger.info(`   Wait a moment and try again.`, { cli: true });
        }

        logger.info(""); // Empty line for readability
    }

    /**
     * Try to extract HTTP status code from error
     */
    private extractStatusCode(error: unknown): number | null {
        if (error && typeof error === "object") {
            // OpenAI SDK error format
            if ("status" in error && typeof error.status === "number") {
                return error.status;
            }
            // Nested error format
            if ("error" in error && error.error && typeof error.error === "object") {
                const innerError = error.error as Record<string, unknown>;
                if ("status" in innerError && typeof innerError.status === "number") {
                    return innerError.status;
                }
            }
        }
        return null;
    }
}

/** Available Pollinations image models */
const POLLINATIONS_IMAGE_MODELS = ["flux", "klein", "turbo"] as const;

/** Pollinations.ai image generation provider (requires API key from enter.pollinations.ai) */
export class PollinationsImageProvider implements ImageProvider {
    readonly isSequential: boolean;
    readonly maxConcurrency: number;
    readonly name = "pollinations";

    private readonly apiKey: string;
    private readonly model: string;

    constructor(apiKey: string, model: string = "klein") {
        this.apiKey = apiKey;
        this.model = model;

        // Secret keys (sk_*) have no rate limits - enable parallel processing
        // Publishable keys (pk_*) - limited parallelism
        if (apiKey.startsWith("sk_")) {
            this.isSequential = false;
            this.maxConcurrency = 5;
        } else {
            this.isSequential = true;
            this.maxConcurrency = 2;
        }
    }

    async generateImage(prompt: string, options?: ImageGenerationOptions): Promise<string | null> {
        try {
            // Truncate prompt to avoid URL length limits (URLs max ~2000 chars)
            // After URL encoding, characters can triple in size, so limit to ~500 chars
            const truncatedPrompt = prompt.length > 500 ? prompt.slice(0, 500) : prompt;
            const encodedPrompt = encodeURIComponent(truncatedPrompt);
            const width = options?.width ?? 1792;
            const height = options?.height ?? 1024;
            const url = `https://gen.pollinations.ai/image/${encodedPrompt}?width=${width}&height=${height}&model=${this.model}&key=${this.apiKey}`;

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
                logger.warn("Pollinations image generation timed out after 2 minutes");
                logger.info(
                    "TIP: Try a different model with IMAGE_MODEL=flux or IMAGE_MODEL=turbo",
                    {
                        cli: true,
                    }
                );
            } else {
                logger.warn("Pollinations image generation failed:", { data: error });
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

            logger.error(`\n❌ Pollinations image generation failed: ${statusText}`);

            if (errorMessage) {
                logger.error(`   Error: ${errorMessage}`);
            }

            // Provide helpful tips based on error
            if (errorMessage.includes("No active") && errorMessage.includes("servers available")) {
                const otherModels = POLLINATIONS_IMAGE_MODELS.filter((m) => m !== this.model);
                logger.info(`\n💡 TIP: The "${this.model}" model is currently unavailable.`, {
                    cli: true,
                });
                logger.info(`   Try switching to a different model in your .env file:`, {
                    cli: true,
                });
                otherModels.forEach((m) => {
                    logger.info(`   IMAGE_MODEL=${m}`, { cli: true });
                });
            } else if (response.status === 401) {
                logger.info(
                    `\n💡 TIP: Authentication failed. Check your API key at https://enter.pollinations.ai`,
                    { cli: true }
                );
            } else if (response.status === 429) {
                logger.info(`\n💡 TIP: Rate limited. Wait a moment and try again.`, {
                    cli: true,
                });
            }

            logger.info(""); // Empty line for readability
        } catch {
            // If JSON parsing fails, just show the status
            logger.error(`Pollinations image generation failed: ${statusText}`);
            logger.info(`TIP: Try a different model with IMAGE_MODEL=flux or IMAGE_MODEL=klein`, {
                cli: true,
            });
        }
    }
}
