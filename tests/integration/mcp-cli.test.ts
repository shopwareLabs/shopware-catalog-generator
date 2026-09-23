import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Each call cold-starts both Node and Bun; allow headroom on loaded CI runners.
const CALL_TIMEOUT_MS = 30000;
const TEST_OVERHEAD_MS = 5000;

const serverPath = fileURLToPath(new URL("../../src/mcp/index.ts", import.meta.url));
const cliPath = fileURLToPath(
    new URL("../../node_modules/@wong2/mcp-cli/src/cli.js", import.meta.url)
);
const toolResultSchema = z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});
const blueprintSchema = z.object({
    salesChannel: z.object({ name: z.string(), description: z.string() }),
    categories: z.array(z.object({ id: z.string() })),
    products: z.array(z.object({ id: z.string(), primaryCategoryId: z.string() })),
});

describe("MCP CLI end-to-end", () => {
    let directory: string;
    let configPath: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "catalog-mcp-test-"));
        configPath = join(directory, "mcp.json");
        writeFileSync(
            configPath,
            JSON.stringify({
                mcpServers: {
                    catalog: {
                        command: process.execPath,
                        args: ["run", serverPath],
                        cwd: directory,
                        env: { CACHE_DIR: join(directory, "generated") },
                    },
                },
            })
        );
    });

    afterEach(() => {
        rmSync(directory, { recursive: true, force: true });
    });

    async function callTool(
        name: string,
        args: Record<string, unknown> = {}
    ): Promise<z.infer<typeof toolResultSchema>> {
        const child = Bun.spawn(
            [
                "node",
                cliPath,
                "--config",
                configPath,
                "call-tool",
                `catalog:${name}`,
                "--args",
                JSON.stringify(args),
            ],
            { cwd: directory, stdout: "pipe", stderr: "pipe" }
        );
        const timeout = setTimeout(() => child.kill(), CALL_TIMEOUT_MS);
        try {
            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
            ]);
            if (exitCode !== 0) throw new Error(`MCP CLI exited ${exitCode}: ${stderr}\n${stdout}`);
            // Parsing all stdout also detects accidental logging into the protocol/CLI output.
            return toolResultSchema.parse(JSON.parse(stdout));
        } finally {
            clearTimeout(timeout);
            child.kill();
            await child.exited;
        }
    }

    test(
        "initializes the server and calls a read-only tool through the actual CLI",
        async () => {
            const result = await callTool("list_processors");
            expect(result.isError).not.toBe(true);
            const text = result.content.map((item) => item.text).join("\n");
            for (const name of ["images", "variants", "cms-home", "theme", "reviews"]) {
                expect(text).toContain(name);
            }
        },
        CALL_TIMEOUT_MS + TEST_OVERHEAD_MS
    );

    test(
        "creates and lists a blueprint in an isolated cache",
        async () => {
            const result = await callTool("blueprint_create", {
                name: "mcp-smoke",
                description: "MCP compatibility test",
                products: 3,
            });
            expect(result.isError).not.toBe(true);
            expect(result.content[0]?.text).toContain("Blueprint created");
            const blueprint = blueprintSchema.parse(
                await Bun.file(
                    join(directory, "generated/sales-channels/mcp-smoke/blueprint.json")
                ).json()
            );
            expect(blueprint.salesChannel).toEqual({
                name: "mcp-smoke",
                description: "MCP compatibility test",
            });
            expect(blueprint.products).toHaveLength(3);
            expect(blueprint.categories.length).toBeGreaterThan(0);
            expect(new Set(blueprint.products.map((product) => product.id)).size).toBe(3);

            const cached = await callTool("cache_list");
            expect(cached.isError).not.toBe(true);
            expect(cached.content[0]?.text).toContain("mcp-smoke");
        },
        2 * CALL_TIMEOUT_MS + TEST_OVERHEAD_MS
    );

    test(
        "preserves schema defaults for blueprint creation",
        async () => {
            const result = await callTool("blueprint_create", { name: "default-smoke" });
            expect(result.isError).not.toBe(true);
            const blueprint = blueprintSchema.parse(
                await Bun.file(
                    join(directory, "generated/sales-channels/default-smoke/blueprint.json")
                ).json()
            );
            expect(blueprint.products).toHaveLength(90);
            expect(blueprint.salesChannel.description).toBe("default-smoke webshop");
        },
        CALL_TIMEOUT_MS + TEST_OVERHEAD_MS
    );

    test(
        "rejects invalid tool arguments before execution",
        async () => {
            await expect(
                callTool("blueprint_create", { name: "invalid-smoke", products: "three" })
            ).rejects.toThrow("parameter validation failed: products");
            expect(
                await Bun.file(
                    join(directory, "generated/sales-channels/invalid-smoke/blueprint.json")
                ).exists()
            ).toBe(false);
        },
        CALL_TIMEOUT_MS + TEST_OVERHEAD_MS
    );

    test(
        "preserves the image-fix missing-blueprint response",
        async () => {
            const result = await callTool("image_fix", {
                name: "missing-smoke",
                type: "theme",
                dryRun: true,
            });
            expect(result.content[0]?.text).toContain(
                'No hydrated blueprint found for "missing-smoke"'
            );
        },
        CALL_TIMEOUT_MS + TEST_OVERHEAD_MS
    );
});
