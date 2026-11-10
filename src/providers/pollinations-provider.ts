import type { z } from "zod";

import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";

import type {
    ChatMessage,
    ImageGenerationOptions,
    ImageProvider,
    TextProvider,
} from "../types/index.js";

import { DEFAULT_POLLINATIONS_IMAGE_MODEL } from "../types/index.js";
import { logger } from "../utils/index.js";

const BALANCE_TIP = [
    `\n💡 TIP: Your Pollinations account has insufficient pollen balance.`,
    `   Top up your balance at https://enter.pollinations.ai`,
    `   Or switch to a secret key (sk_*) which has no balance constraints.`,
];

interface TextErrorTip {
    /** HTTP status, also matched as text in the error message */
    status: number;
    /** Text in the error message that identifies the error */
    phrase: string;
    lines: string[];
}

/** Checked in order, the first match wins */
const TEXT_ERROR_TIPS: TextErrorTip[] = [
    { status: 402, phrase: "Insufficient balance", lines: BALANCE_TIP },
    {
        status: 401,
        phrase: "Invalid API key",
        lines: [
            `\n💡 TIP: Authentication failed with Pollinations.`,
            `   Check your AI_API_KEY in .env is correct.`,
            `   Get a key at https://enter.pollinations.ai`,
        ],
    },
    {
        status: 429,
        phrase: "rate",
        lines: [`\n💡 TIP: Rate limited by Pollinations.`, `   Wait a moment and try again.`],
    },
];

function logTips(lines: string[]): void {
    lines.forEach((line) => logger.info(line, { cli: true }));
}

/** `value.status` when it is a number */
function numericStatus(value: unknown): number | null {
    if (!value || typeof value !== "object" || !("status" in value)) return null;
    return typeof value.status === "number" ? value.status : null;
}

/** HTTP status of an OpenAI SDK error (`status`) or a nested error (`error.status`) */
function extractStatusCode(error: unknown): number | null {
    const status = numericStatus(error);
    if (status !== null) return status;
    if (!error || typeof error !== "object" || !("error" in error)) return null;
    return numericStatus(error.error);
}

function findTextErrorTip(status: number | null, message: string): TextErrorTip | undefined {
    return TEXT_ERROR_TIPS.find(
        (tip) =>
            status === tip.status ||
            message.includes(String(tip.status)) ||
            message.includes(tip.phrase)
    );
}

/** Log a failed text request with a tip for balance, authentication and rate limit errors */
function logTextApiError(error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const status = extractStatusCode(error);

    logger.error(`\n❌ Pollinations AI text generation failed`);
    logger.error(`   Error: ${errorMessage}`);
    logTips(findTextErrorTip(status, errorMessage)?.lines ?? []);
    logger.info(""); // Empty line for readability
}

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
            logTextApiError(error);
            throw error;
        }
    }
}

/** Available Pollinations image models */
const POLLINATIONS_IMAGE_MODELS = ["flux", "klein", "zimage"] as const;

/** Image requests are cut off after 2 minutes */
const IMAGE_TIMEOUT_MS = 120000;

/**
 * Prompts are cut to avoid URL length limits (URLs max ~2000 chars).
 * After URL encoding, characters can triple in size.
 */
const MAX_PROMPT_LENGTH = 500;

/** `value.message`, or undefined for values without one */
function messageField(value: unknown): unknown {
    if (!value || typeof value !== "object" || !("message" in value)) return undefined;
    return value.message;
}

/** The message of a JSON-encoded error inside the message, or the message itself */
function unwrapNestedMessage(message: string): string {
    if (!message.startsWith("{")) return message;
    try {
        const nested = messageField(JSON.parse(message));
        return typeof nested === "string" && nested ? nested : message;
    } catch {
        return message; // Keep original message if parsing fails
    }
}

/**
 * Error message of a failed image response (`error.message`, then `message`, else "").
 * Returns null when the body is not a JSON error object.
 */
async function readErrorMessage(response: Response): Promise<string | null> {
    try {
        const data: unknown = await response.json();
        if (data === null) return null;
        const nested = typeof data === "object" && "error" in data ? data.error : undefined;
        const message = messageField(nested) || messageField(data) || "";
        return typeof message === "string" ? unwrapNestedMessage(message) : null;
    } catch {
        return null;
    }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

/** Pollinations.ai image generation provider. Works without API key (free, rate-limited). */
export class PollinationsImageProvider implements ImageProvider {
    readonly isSequential: boolean;
    readonly maxConcurrency: number;
    readonly name = "pollinations";

    private readonly apiKey: string;
    private readonly model: string;

    constructor(apiKey: string = "", model: string = DEFAULT_POLLINATIONS_IMAGE_MODEL) {
        this.apiKey = apiKey;
        this.model = model;

        if (apiKey.startsWith("sk_")) {
            this.isSequential = false;
            this.maxConcurrency = 5;
        } else {
            // No key or pk_ key — sequential with limited parallelism
            this.isSequential = true;
            this.maxConcurrency = 2;
        }
    }

    async generateImage(prompt: string, options?: ImageGenerationOptions): Promise<string | null> {
        try {
            const response = await fetchWithTimeout(
                this.imageUrl(prompt, options),
                IMAGE_TIMEOUT_MS
            );
            if (!response.ok) {
                await this.handleErrorResponse(response);
                return null;
            }

            const buffer = await response.arrayBuffer();
            return Buffer.from(buffer).toString("base64");
        } catch (error) {
            this.logRequestFailure(error);
            return null;
        }
    }

    private imageUrl(prompt: string, options?: ImageGenerationOptions): string {
        const encodedPrompt = encodeURIComponent(prompt.slice(0, MAX_PROMPT_LENGTH));
        const width = options?.width ?? 1792;
        const height = options?.height ?? 1024;
        const keyParam = this.apiKey ? `&key=${this.apiKey}` : "";
        return `https://gen.pollinations.ai/image/${encodedPrompt}?width=${width}&height=${height}&model=${this.model}${keyParam}`;
    }

    private logRequestFailure(error: unknown): void {
        if (error instanceof Error && error.name === "AbortError") {
            logger.warn("Pollinations image generation timed out after 2 minutes");
            logger.info(`TIP: Try a different model with ${this.alternativeModelHint()}`, {
                cli: true,
            });
            return;
        }
        logger.warn("Pollinations image generation failed:", { data: error });
    }

    /**
     * Parse and display helpful error messages from Pollinations API
     */
    private async handleErrorResponse(response: Response): Promise<void> {
        const statusText = `${response.status} ${response.statusText}`;
        const errorMessage = await readErrorMessage(response);

        if (errorMessage === null) {
            logger.error(`Pollinations image generation failed: ${statusText}`);
            logger.info(`TIP: Try a different model with ${this.alternativeModelHint()}`, {
                cli: true,
            });
            return;
        }

        logger.error(`\n❌ Pollinations image generation failed: ${statusText}`);
        if (errorMessage) {
            logger.error(`   Error: ${errorMessage}`);
        }
        logTips(this.imageErrorTips(response.status, errorMessage));
        logger.info(""); // Empty line for readability
    }

    /** Tips for a failed image response, based on status and error message */
    private imageErrorTips(status: number, errorMessage: string): string[] {
        if (status === 402 || errorMessage.includes("Insufficient balance")) {
            return BALANCE_TIP;
        }
        if (errorMessage.includes("No active") && errorMessage.includes("servers available")) {
            return [
                `\n💡 TIP: The "${this.model}" model is currently unavailable.`,
                `   Try switching to a different model in your .env file:`,
                ...this.alternativeModels().map((m) => `   IMAGE_MODEL=${m}`),
            ];
        }
        if (status === 401) {
            return [
                `\n💡 TIP: Authentication failed. Check your API key at https://enter.pollinations.ai`,
            ];
        }
        if (status === 429) {
            return [`\n💡 TIP: Rate limited. Wait a moment and try again.`];
        }
        return [];
    }

    /** Free image models other than the current one */
    private alternativeModels(): string[] {
        return POLLINATIONS_IMAGE_MODELS.filter((m) => m !== this.model);
    }

    /** e.g. "IMAGE_MODEL=klein or IMAGE_MODEL=zimage" */
    private alternativeModelHint(): string {
        return this.alternativeModels()
            .slice(0, 2)
            .map((m) => `IMAGE_MODEL=${m}`)
            .join(" or ");
    }
}
