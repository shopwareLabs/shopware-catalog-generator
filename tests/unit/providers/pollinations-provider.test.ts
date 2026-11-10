import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Completions } from "openai/resources/chat/completions";
import { z } from "zod";

import type { LogOptions } from "../../../src/utils/index.js";

import {
    PollinationsTextProvider,
    PollinationsImageProvider,
} from "../../../src/providers/pollinations-provider.js";
import { DEFAULT_POLLINATIONS_IMAGE_MODEL } from "../../../src/types/index.js";
import { logger } from "../../../src/utils/index.js";

describe("PollinationsTextProvider", () => {
    describe("constructor", () => {
        test("uses default model with pk key", () => {
            const provider = new PollinationsTextProvider("openai", "pk_test123");
            expect(provider.name).toBe("pollinations");
        });

        test("uses custom model when specified", () => {
            const provider = new PollinationsTextProvider("gpt-4o", "pk_test123");
            expect(provider.name).toBe("pollinations");
        });

        test("is sequential with pk_* key", () => {
            const provider = new PollinationsTextProvider("openai", "pk_test123");
            expect(provider.isSequential).toBe(true);
            expect(provider.maxConcurrency).toBe(1);
        });

        test("is parallel with sk_* key", () => {
            const provider = new PollinationsTextProvider("openai", "sk_test123");
            expect(provider.isSequential).toBe(false);
            expect(provider.maxConcurrency).toBe(5);
        });

        test("has correct token limit", () => {
            const provider = new PollinationsTextProvider("openai", "pk_test123");
            expect(provider.tokenLimit).toBe(32000);
        });
    });
});

describe("PollinationsImageProvider", () => {
    describe("constructor", () => {
        test("uses default model when not specified", () => {
            const provider = new PollinationsImageProvider("pk_test123");
            expect(provider.name).toBe("pollinations");
        });

        test("uses custom model when specified", () => {
            const provider = new PollinationsImageProvider("pk_test123", "flux");
            expect(provider.name).toBe("pollinations");
        });

        test("is sequential with pk_* key", () => {
            const provider = new PollinationsImageProvider("pk_test123");
            expect(provider.isSequential).toBe(true);
            expect(provider.maxConcurrency).toBe(2);
        });

        test("is parallel with sk_* key", () => {
            const provider = new PollinationsImageProvider("sk_test123");
            expect(provider.isSequential).toBe(false);
            expect(provider.maxConcurrency).toBe(5);
        });
    });
});

const realFetch = globalThis.fetch;

interface LogCapture {
    errors: string[];
    infos: string[];
    /** Whether each info line was CLI output */
    infoCli: boolean[];
    warns: string[];
}

function captureLogs(): LogCapture {
    const logs: LogCapture = { errors: [], infos: [], infoCli: [], warns: [] };
    spyOn(logger, "error").mockImplementation((message: string) => {
        logs.errors.push(message);
    });
    spyOn(logger, "info").mockImplementation((message: string, options?: LogOptions) => {
        logs.infos.push(message);
        logs.infoCli.push(options?.cli === true);
    });
    spyOn(logger, "warn").mockImplementation((message: string) => {
        logs.warns.push(message);
    });
    return logs;
}

type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function setFetch(handler: FetchHandler): void {
    globalThis.fetch = Object.assign(handler, { preconnect: realFetch.preconnect });
}

function respondWith(response: () => Response, urls: string[] = []): void {
    setFetch(async (input) => {
        urls.push(String(input));
        return response();
    });
}

function failWith(error: unknown): void {
    setFetch(async () => {
        throw error;
    });
}

/** Make every chat completion call reject with the given value (bypasses SDK retries) */
function rejectCompletion(error: unknown): void {
    spyOn(Completions.prototype, "create").mockImplementation(() => {
        throw error;
    });
}

function jsonResponse(status: number, body: unknown): () => Response {
    return () =>
        new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
        });
}

function completion(content: string | null): () => Response {
    const choices = content === null ? [] : [{ index: 0, message: { role: "assistant", content } }];
    return jsonResponse(200, {
        id: "1",
        object: "chat.completion",
        created: 1,
        model: "m",
        choices,
    });
}

const BALANCE_TIP = "\n💡 TIP: Your Pollinations account has insufficient pollen balance.";
const AUTH_TIP = "\n💡 TIP: Authentication failed with Pollinations.";
const RATE_TIP = "\n💡 TIP: Rate limited by Pollinations.";

afterEach(() => {
    globalThis.fetch = realFetch;
    mock.restore();
});

describe("PollinationsTextProvider.generateCompletion", () => {
    const messages = [{ role: "user" as const, content: "Hi" }];

    test("returns the first choice content", async () => {
        respondWith(completion("Hello"));

        const provider = new PollinationsTextProvider("openai", "sk_x");
        expect(await provider.generateCompletion(messages)).toBe("Hello");
    });

    test("returns an empty string without choices", async () => {
        respondWith(completion(null));

        const provider = new PollinationsTextProvider("openai", "sk_x");
        expect(await provider.generateCompletion(messages)).toBe("");
    });

    test("sends the model, messages and the structured output format", async () => {
        const bodies: unknown[] = [];
        setFetch(async (_input, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            return completion("{}")();
        });

        const provider = new PollinationsTextProvider("my-model", "sk_x");
        const schema = z.object({ a: z.string() });
        await provider.generateCompletion(messages, schema, "Thing");
        await provider.generateCompletion(messages, schema);

        expect(bodies[0]).toMatchObject({
            model: "my-model",
            messages: [{ role: "user", content: "Hi" }],
            response_format: { type: "json_schema", json_schema: { name: "Thing" } },
        });
        expect(bodies[1]).not.toHaveProperty("response_format");
    });

    test("calls the Pollinations endpoint with the default model", async () => {
        const urls: string[] = [];
        const bodies: unknown[] = [];
        setFetch(async (input, init) => {
            urls.push(String(input));
            bodies.push(JSON.parse(String(init?.body)));
            return completion("ok")();
        });

        await new PollinationsTextProvider(undefined, "sk_x").generateCompletion(messages);

        expect(urls).toEqual(["https://gen.pollinations.ai/v1/chat/completions"]);
        expect(bodies[0]).toMatchObject({ model: "openai" });
    });

    test("explains a 402 balance error and rethrows", async () => {
        const logs = captureLogs();
        respondWith(jsonResponse(402, { error: { message: "Payment needed" } }));

        const provider = new PollinationsTextProvider("openai", "pk_x");
        await expect(provider.generateCompletion(messages)).rejects.toThrow();

        expect(logs.errors[0]).toBe("\n❌ Pollinations AI text generation failed");
        expect(logs.errors[1]?.startsWith("   Error: ")).toBe(true);
        expect(logs.infos).toEqual([
            BALANCE_TIP,
            "   Top up your balance at https://enter.pollinations.ai",
            "   Or switch to a secret key (sk_*) which has no balance constraints.",
            "",
        ]);
        expect(logs.infoCli).toEqual([true, true, true, false]);
    });

    test("explains a 401 authentication error", async () => {
        const logs = captureLogs();
        respondWith(jsonResponse(401, { error: { message: "nope" } }));

        const provider = new PollinationsTextProvider("openai", "pk_x");
        await expect(provider.generateCompletion(messages)).rejects.toThrow();

        expect(logs.infos).toEqual([
            AUTH_TIP,
            "   Check your AI_API_KEY in .env is correct.",
            "   Get a key at https://enter.pollinations.ai",
            "",
        ]);
    });

    test("prints the rate limit tip for 429 errors", async () => {
        const logs = captureLogs();
        rejectCompletion(Object.assign(new Error("Too many"), { status: 429 }));

        const provider = new PollinationsTextProvider("openai", "pk_x");
        await expect(provider.generateCompletion(messages)).rejects.toThrow();

        expect(logs.errors).toEqual([
            "\n❌ Pollinations AI text generation failed",
            "   Error: Too many",
        ]);
        expect(logs.infos).toEqual([RATE_TIP, "   Wait a moment and try again.", ""]);
    });

    test("detects the error kind from the message or status", async () => {
        const cases: Array<[unknown, string]> = [
            [new Error("HTTP 402"), BALANCE_TIP],
            [new Error("Insufficient balance"), BALANCE_TIP],
            [new Error("HTTP 401"), AUTH_TIP],
            [new Error("Invalid API key"), AUTH_TIP],
            [new Error("HTTP 429"), RATE_TIP],
            [new Error("rate exceeded"), RATE_TIP],
            [Object.assign(new Error("x"), { status: 401 }), AUTH_TIP],
            [{ error: { status: 402 } }, BALANCE_TIP],
            [{ error: { status: "402" } }, ""],
            [{ error: null }, ""],
            [{ error: "boom" }, ""],
            [{ status: "401" }, ""],
            [Object.assign(new Error("x"), { status: 500 }), ""],
            [{ status: "x", error: { status: 402 } }, BALANCE_TIP],
            ["plain failure", ""],
            [null, ""],
            [5, ""],
        ];

        for (const [error, firstInfo] of cases) {
            const logs = captureLogs();
            rejectCompletion(error);
            const provider = new PollinationsTextProvider("openai", "pk_x");
            await expect(provider.generateCompletion(messages)).rejects.toBe(error);
            expect([String(error), logs.infos[0]]).toEqual([String(error), firstInfo]);
            mock.restore();
        }
    });

    test("logs non-Error values as strings", async () => {
        const logs = captureLogs();
        rejectCompletion("plain failure");

        const provider = new PollinationsTextProvider("openai", "pk_x");
        await expect(provider.generateCompletion(messages)).rejects.toBe("plain failure");

        expect(logs.errors[1]).toBe("   Error: plain failure");
        expect(logs.infos).toEqual([""]);
    });
});

describe("PollinationsImageProvider.generateImage", () => {
    test("builds the image URL and returns the body as base64", async () => {
        const urls: string[] = [];
        respondWith(() => new Response(new Uint8Array([1, 2, 3])), urls);

        const provider = new PollinationsImageProvider("sk_key", "klein");
        const result = await provider.generateImage("a red chair", { width: 800, height: 600 });

        expect(result).toBe(Buffer.from([1, 2, 3]).toString("base64"));
        expect(urls).toEqual([
            "https://gen.pollinations.ai/image/a%20red%20chair?width=800&height=600&model=klein&key=sk_key",
        ]);
    });

    test("uses 1792x1024 by default, no key without key, and truncates to 500 chars", async () => {
        const urls: string[] = [];
        respondWith(() => new Response("img"), urls);

        await new PollinationsImageProvider("", "flux").generateImage("x".repeat(501));
        await new PollinationsImageProvider("", "flux").generateImage("y".repeat(500));

        expect(urls[0]).toBe(
            `https://gen.pollinations.ai/image/${"x".repeat(500)}?width=1792&height=1024&model=flux`
        );
        expect(urls[1]).toContain(`/image/${"y".repeat(500)}?`);
    });

    test("returns null and warns when fetch fails", async () => {
        const logs = captureLogs();
        failWith(new Error("network down"));

        expect(await new PollinationsImageProvider("", "flux").generateImage("p")).toBeNull();
        expect(logs.warns).toEqual(["Pollinations image generation failed:"]);
        expect(logs.infos).toEqual([]);
    });

    test("an AbortError that is not an Error is a plain failure", async () => {
        const logs = captureLogs();
        failWith({ name: "AbortError" });

        expect(await new PollinationsImageProvider("", "flux").generateImage("p")).toBeNull();
        expect(logs.warns).toEqual(["Pollinations image generation failed:"]);
    });

    test("returns null with a model hint when the request times out", async () => {
        const logs = captureLogs();
        failWith(Object.assign(new Error("aborted"), { name: "AbortError" }));

        expect(await new PollinationsImageProvider("", "flux").generateImage("p")).toBeNull();
        expect(logs.warns).toEqual(["Pollinations image generation timed out after 2 minutes"]);
        expect(logs.infos).toEqual([
            "TIP: Try a different model with IMAGE_MODEL=klein or IMAGE_MODEL=zimage",
        ]);
        expect(logs.infoCli).toEqual([true]);
    });

    test("the default constructor sends no key and the default model", async () => {
        const urls: string[] = [];
        respondWith(() => new Response("img"), urls);

        await new PollinationsImageProvider().generateImage("p");

        expect(urls[0]).toBe(
            `https://gen.pollinations.ai/image/p?width=1792&height=1024&model=${DEFAULT_POLLINATIONS_IMAGE_MODEL}`
        );
    });

    test("passes an abort signal to fetch", async () => {
        const signals: Array<AbortSignal | null | undefined> = [];
        setFetch(async (_input, init) => {
            signals.push(init?.signal);
            return new Response("img");
        });

        await new PollinationsImageProvider("", "flux").generateImage("p");

        expect(signals[0]).toBeInstanceOf(AbortSignal);
        expect(signals[0]?.aborted).toBe(false);
    });
});

describe("PollinationsImageProvider error responses", () => {
    async function failedImage(
        status: number,
        body: string,
        model = "flux",
        statusText = "Bad"
    ): Promise<LogCapture> {
        const logs = captureLogs();
        respondWith(() => new Response(body, { status, statusText }));
        const result = await new PollinationsImageProvider("", model).generateImage("p");
        expect(result).toBeNull();
        return logs;
    }

    test("shows the status and a model hint when the body is not JSON", async () => {
        const logs = await failedImage(500, "<html>", "klein", "Server Error");

        expect(logs.errors).toEqual(["Pollinations image generation failed: 500 Server Error"]);
        expect(logs.infos).toEqual([
            "TIP: Try a different model with IMAGE_MODEL=flux or IMAGE_MODEL=zimage",
        ]);
        expect(logs.infoCli).toEqual([true]);
    });

    test("JSON bodies that are not objects still show the status header", async () => {
        const text = await failedImage(400, JSON.stringify("just text"));
        expect(text.errors).toEqual(["\n❌ Pollinations image generation failed: 400 Bad"]);
        expect(text.infos).toEqual([""]);

        mock.restore();
        const number = await failedImage(400, "5");
        expect(number.errors).toEqual(["\n❌ Pollinations image generation failed: 400 Bad"]);

        mock.restore();
        const nullBody = await failedImage(400, "null", "klein", "Bad");
        expect(nullBody.errors).toEqual(["Pollinations image generation failed: 400 Bad"]);
    });

    test("nested messages that are empty or not strings keep the outer message", async () => {
        const empty = await failedImage(429, JSON.stringify({ message: '{"message":""}' }));
        expect(empty.errors[1]).toBe('   Error: {"message":""}');
        expect(empty.infos).toEqual(["\n💡 TIP: Rate limited. Wait a moment and try again.", ""]);

        mock.restore();
        const numeric = await failedImage(429, JSON.stringify({ message: '{"message":5}' }));
        expect(numeric.errors[1]).toBe('   Error: {"message":5}');
        expect(numeric.warns).toEqual([]);
        expect(numeric.infos).toEqual(["\n💡 TIP: Rate limited. Wait a moment and try again.", ""]);
    });

    test("402 shows the balance tip", async () => {
        const logs = await failedImage(402, JSON.stringify({ message: "Pay up" }));

        expect(logs.errors).toEqual([
            "\n❌ Pollinations image generation failed: 402 Bad",
            "   Error: Pay up",
        ]);
        expect(logs.infos).toEqual([
            BALANCE_TIP,
            "   Top up your balance at https://enter.pollinations.ai",
            "   Or switch to a secret key (sk_*) which has no balance constraints.",
            "",
        ]);
    });

    test("an insufficient balance message shows the balance tip for any status", async () => {
        const logs = await failedImage(
            401,
            JSON.stringify({ error: { message: "Insufficient balance" } })
        );

        expect(logs.infos[0]).toBe(BALANCE_TIP);
    });

    test("error.message wins over message", async () => {
        const logs = await failedImage(
            400,
            JSON.stringify({ error: { message: "inner" }, message: "outer" })
        );

        expect(logs.errors[1]).toBe("   Error: inner");
    });

    test("falls back to message when error has no message", async () => {
        const logs = await failedImage(400, JSON.stringify({ error: {}, message: "outer" }));

        expect(logs.errors[1]).toBe("   Error: outer");
    });

    test("a nested JSON message is unpacked, invalid nested JSON is kept", async () => {
        const nested = await failedImage(
            400,
            JSON.stringify({ message: JSON.stringify({ message: "deep" }) })
        );
        expect(nested.errors[1]).toBe("   Error: deep");

        mock.restore();
        const emptyNested = await failedImage(400, JSON.stringify({ message: "{}" }));
        expect(emptyNested.errors[1]).toBe("   Error: {}");

        mock.restore();
        const broken = await failedImage(400, JSON.stringify({ message: "{broken" }));
        expect(broken.errors[1]).toBe("   Error: {broken");
    });

    test("no error message means no Error line and no tip", async () => {
        const logs = await failedImage(400, JSON.stringify({}));

        expect(logs.errors).toEqual(["\n❌ Pollinations image generation failed: 400 Bad"]);
        expect(logs.infos).toEqual([""]);
    });

    test("no servers available suggests the other models", async () => {
        const logs = await failedImage(
            401,
            JSON.stringify({ message: "No active flux servers available" }),
            "zimage"
        );

        expect(logs.infos).toEqual([
            '\n💡 TIP: The "zimage" model is currently unavailable.',
            "   Try switching to a different model in your .env file:",
            "   IMAGE_MODEL=flux",
            "   IMAGE_MODEL=klein",
            "",
        ]);
    });

    test("needs both parts of the no servers message", async () => {
        const onlyFirst = await failedImage(503, JSON.stringify({ message: "No active x" }));
        expect(onlyFirst.infos).toEqual([""]);

        mock.restore();
        const onlySecond = await failedImage(503, JSON.stringify({ message: "servers available" }));
        expect(onlySecond.infos).toEqual([""]);
    });

    test("401 and 429 show their tips", async () => {
        const auth = await failedImage(401, JSON.stringify({}));
        expect(auth.infos).toEqual([
            "\n💡 TIP: Authentication failed. Check your API key at https://enter.pollinations.ai",
            "",
        ]);

        mock.restore();
        const rate = await failedImage(429, JSON.stringify({}));
        expect(rate.infos).toEqual(["\n💡 TIP: Rate limited. Wait a moment and try again.", ""]);
    });
});
