import { describe, expect, test } from "bun:test";

import type { RunGenerate } from "../../../src/services/generate-service.js";

import {
    deriveNameFromUrl,
    handleGenerate,
    parseGenerateBody,
    runGenerateTask,
} from "../../../src/server/generate-route.js";

const CONNECTION = {
    envPath: "http://shop.test",
    shopwareUser: "admin",
    shopwarePassword: "secret",
};

const NO_ENV: Record<string, string | undefined> = {};

function parseOk(body: Record<string, unknown>) {
    const parsed = parseGenerateBody({ ...CONNECTION, ...body }, NO_ENV);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed;
}

describe("deriveNameFromUrl", () => {
    test("uses the first host label without www", () => {
        expect(deriveNameFromUrl("https://www.garden-shop.com/de")).toBe("garden-shop");
        expect(deriveNameFromUrl("https://music.example.org")).toBe("music");
    });

    test("returns null for invalid URLs", () => {
        expect(deriveNameFromUrl("not a url")).toBeNull();
    });
});

describe("parseGenerateBody", () => {
    test("reports every schema issue with its path, or 'body' for the root", () => {
        expect(parseGenerateBody({ envPath: "" }, NO_ENV)).toEqual({
            error:
                "Error: Invalid request - envPath: Too small: expected string to have >=1 characters; " +
                "shopwareUser: Invalid input: expected string, received undefined; " +
                "shopwarePassword: Invalid input: expected string, received undefined",
        });

        const root = parseGenerateBody("nope", NO_ENV);
        expect("error" in root && root.error.startsWith("Error: Invalid request - body: ")).toBe(
            true
        );
    });

    test("reports nested paths joined with dots", () => {
        const parsed = parseGenerateBody({ ...CONNECTION, cache: { clearFirst: "yes" } }, NO_ENV);
        expect("error" in parsed && parsed.error).toContain("cache.clearFirst: ");
    });

    test("builds the request and the server options", () => {
        const parsed = parseOk({
            name: "garden",
            description: "Plants",
            products: 12,
            dryRun: true,
            noTemplate: true,
            languages: "none",
            cache: { clearFirst: true },
            skipProcessors: true,
            inspirationUrl: "https://www.other.com",
        });

        expect(parsed.request.salesChannelName).toBe("garden");
        expect(parsed.request.description).toBe("Plants");
        expect(parsed.request.options.products).toBe(12);
        expect(parsed.request.options.dryRun).toBe(true);
        expect(parsed.request.options.noTemplate).toBe(true);
        expect(parsed.serverOptions).toEqual({
            connection: {
                url: "http://shop.test",
                credentials: { kind: "user", username: "admin", password: "secret" },
            },
            clearCache: true,
            inspirationUrl: "https://www.other.com",
            skipProcessors: true,
        });
    });

    test("server options default to false", () => {
        const { serverOptions } = parseOk({ name: "garden", cache: {} });

        expect(serverOptions.clearCache).toBe(false);
        expect(serverOptions.skipProcessors).toBe(false);
        expect(serverOptions.inspirationUrl).toBeUndefined();
    });

    test("name falls back to salesChannel, then the inspiration host, then demo-store", () => {
        expect(parseOk({ salesChannel: "legacy" }).request.salesChannelName).toBe("legacy");
        expect(parseOk({ name: "", salesChannel: "legacy" }).request.salesChannelName).toBe(
            "legacy"
        );
        expect(
            parseOk({ inspirationUrl: "https://www.plant-world.com" }).request.salesChannelName
        ).toBe("plant-world");
        expect(parseOk({ inspirationUrl: "not a url" }).request.salesChannelName).toBe(
            "demo-store"
        );
        expect(parseOk({}).request.salesChannelName).toBe("demo-store");
        expect(
            parseOk({ name: "first", salesChannel: "second", inspirationUrl: "https://third.com" })
                .request.salesChannelName
        ).toBe("first");
    });

    test("accepts the old aliases productCount and skipTemplate, new names win", () => {
        const legacy = parseOk({ productCount: 7, skipTemplate: true });
        expect(legacy.request.options.products).toBe(7);
        expect(legacy.request.options.noTemplate).toBe(true);

        const both = parseOk({
            products: 3,
            productCount: 7,
            noTemplate: false,
            skipTemplate: true,
        });
        expect(both.request.options.products).toBe(3);
        expect(both.request.options.noTemplate).toBe(false);
    });

    test("returns the error of buildGenerateRequest", () => {
        expect(parseGenerateBody({ ...CONNECTION, productCount: 1.5 }, NO_ENV)).toEqual({
            error: "Error: products must be a positive whole number (got: 1.5)",
        });
    });

    test("uses TRANSLATION_LANGUAGES from the given env", () => {
        const parsed = parseGenerateBody(
            { ...CONNECTION, name: "garden" },
            { TRANSLATION_LANGUAGES: "bogus!" }
        );
        expect("error" in parsed && parsed.error).toContain("TRANSLATION_LANGUAGES");
    });
});

describe("runGenerateTask", () => {
    const ctx = { log: () => {}, setProgress: () => {} };

    test("returns the summary with the error lines", async () => {
        const run: RunGenerate = async () => ({
            lines: ["ok", "Error: image failed"],
            summary: {
                salesChannelId: "sc",
                salesChannelName: "garden",
                categories: 1,
                products: 2,
                failedProducts: 0,
                propertyGroups: 0,
                processors: [],
            },
        });

        const result = await runGenerateTask(parseOk({ name: "garden" }), ctx, run);

        expect(result).toMatchObject({
            salesChannelName: "garden",
            errors: ["Error: image failed"],
        });
    });

    test("passes the request, server options and hooks to runGenerate", async () => {
        const calls: Array<{ name: string; options: Record<string, unknown> }> = [];
        const run: RunGenerate = async (name, _description, options) => {
            calls.push({ name, options: { ...options } });
            return { lines: [] };
        };

        await runGenerateTask(
            parseOk({ name: "garden", cache: { clearFirst: true } }),
            ctx,
            run
        ).catch(() => {});

        expect(calls[0]?.name).toBe("garden");
        expect(calls[0]?.options.clearCache).toBe(true);
        expect(calls[0]?.options.hooks).toEqual({
            onLine: ctx.log,
            onProgress: ctx.setProgress,
        });
    });

    test("fails with the first error line when there is no summary", async () => {
        const run: RunGenerate = async () => ({ lines: ["Error: auth failed", "Error: later"] });

        await expect(runGenerateTask(parseOk({ name: "garden" }), ctx, run)).rejects.toThrow(
            /^auth failed$/
        );
    });

    test("fails with a generic message without summary and error lines", async () => {
        const run: RunGenerate = async () => ({ lines: ["done?"] });

        await expect(runGenerateTask(parseOk({ name: "garden" }), ctx, run)).rejects.toThrow(
            "Generation did not finish"
        );
    });
});

describe("handleGenerate", () => {
    test("returns 400 without the Error: prefix for invalid bodies", async () => {
        const response = await handleGenerate(
            new Request("http://localhost/generate", { method: "POST", body: "{broken" }),
            { runGenerate: async () => ({ lines: [] }), processManager: { start: () => "x" } }
        );

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
            error: expect.stringMatching(/^Invalid request - /),
        });
    });

    test("starts a named process and returns its status URL", async () => {
        const names: string[] = [];
        const response = await handleGenerate(
            new Request("http://localhost/generate", {
                method: "POST",
                body: JSON.stringify({ ...CONNECTION, name: "garden", languages: "none" }),
            }),
            {
                runGenerate: async () => ({ lines: [] }),
                processManager: {
                    start: (name) => {
                        names.push(name);
                        return "proc_1";
                    },
                },
            }
        );

        expect(names).toEqual(["Generate garden"]);
        expect(await response.json()).toEqual({
            processId: "proc_1",
            message: "Generation started in background",
            salesChannel: "garden",
            statusUrl: "/status/proc_1",
        });
    });
});
