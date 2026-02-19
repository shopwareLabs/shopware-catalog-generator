/**
 * MCP Server Smoke Test
 *
 * Quick verification that the MCP server starts and responds correctly.
 * Tests the basic initialization flow without requiring full Cursor integration.
 *
 * Usage:
 *   bun test tests/integration/mcp-smoke.test.ts
 *   MCP_SMOKE_VERBOSE=1 bun test tests/integration/mcp-smoke.test.ts  # show full output
 */

import { spawn } from "bun";
import { describe, expect, test } from "bun:test";

const VERBOSE = process.env.MCP_SMOKE_VERBOSE === "1";

async function runMcpSmokeTest(): Promise<{
    ok: boolean;
    response: string;
    stderr: string;
    error?: string;
}> {
    const proc = spawn(["bun", "run", "src/mcp/index.ts"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const initRequest = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "smoke-test", version: "1.0.0" },
        },
    });

    proc.stdin.write(`${initRequest}\n`);
    proc.stdin.flush();

    const timeout = 10000;
    const startTime = Date.now();
    let response = "";
    const decoder = new TextDecoder();

    try {
        const reader = proc.stdout.getReader();
        while (Date.now() - startTime < timeout) {
            const readPromise = reader.read();
            const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
                setTimeout(() => resolve({ done: true, value: undefined }), 3000)
            );
            const result = await Promise.race([readPromise, timeoutPromise]);
            if (result.value) {
                response += decoder.decode(result.value);
                if (response.includes('"result"') || response.includes('"error"')) break;
            }
            if (result.done) break;
        }
        reader.releaseLock();
    } catch (error) {
        proc.kill();
        return {
            ok: false,
            response,
            stderr: "",
            error: error instanceof Error ? error.message : String(error),
        };
    }

    proc.kill();

    let stderr = "";
    const stderrReader = proc.stderr.getReader();
    const { value: stderrValue } = await stderrReader.read();
    if (stderrValue) stderr = decoder.decode(stderrValue);
    stderrReader.releaseLock();

    return { ok: !!response, response, stderr };
}

describe("MCP Server Smoke Test", () => {
    test("server starts and responds to initialize", async () => {
        const { ok, response, stderr, error } = await runMcpSmokeTest();

        if (!ok || !response) {
            if (VERBOSE || process.env.CI) {
                console.error("MCP smoke test failed.");
                if (error) console.error("Error:", error);
                if (response) console.error("Response:", response);
                if (stderr) console.error("Stderr:", stderr);
            }
            expect(response).toBeTruthy();
        }

        const jsonMatch = response.match(/\{[\s\S]*\}/);
        expect(jsonMatch).toBeTruthy();

        const jsonStr = jsonMatch?.[0];
        if (jsonStr === undefined) throw new Error("Expected JSON body in response");
        const parsed = JSON.parse(jsonStr);
        expect(parsed.result?.serverInfo).toBeDefined();
        expect(parsed.result.serverInfo.name).toBe("catalog-generator");
        expect(parsed.result.serverInfo.version).toBe("1.0.0");
        expect(parsed.result.capabilities?.tools).toBeDefined();
    });
});
