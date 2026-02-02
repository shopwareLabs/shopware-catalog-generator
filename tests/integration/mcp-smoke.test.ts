#!/usr/bin/env bun
/**
 * MCP Server Smoke Test
 *
 * Quick verification that the MCP server starts and responds correctly.
 * Tests the basic initialization flow without requiring full Cursor integration.
 *
 * Usage:
 *   bun test tests/integration/mcp-smoke.test.ts
 */

import { spawn } from "bun";

async function main(): Promise<void> {
    console.log("=== MCP Server Smoke Test ===\n");

    // Start the MCP server
    console.log("Starting MCP server...");
    const proc = spawn(["bun", "run", "src/mcp/index.ts"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });

    // Give it a moment to start
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Send MCP initialization request
    console.log("Sending initialize request...\n");

    const initRequest = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: {
                name: "smoke-test",
                version: "1.0.0",
            },
        },
    });

    // Write to stdin with content-length header (MCP uses JSON-RPC over stdio)
    const header = `Content-Length: ${Buffer.byteLength(initRequest)}\r\n\r\n`;
    proc.stdin.write(header + initRequest);
    proc.stdin.flush();

    // Read response with timeout
    const timeout = 5000;
    const startTime = Date.now();

    let response = "";
    const decoder = new TextDecoder();

    try {
        const reader = proc.stdout.getReader();

        while (Date.now() - startTime < timeout) {
            const readPromise = reader.read();
            const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
                setTimeout(() => resolve({ done: true, value: undefined }), 1000)
            );

            const result = await Promise.race([readPromise, timeoutPromise]);

            if (result.value) {
                response += decoder.decode(result.value);

                // Check if we have a complete response
                if (response.includes('"result"') || response.includes('"error"')) {
                    break;
                }
            }

            if (result.done) break;
        }

        reader.releaseLock();
    } catch (error) {
        console.error("Error reading response:", error);
    }

    // Parse and display response
    if (response) {
        console.log("Raw response:");
        console.log(response);
        console.log();

        // Try to extract JSON from response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                console.log("Parsed response:");
                console.log(JSON.stringify(parsed, null, 2));
                console.log();

                if (parsed.result?.serverInfo) {
                    console.log("✓ Server initialized successfully!");
                    console.log(`  Name: ${parsed.result.serverInfo.name}`);
                    console.log(`  Version: ${parsed.result.serverInfo.version}`);

                    if (parsed.result.capabilities?.tools) {
                        console.log("  Tools capability: enabled");
                    }
                } else if (parsed.error) {
                    console.log("✗ Server returned error:");
                    console.log(`  Code: ${parsed.error.code}`);
                    console.log(`  Message: ${parsed.error.message}`);
                }
            } catch {
                console.log("Could not parse JSON response");
            }
        }
    } else {
        console.log("No response received within timeout");
    }

    // Clean up
    proc.kill();

    // Read any stderr output
    const stderrReader = proc.stderr.getReader();
    const { value: stderrValue } = await stderrReader.read();
    if (stderrValue) {
        const stderr = decoder.decode(stderrValue);
        if (stderr.trim()) {
            console.log("\nStderr output:");
            console.log(stderr);
        }
    }
    stderrReader.releaseLock();

    console.log("\n=== Test Complete ===");
}

main().catch(console.error);
