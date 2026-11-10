/**
 * Generate and Process Tools for MCP Server
 *
 * Thin wrappers that delegate to src/services/generate-service.ts and return output.
 */

import type { FastMCP } from "fastmcp";

import { z } from "zod";

import type { GenerateParams } from "../../services/generate-request.js";
import type { RunGenerate } from "../../services/generate-service.js";

import { registry } from "../../post-processors/index.js";
import { PROCESS } from "../../services/commands.js";
import {
    buildGenerateRequest,
    generateInputFromParams,
    generateRequestParams,
} from "../../services/generate-request.js";
import { runGenerate } from "../../services/generate-service.js";
import { registerCommandTool } from "./command-tool.js";

/** The generate tool (exported so the parity test runs the same code as the MCP server) */
export async function executeGenerateTool(
    args: GenerateParams,
    run: RunGenerate = runGenerate
): Promise<string> {
    const built = buildGenerateRequest(generateInputFromParams(args));
    if ("error" in built) return built.error;
    const { salesChannelName, description, options } = built.request;
    const { lines } = await run(salesChannelName, description, options);
    return lines.join("\n");
}

export function registerGenerateTools(server: FastMCP): void {
    // generate - Full pipeline: create + hydrate + upload
    server.addTool({
        name: "generate",
        description:
            "Full generation pipeline: create blueprint, hydrate with AI, and upload to Shopware. Creates SalesChannel if it doesn't exist.",
        parameters: z.object(generateRequestParams),
        execute: (args) => executeGenerateTool(args),
    });

    // Get processor names for enum
    const processorNames = registry.getNames();

    // list_processors - Show available post-processors
    server.addTool({
        name: "list_processors",
        description: "List all available post-processors with their descriptions.",
        parameters: z.object({}),
        execute: async () => {
            const results: string[] = [];
            results.push("Available Post-Processors:");
            results.push("");

            for (const name of processorNames) {
                const processor = registry.get(name);
                if (processor) {
                    results.push(`  ${name}`);
                    results.push(`    ${processor.description}`);
                    if (processor.dependsOn.length > 0) {
                        results.push(`    Depends on: ${processor.dependsOn.join(", ")}`);
                    }
                    results.push("");
                }
            }

            results.push("Usage:");
            results.push("  process(name: 'store-name', processors: ['images', 'reviews'])");

            return results.join("\n");
        },
    });

    // process - Run post-processors on existing SalesChannel (shared command spec)
    registerCommandTool(server, PROCESS);
}
