/**
 * Blueprint Tools for MCP Server
 *
 * Thin wrappers that delegate to src/services/blueprint-service.ts and return output.
 */

import type { FastMCP } from "fastmcp";

import { z } from "zod";

import {
    createBlueprint,
    estimateBlueprintCost,
    fixBlueprint,
    hydrateBlueprint,
    inspireBlueprint,
} from "../../services/blueprint-service.js";
import {
    estimateTranslation,
    translateBlueprint,
    tryParseLanguageSelection,
} from "../../services/translation-service.js";
import { validateSubdomainName } from "../../utils/index.js";

const LANGUAGES_DESCRIPTION =
    `Languages: "all" (SalesChannel languages, de-DE for a new SalesChannel), "none", ` +
    `or comma-separated locale codes like "de-DE,fr-FR"`;

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

    // blueprint_estimate - Forecast hydration cost (no AI calls)
    server.addTool({
        name: "blueprint_estimate",
        description:
            "Forecast AI calls, tokens, images and USD cost of blueprint_hydrate without calling any AI. " +
            "Uses the configured providers/models (AI_PROVIDER, AI_MODEL, IMAGE_MODEL, IMAGE_QUALITY).",
        parameters: z.object({
            name: z.string().describe("SalesChannel name"),
            only: z
                .enum(["categories", "properties", "cms"])
                .optional()
                .describe("Estimate a selective hydration (categories, properties, or cms)"),
            languages: z
                .string()
                .optional()
                .describe(`Also forecast translation. ${LANGUAGES_DESCRIPTION}`),
        }),
        execute: async (args) => {
            const validation = validateSubdomainName(args.name);
            if (!validation.valid) {
                return `Error: Invalid name - ${validation.error}`;
            }
            const languages = tryParseLanguageSelection(args.languages);
            if (languages.error) return languages.error;

            const lines = estimateBlueprintCost(validation.sanitized, { only: args.only });
            const translation = languages.selection
                ? ["", ...(await estimateTranslation(validation.sanitized, languages.selection))]
                : [];
            return [...lines, ...translation].join("\n");
        },
    });

    // blueprint_translate - Translate the hydrated catalog (AI)
    server.addTool({
        name: "blueprint_translate",
        description:
            "Translate the hydrated catalog (products, categories, properties, reviews, CMS texts) into " +
            "other languages with AI, written like a native shop instead of a 1:1 translation. " +
            "Saves translations/{locale}.json, uploaded by generate/process (translations, reviews). " +
            "Unchanged texts from earlier runs are reused. Use blueprint_estimate with languages for the cost.",
        parameters: z.object({
            name: z.string().describe("SalesChannel name"),
            languages: z.string().default("all").describe(LANGUAGES_DESCRIPTION),
            formality: z
                .enum(["formal", "informal"])
                .optional()
                .describe("Form of address (default: the AI decides per language and store)"),
            force: z
                .boolean()
                .default(false)
                .describe("Translate everything again instead of reusing unchanged entries"),
        }),
        execute: async (args) => {
            const validation = validateSubdomainName(args.name);
            if (!validation.valid) {
                return `Error: Invalid name - ${validation.error}`;
            }
            const languages = tryParseLanguageSelection(args.languages);
            if (languages.error) return languages.error;

            const lines = await translateBlueprint(validation.sanitized, {
                languages: languages.selection ?? { mode: "all" },
                formality: args.formality,
                force: args.force,
            });
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

    // blueprint_inspire - Crawl a website and save inspiration to guide AI generation
    server.addTool({
        name: "blueprint_inspire",
        description:
            "Crawl an existing website to extract category names, example products, and brand colors. " +
            "Saves inspiration.json which is automatically used by blueprint_hydrate to guide AI generation " +
            "so the result feels like it could be the customer's actual store.",
        parameters: z.object({
            name: z.string().describe("SalesChannel name (becomes subdomain, e.g., 'furniture')"),
            url: z.string().url().describe("URL of the website to crawl for inspiration"),
        }),
        execute: async (args) => {
            const validation = validateSubdomainName(args.name);
            if (!validation.valid) {
                return `Error: Invalid name - ${validation.error}`;
            }
            const salesChannelName = validation.sanitized;

            const lines = await inspireBlueprint(args.url, salesChannelName);
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
