/**
 * Blueprint Tools for MCP Server
 *
 * Thin wrappers that delegate to src/services/blueprint-service.ts and return output.
 */

import type { FastMCP } from "fastmcp";

import { z } from "zod";

import {
    createBlueprint,
    fixBlueprint,
    hydrateBlueprint,
} from "../../services/blueprint-service.js";
import { validateSubdomainName } from "../../utils/index.js";

export function registerBlueprintTools(server: FastMCP): void {
    // blueprint_create - Generate blueprint.json (no AI)
    server.addTool({
        name: "blueprint_create",
        description:
            "Generate blueprint.json structure without AI calls. Creates the category tree and product placeholders.",
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
        }),
        execute: async (args) => {
            const validation = validateSubdomainName(args.name);
            if (!validation.valid) {
                return `Error: Invalid name - ${validation.error}`;
            }
            const salesChannelName = validation.sanitized;
            const description = args.description || `${salesChannelName} webshop`;

            const lines = await createBlueprint(salesChannelName, description, args.products);
            return lines.join("\n");
        },
    });

    // blueprint_hydrate - Fill blueprint with AI content
    server.addTool({
        name: "blueprint_hydrate",
        description:
            "Fill blueprint with AI-generated content (product/category names, descriptions, properties). " +
            "Supports selective hydration with --only and full re-hydration with --rehydrate.",
        parameters: z.object({
            name: z.string().describe("SalesChannel name"),
            only: z
                .enum(["categories", "properties", "cms"])
                .optional()
                .describe(
                    "Selectively hydrate only this part (categories, properties, or cms). " +
                        "Preserves existing product names (important for image stability)."
                ),
            rehydrate: z
                .boolean()
                .default(false)
                .describe(
                    "Force full re-hydration even if hydrated blueprint exists. " +
                        "WARNING: changes product names and triggers image regeneration."
                ),
        }),
        execute: async (args) => {
            const validation = validateSubdomainName(args.name);
            if (!validation.valid) {
                return `Error: Invalid name - ${validation.error}`;
            }
            const salesChannelName = validation.sanitized;

            const lines = await hydrateBlueprint(salesChannelName, {
                only: args.only,
                force: args.rehydrate,
            });
            return lines.join("\n");
        },
    });

    // blueprint_fix - Fix placeholder names
    server.addTool({
        name: "blueprint_fix",
        description:
            "Fix placeholder names in hydrated blueprint. " +
            "Regenerates AI content for products/categories that still have placeholder names " +
            "(e.g., 'Product 1', 'Top Category 1').",
        parameters: z.object({
            name: z.string().describe("SalesChannel name"),
        }),
        execute: async (args) => {
            const validation = validateSubdomainName(args.name);
            if (!validation.valid) {
                return `Error: Invalid name - ${validation.error}`;
            }
            const salesChannelName = validation.sanitized;

            const lines = await fixBlueprint(salesChannelName);
            return lines.join("\n");
        },
    });
}
