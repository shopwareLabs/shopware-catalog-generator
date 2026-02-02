/**
 * Blueprint Tools for MCP Server
 *
 * Exposes blueprint create, hydrate, and fix commands.
 */

import type { ExistingProperty } from "../../utils/index.js";
import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { createCacheFromEnv } from "../../cache.js";
import { BlueprintGenerator, BlueprintHydrator } from "../../generators/index.js";
import { createProvidersFromEnv } from "../../providers/index.js";
import { DataHydrator } from "../../shopware/index.js";
import {
    countCategories,
    logger,
    PropertyCollector,
    validateSubdomainName,
} from "../../utils/index.js";

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
            // Validate name
            const validation = validateSubdomainName(args.name);
            if (!validation.valid) {
                return `Error: Invalid name - ${validation.error}`;
            }
            const salesChannelName = validation.sanitized;
            const description = args.description || `${salesChannelName} webshop`;
            const products = args.products;

            // Create cache
            const cache = createCacheFromEnv();

            // Generate blueprint
            const generator = new BlueprintGenerator({
                totalProducts: products,
                productsPerBranch: Math.ceil(products / 3),
            });

            const blueprint = generator.generateBlueprint(salesChannelName, description);

            // Save to cache
            cache.saveBlueprint(salesChannelName, blueprint);

            const categoryCount = countCategories(blueprint.categories);

            return `Blueprint created successfully!

SalesChannel: ${salesChannelName}
Description: ${description}
Categories: ${categoryCount}
Products: ${blueprint.products.length}
Saved to: generated/sales-channels/${salesChannelName}/blueprint.json

Next step: Run blueprint_hydrate to fill with AI-generated content.`;
        },
    });

    // blueprint_hydrate - Fill blueprint with AI content
    server.addTool({
        name: "blueprint_hydrate",
        description:
            "Hydrate blueprint with AI-generated content (names, descriptions, properties). Requires existing blueprint.json.",
        parameters: z.object({
            name: z.string().describe("SalesChannel name (must have existing blueprint)"),
        }),
        execute: async (args) => {
            // Validate name
            const validation = validateSubdomainName(args.name);
            if (!validation.valid) {
                return `Error: Invalid name - ${validation.error}`;
            }
            const salesChannelName = validation.sanitized;

            // Enable logging
            logger.configure({ verboseConsole: false, minLevel: "info" });

            // Load blueprint
            const cache = createCacheFromEnv();
            const blueprint = cache.loadBlueprint(salesChannelName);

            if (!blueprint) {
                return `Error: No blueprint found for "${salesChannelName}"

Run blueprint_create first:
  blueprint_create(name: "${salesChannelName}", description: "Your store description")`;
            }

            // Create providers
            const { text: textProvider } = createProvidersFromEnv();

            // Get existing properties from Shopware (if connected)
            let existingProperties: ExistingProperty[] = [];
            try {
                const hydrator = new DataHydrator();
                const swEnvUrl = process.env.SW_ENV_URL;
                if (swEnvUrl) {
                    await hydrator.authenticateWithClientCredentials(
                        swEnvUrl,
                        process.env.SW_CLIENT_ID,
                        process.env.SW_CLIENT_SECRET
                    );
                    existingProperties = await hydrator.getExistingPropertyGroups();
                }
            } catch {
                // Proceed without existing properties
            }

            // Hydrate blueprint
            const hydrator = new BlueprintHydrator(textProvider);
            const hydratedBlueprint = await hydrator.hydrate(blueprint, existingProperties);

            // Collect properties
            const collector = new PropertyCollector();
            const propertyGroups = collector.collectFromBlueprint(
                hydratedBlueprint,
                existingProperties
            );
            hydratedBlueprint.propertyGroups = propertyGroups;

            // Save hydrated blueprint
            cache.saveHydratedBlueprint(salesChannelName, hydratedBlueprint);

            return `Blueprint hydrated successfully!

SalesChannel: ${salesChannelName}
Property groups: ${propertyGroups.length}
Manufacturers: ${collector.collectManufacturers(hydratedBlueprint).length}
Saved to: generated/sales-channels/${salesChannelName}/hydrated-blueprint.json

Next step: Run generate to upload to Shopware.`;
        },
    });

    // blueprint_fix - Fix placeholder names
    server.addTool({
        name: "blueprint_fix",
        description:
            "Fix placeholder names in hydrated blueprint. Useful when hydration was incomplete or interrupted.",
        parameters: z.object({
            name: z.string().describe("SalesChannel name (must have existing hydrated blueprint)"),
        }),
        execute: async (args) => {
            // Validate name
            const validation = validateSubdomainName(args.name);
            if (!validation.valid) {
                return `Error: Invalid name - ${validation.error}`;
            }
            const salesChannelName = validation.sanitized;

            // Enable logging
            logger.configure({ verboseConsole: false, minLevel: "info" });

            // Load hydrated blueprint
            const cache = createCacheFromEnv();
            const blueprint = cache.loadHydratedBlueprint(salesChannelName);

            if (!blueprint) {
                return `Error: No hydrated blueprint found for "${salesChannelName}"

Run blueprint_hydrate first:
  blueprint_hydrate(name: "${salesChannelName}")`;
            }

            // Create providers
            const { text: textProvider } = createProvidersFromEnv();

            // Create hydrator and find placeholders
            const hydrator = new BlueprintHydrator(textProvider);
            const placeholderCategories = hydrator.findPlaceholderCategories(blueprint.categories);
            const placeholderProducts = hydrator.findPlaceholderProducts(blueprint.products);

            if (placeholderCategories.length === 0 && placeholderProducts.length === 0) {
                return `No placeholders found. Blueprint is complete.

SalesChannel: ${salesChannelName}
Location: generated/sales-channels/${salesChannelName}/hydrated-blueprint.json`;
            }

            // Fix placeholders
            const fixedBlueprint = await hydrator.fixPlaceholders(blueprint);

            // Update property groups if products were fixed
            if (placeholderProducts.length > 0) {
                const collector = new PropertyCollector();
                const existingProperties: ExistingProperty[] = blueprint.propertyGroups.map(
                    (pg) => ({
                        id: pg.id,
                        name: pg.name,
                        displayType: pg.displayType || "text",
                        options: pg.options.map((o) => ({
                            id: o.id,
                            name: o.name,
                            colorHexCode: o.colorHexCode,
                        })),
                    })
                );
                const propertyGroups = collector.collectFromBlueprint(
                    fixedBlueprint,
                    existingProperties
                );
                fixedBlueprint.propertyGroups = propertyGroups;
            }

            // Save fixed blueprint
            cache.saveHydratedBlueprint(salesChannelName, fixedBlueprint);

            return `Blueprint fixed successfully!

SalesChannel: ${salesChannelName}
Categories fixed: ${placeholderCategories.length}
Products fixed: ${placeholderProducts.length}
Saved to: generated/sales-channels/${salesChannelName}/hydrated-blueprint.json`;
        },
    });
}
