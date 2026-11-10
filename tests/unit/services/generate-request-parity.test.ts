/**
 * Parity: CLI, MCP and HTTP server must call the generate service the same way.
 *
 * Each case is written once per surface (CLI flags, MCP arguments, server body) and run
 * through the real entry point of that surface with a recording runGenerate. A new generate
 * option only needs a case here: if one surface forgets to pass it on, this test fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import type {
    GenerateOptions,
    GenerateRun,
    RunGenerate,
} from "../../../src/services/generate-service.js";

import { resolveVariantSettings } from "../../../src/blueprint/index.js";
import { generate as cliGenerate } from "../../../src/cli/generate.js";
import { parseCliArgs } from "../../../src/main.js";
import { executeGenerateTool } from "../../../src/mcp/tools/generate.js";
import { handleGenerate } from "../../../src/server/generate-route.js";
import { ProcessManager } from "../../../src/server/process-manager.js";
import { generateRequestParams } from "../../../src/services/generate-request.js";

interface RecordedCall {
    name: string;
    description: string | undefined;
    options: GenerateOptions;
}

interface SurfaceCase {
    label: string;
    cli: string[];
    mcp: Record<string, unknown>;
    server: Record<string, unknown>;
}

const StartedSchema = z.object({ processId: z.string() });

const SERVER_CONNECTION = {
    envPath: "http://shop.test",
    shopwareUser: "admin",
    shopwarePassword: "secret",
};

function recorder(calls: RecordedCall[]): RunGenerate {
    return async (name, description, options = {}): Promise<GenerateRun> => {
        calls.push({ name, description, options });
        return {
            lines: ["✓ done"],
            summary: {
                salesChannelId: "sc-1",
                salesChannelName: name,
                categories: 0,
                products: 0,
                failedProducts: 0,
                propertyGroups: 0,
                processors: [],
            },
        };
    };
}

function parseArgv(argv: string[]): ReturnType<typeof parseCliArgs> {
    const orig = process.argv;
    process.argv = ["bun", "src/main.ts", "generate", ...argv];
    try {
        return parseCliArgs();
    } finally {
        process.argv = orig;
    }
}

async function viaCli(argv: string[]): Promise<RecordedCall[]> {
    const calls: RecordedCall[] = [];
    const log = console.log;
    console.log = () => {};
    try {
        await cliGenerate(parseArgv(argv), {
            runGenerate: recorder(calls),
            verifyConnection: async () => "http://shop.test",
        });
    } finally {
        console.log = log;
    }
    return calls;
}

async function viaMcp(args: Record<string, unknown>): Promise<RecordedCall[]> {
    const calls: RecordedCall[] = [];
    // The MCP server validates the arguments with the tool schema before execute()
    await executeGenerateTool(z.object(generateRequestParams).parse(args), recorder(calls));
    return calls;
}

async function waitForProcess(manager: ProcessManager, id: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
        const status = manager.get(id)?.status;
        if (status === "completed" || status === "failed") return;
        await Bun.sleep(5);
    }
    throw new Error(`Process ${id} did not finish`);
}

async function viaServer(body: Record<string, unknown>): Promise<{
    calls: RecordedCall[];
    response: Response;
    manager: ProcessManager;
}> {
    const calls: RecordedCall[] = [];
    const manager = new ProcessManager();
    const response = await handleGenerate(
        new Request("http://localhost/generate", {
            method: "POST",
            body: JSON.stringify({ ...SERVER_CONNECTION, ...body }),
        }),
        { runGenerate: recorder(calls), processManager: manager }
    );
    if (response.ok) {
        const { processId } = StartedSchema.parse(await response.clone().json());
        await waitForProcess(manager, processId);
    }
    return { calls, response, manager };
}

/** The part of a call every surface must agree on (server-only options left out) */
function shared(call: RecordedCall | undefined): unknown {
    if (!call) return undefined;
    // Rest spread on purpose: a new shared option is compared without touching this test
    const {
        variants,
        connection: _connection,
        hooks: _hooks,
        clearCache: _clearCache,
        inspirationUrl: _inspirationUrl,
        skipProcessors: _skipProcessors,
        ...rest
    } = call.options;
    return {
        name: call.name,
        description: call.description,
        ...rest,
        // CLI passes raw flag strings, MCP and server pass numbers: compare the resolved settings
        variants: resolveVariantSettings(variants, {}),
    };
}

const CASES: SurfaceCase[] = [
    {
        label: "name only (defaults)",
        cli: ["--name=garden"],
        mcp: { name: "garden" },
        server: { name: "garden" },
    },
    {
        label: "every shared option",
        cli: [
            "--name=garden",
            "--description=Plants and tools",
            "--products=12",
            "--dry-run",
            "--no-template",
            "--languages=de-DE,fr-FR",
            "--variant-colors=6",
            "--variant-options=2",
            "--max-variants=30",
            "--variant-share=0.5",
        ],
        mcp: {
            name: "garden",
            description: "Plants and tools",
            products: 12,
            dryRun: true,
            noTemplate: true,
            languages: "de-DE,fr-FR",
            variantColors: 6,
            variantOptions: 2,
            maxVariants: 30,
            variantShare: 0.5,
        },
        server: {
            name: "garden",
            description: "Plants and tools",
            products: 12,
            dryRun: true,
            noTemplate: true,
            languages: "de-DE,fr-FR",
            variantColors: 6,
            variantOptions: 2,
            maxVariants: 30,
            variantShare: 0.5,
        },
    },
    {
        label: "languages none",
        cli: ["--name=garden", "--languages=none"],
        mcp: { name: "garden", languages: "none" },
        server: { name: "garden", languages: "none" },
    },
    {
        label: "name is sanitized the same way",
        cli: ["--name=Garden-Shop"],
        mcp: { name: "Garden-Shop" },
        server: { name: "Garden-Shop" },
    },
];

describe("generate parity: CLI, MCP and server", () => {
    let savedLanguages: string | undefined;

    beforeEach(() => {
        savedLanguages = process.env.TRANSLATION_LANGUAGES;
        delete process.env.TRANSLATION_LANGUAGES;
    });

    afterEach(() => {
        if (savedLanguages === undefined) delete process.env.TRANSLATION_LANGUAGES;
        else process.env.TRANSLATION_LANGUAGES = savedLanguages;
    });

    for (const c of CASES) {
        test(c.label, async () => {
            const cli = await viaCli(c.cli);
            const mcp = await viaMcp(c.mcp);
            const server = await viaServer(c.server);

            expect(cli).toHaveLength(1);
            expect(mcp).toHaveLength(1);
            expect(server.calls).toHaveLength(1);
            expect(shared(mcp[0])).toEqual(shared(cli[0]));
            expect(shared(server.calls[0])).toEqual(shared(cli[0]));
        });
    }

    test("TRANSLATION_LANGUAGES is the default on every surface", async () => {
        process.env.TRANSLATION_LANGUAGES = "de-DE";

        const cli = await viaCli(["--name=garden"]);
        const mcp = await viaMcp({ name: "garden" });
        const server = await viaServer({ name: "garden" });

        expect(cli[0]?.options.languages).toBeDefined();
        expect(shared(mcp[0])).toEqual(shared(cli[0]));
        expect(shared(server.calls[0])).toEqual(shared(cli[0]));
    });

    test("invalid languages are rejected with the same message and no service call", async () => {
        const cliError = await viaCli(["--name=garden", "--languages=xx_invalid"]).then(
            () => "no error",
            (error: unknown) => (error instanceof Error ? error.message : String(error))
        );
        const mcpCalls: RecordedCall[] = [];
        const mcpOutput = await executeGenerateTool(
            { name: "garden", languages: "xx_invalid" },
            recorder(mcpCalls)
        );
        const server = await viaServer({ name: "garden", languages: "xx_invalid" });
        const serverBody = z.object({ error: z.string() }).parse(await server.response.json());

        expect(mcpCalls).toHaveLength(0);
        expect(server.calls).toHaveLength(0);
        expect(server.response.status).toBe(400);
        expect(mcpOutput).toBe(`Error: ${cliError}`);
        expect(serverBody.error).toBe(cliError);
    });
});

describe("server generate route", () => {
    test("passes the admin user connection and server-only options", async () => {
        const { calls } = await viaServer({
            name: "garden",
            cache: { clearFirst: true },
            skipProcessors: true,
            inspirationUrl: "https://example.com",
        });

        expect(calls[0]?.options.connection).toEqual({
            url: "http://shop.test",
            credentials: { kind: "user", username: "admin", password: "secret" },
        });
        expect(calls[0]?.options.clearCache).toBe(true);
        expect(calls[0]?.options.skipProcessors).toBe(true);
        expect(calls[0]?.options.inspirationUrl).toBe("https://example.com");
    });

    test("accepts the older field names salesChannel, productCount and skipTemplate", async () => {
        const { calls } = await viaServer({
            salesChannel: "garden",
            productCount: 12,
            skipTemplate: true,
        });

        expect(calls[0]?.name).toBe("garden");
        expect(calls[0]?.options.products).toBe(12);
        expect(calls[0]?.options.noTemplate).toBe(true);
    });

    test("derives the name from the inspiration URL, else demo-store", async () => {
        const fromUrl = await viaServer({ inspirationUrl: "https://www.plantshop.com/" });
        const fallback = await viaServer({});

        expect(fromUrl.calls[0]?.name).toBe("plantshop");
        expect(fallback.calls[0]?.name).toBe("demo-store");
    });

    test("rejects a body without Shopware credentials", async () => {
        const calls: RecordedCall[] = [];
        const response = await handleGenerate(
            new Request("http://localhost/generate", {
                method: "POST",
                body: JSON.stringify({ name: "garden", envPath: "http://shop.test" }),
            }),
            { runGenerate: recorder(calls), processManager: new ProcessManager() }
        );

        expect(response.status).toBe(400);
        expect(calls).toHaveLength(0);
    });

    test("forwards service lines and progress to the process and fails without a summary", async () => {
        const manager = new ProcessManager();
        const failing: RunGenerate = async (_name, _description, options = {}) => {
            options.hooks?.onLine?.("Creating blueprint...");
            options.hooks?.onProgress?.("blueprint", 1, 2);
            return {
                lines: ["Creating blueprint...", "Error: Authentication with Shopware failed"],
            };
        };
        const response = await handleGenerate(
            new Request("http://localhost/generate", {
                method: "POST",
                body: JSON.stringify({ ...SERVER_CONNECTION, name: "garden" }),
            }),
            { runGenerate: failing, processManager: manager }
        );
        const { processId } = StartedSchema.parse(await response.json());
        await waitForProcess(manager, processId);
        const state = manager.get(processId);

        expect(state?.status).toBe("failed");
        expect(state?.error).toBe("Authentication with Shopware failed");
        expect(state?.logs.some((l) => l.includes("Creating blueprint..."))).toBe(true);
        expect(state?.progress).toEqual({ phase: "blueprint", current: 1, total: 2 });
    });
});
