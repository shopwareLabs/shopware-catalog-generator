import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";

import {
    createProviders,
    createProvidersFromEnv,
    OpenAIImageProvider,
    OpenAITextProvider,
} from "../../../src/providers/index.js";

describe("OpenAI SDK compatibility", () => {
    const requests: Request[] = [];
    let responseBody: unknown;
    let responseStatus: number;
    let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

    beforeEach(() => {
        requests.length = 0;
        responseStatus = 200;
        responseBody = { choices: [{ message: { content: "Generated text" } }] };
        const mockFetch = Object.assign(
            async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
                const request =
                    input instanceof Request
                        ? new Request(input, init)
                        : new Request(input.toString(), init);
                requests.push(request);
                if (request.url === "https://images.example.test/generated.webp") {
                    return new Response("image bytes");
                }
                return Response.json(responseBody, { status: responseStatus });
            },
            { preconnect: globalThis.fetch.preconnect }
        );
        fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockFetch);
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    async function requestBody(): Promise<unknown> {
        const request = requests[0];
        if (!request) throw new Error("The SDK did not send a request");
        return request.json();
    }

    test("defaults to Luna with reasoning disabled", async () => {
        await new OpenAITextProvider("test-key").generateCompletion([]);
        expect(await requestBody()).toEqual({
            model: "gpt-6-luna",
            reasoning_effort: "none",
            messages: [],
        });
    });

    test.each(["gpt-4.1-2025-04-14", "gpt-4o", "custom-model"])(
        "preserves the request contract for explicit model %s",
        async (model) => {
            const { text } = createProviders({
                aiProvider: "openai",
                apiKey: "test-key",
                textModel: model,
                imageProvider: "none",
            });
            await text.generateCompletion([]);
            expect(await requestBody()).toEqual({ model, messages: [] });
        }
    );

    test("factory uses the same Luna default as the provider constructor", async () => {
        const { text } = createProviders({
            aiProvider: "openai",
            apiKey: "test-key",
            imageProvider: "none",
        });
        await text.generateCompletion([]);
        expect(await requestBody()).toMatchObject({
            model: "gpt-6-luna",
            reasoning_effort: "none",
        });
    });

    test("AI_MODEL keeps the legacy model selectable through the environment", async () => {
        const keys = ["AI_PROVIDER", "AI_API_KEY", "AI_MODEL", "IMAGE_PROVIDER"] as const;
        const previous = keys.map((key) => [key, process.env[key]] as const);
        try {
            process.env.AI_PROVIDER = "openai";
            process.env.AI_API_KEY = "test-key";
            process.env.AI_MODEL = "gpt-4.1-2025-04-14";
            process.env.IMAGE_PROVIDER = "none";
            await createProvidersFromEnv().text.generateCompletion([]);
            expect(await requestBody()).toEqual({ model: "gpt-4.1-2025-04-14", messages: [] });
        } finally {
            for (const [key, value] of previous) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });

    test.each([undefined, "gpt-image-2.5-flare"])(
        "keeps Mini as default and allows opting into image model %s",
        async (imageModel) => {
            responseBody = { data: [{ b64_json: "aW1hZ2U=" }] };
            const { image } = createProviders({
                aiProvider: "openai",
                apiKey: "test-key",
                imageModel,
            });
            expect(await image.generateImage("Product photo")).toBe("aW1hZ2U=");
            expect(await requestBody()).toMatchObject({
                model: imageModel ?? "gpt-image-1-mini",
                quality: "low",
                output_format: "webp",
            });
        }
    );

    test("sends chat messages, configured model, and authentication to a custom endpoint", async () => {
        const provider = new OpenAITextProvider(
            "test-key",
            "test-model",
            "https://ai.example.test/v1"
        );
        const messages = [
            { role: "system", content: "Generate catalog content" },
            { role: "user", content: "Describe a product" },
        ] satisfies Parameters<typeof provider.generateCompletion>[0];

        expect(await provider.generateCompletion(messages)).toBe("Generated text");
        expect(requests[0]?.url).toBe("https://ai.example.test/v1/chat/completions");
        expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-key");
        expect(await requestBody()).toEqual({ model: "test-model", messages });
    });

    test("serializes a Zod 4 schema as strict structured output", async () => {
        const schema = z.object({ name: z.string(), price: z.number() });
        responseBody = { choices: [{ message: { content: '{"name":"Product","price":12}' } }] };
        const provider = new OpenAITextProvider("test-key");

        const output = await provider.generateCompletion(
            [{ role: "user", content: "Generate a product" }],
            schema,
            "product"
        );

        expect(schema.parse(JSON.parse(output))).toEqual({ name: "Product", price: 12 });
        expect(await requestBody()).toMatchObject({
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "product",
                    strict: true,
                    schema: {
                        type: "object",
                        additionalProperties: false,
                        properties: { name: { type: "string" }, price: { type: "number" } },
                        required: ["name", "price"],
                    },
                },
            },
        });
    });

    test.each([{ choices: [] }, { choices: [{ message: { content: null } }] }])(
        "preserves empty text response handling: %j",
        async (body) => {
            responseBody = body;
            expect(await new OpenAITextProvider("test-key").generateCompletion([])).toBe("");
        }
    );

    test("propagates text API errors to the existing retry layer", async () => {
        responseStatus = 400;
        responseBody = { error: { message: "Invalid request", type: "invalid_request_error" } };
        await expect(new OpenAITextProvider("test-key").generateCompletion([])).rejects.toThrow(
            "Invalid request"
        );
    });

    test.each([
        [undefined, "1536x1024"],
        [{ width: 1200, height: 630 }, "1536x1024"],
        [{ width: 96, height: 96 }, "1024x1024"],
        [{ width: 600, height: 900 }, "1024x1536"],
    ] as const)("maps image dimensions %j to %s and returns base64", async (options, size) => {
        responseBody = { data: [{ b64_json: "aW1hZ2U=" }] };
        const provider = new OpenAIImageProvider("test-key", "gpt-image-1-mini", "HIGH");

        expect(await provider.generateImage("Product photo", options)).toBe("aW1hZ2U=");
        expect(requests[0]?.url).toContain("/images/generations");
        expect(await requestBody()).toEqual({
            model: "gpt-image-1-mini",
            prompt: "Product photo",
            size,
            quality: "high",
            output_format: "webp",
            n: 1,
        });
    });

    test("downloads URL image responses and preserves the quality fallback", async () => {
        responseBody = { data: [{ url: "https://images.example.test/generated.webp" }] };
        const provider = new OpenAIImageProvider("test-key", "test-image-model", "invalid");

        expect(await provider.generateImage("Product photo")).toBe(
            Buffer.from("image bytes").toString("base64")
        );
        expect(requests).toHaveLength(2);
        expect(await requestBody()).toMatchObject({ quality: "low" });
    });

    test.each([{}, { data: [] }, { data: [{}] }])(
        "handles missing image data: %j",
        async (body) => {
            responseBody = body;
            expect(
                await new OpenAIImageProvider("test-key").generateImage("Product photo")
            ).toBeNull();
        }
    );

    test("returns null on image API errors so hydration can recover", async () => {
        responseStatus = 400;
        responseBody = {
            error: { message: "Invalid image request", type: "invalid_request_error" },
        };
        expect(await new OpenAIImageProvider("test-key").generateImage("Product photo")).toBeNull();
    });
});
