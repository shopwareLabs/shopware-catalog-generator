/**
 * Generate and Process Tools for MCP Server
 *
 * Thin wrappers that delegate to src/services/generate-service.ts and return output.
 */

import type { FastMCP } from "fastmcp";

import { z } from "zod";

import { registry } from "../../post-processors/index.js";
import {
    generate as generateService,
    runProcessorsForSalesChannel,
} from "../../services/generate-service.js";
import { validateSubdomainName } from "../../utils/index.js";

export function registerGenerateTools(server: FastMCP): void {
    // generate - Full pipeline: create + hydrate + upload
    server.addTool({
        name: "generate",
        description:
            "Full generation pipeline: create blueprint, hydrate with AI, and upload to Shopware. Creates SalesChannel if it doesn't exist.",
        parameters: z.object({
            name: z.string().describe("SalesChannel name (becomes subdomain, e.g., 'furniture')"),
            description: z
                .string()
                .optional()
                .describe("Store description for AI context (default: '{name} webshop')"),
            products: z
                .number()
                .default(90)
                .describe("Number of products to generate (default: 90)"),
            dryRun: z.boolean().default(false).describe("Preview actions without making changes"),
            noTemplate: z
                .boolean()
                .default(false)
                .describe("Skip checking for pre-generated templates"),
        }),
        execute: async (args) => {
            const validation = validateSubdomainName(args.name);
            if (!validation.valid) {
                return `Error: Invalid name - ${validation.error}`;
            }
            const salesChannelName = validation.sanitized;
            const description = args.description || `${salesChannelName} webshop`;

            const lines = await generateService(salesChannelName, description, {
                products: args.products,
                dryRun: args.dryRun,
                noTemplate: args.noTemplate,
            });
            return lines.join("\n");
        },
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

    // process - Run post-processors on existing SalesChannel
    server.addTool({
        name: "process",
        description: `Run post-processors on an existing SalesChannel. Available processors: ${processorNames.join(", ")}. Use to add images, manufacturers, reviews, or variants after initial generation.`,
        parameters: z.object({
            name: z.string().describe("SalesChannel name (must exist in Shopware)"),
            processors: z
                .array(z.enum(processorNames as [string, ...string[]]))
                .optional()
                .describe("List of processors to run. If omitted, runs all processors."),
            dryRun: z.boolean().default(false).describe("Preview actions without making changes"),
        }),
        execute: async (args) => {
            const validation = validateSubdomainName(args.name);
            if (!validation.valid) {
                return `Error: Invalid name - ${validation.error}`;
            }
            const salesChannelName = validation.sanitized;
            const processors = args.processors ?? [];

            const lines = await runProcessorsForSalesChannel(
                salesChannelName,
                processors,
                args.dryRun
            );
            return lines.join("\n");
        },
    });
}
