import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";

import type { ChatMessage, TextProvider } from "../types/index.js";

/**
 * GitHub Models text generation provider
 * Uses OpenAI SDK with custom baseURL
 * Requires sequential processing due to low concurrency limits (2 concurrent requests)
 */
export class GitHubModelsTextProvider implements TextProvider {
    private readonly client: OpenAI;
    private readonly model: string;

    readonly isSequential = true;
    readonly maxConcurrency = 2; // GitHub Models allows 2 concurrent requests
    readonly name = "github-models";
    readonly tokenLimit = 128000; // GPT-4o context window

    constructor(apiKey: string, model: string = "gpt-4o") {
        this.client = new OpenAI({
            apiKey,
            baseURL: "https://models.inference.ai.azure.com",
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
