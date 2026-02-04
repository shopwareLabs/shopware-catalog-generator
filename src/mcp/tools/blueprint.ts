/**
 * Blueprint Tools for MCP Server
 *
 * Exposes blueprint create, hydrate, and fix commands.
 */

import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { createCacheFromEnv } from "../../cache.js";
import { BlueprintGenerator, BlueprintHydrator } from "../../generators/index.js";
import { createProvidersFromEnv } from "../../providers/index.js";
import { DataHydrator } from "../../shopware/index.js";
import type { HydratedBlueprint } from "../../types/index.js";
import type { ExistingProperty } from "../../utils/index.js";
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

            // Products per category can be configured via env (default: 30)
            const maxProductsPerBranch = parseInt(process.env.PRODUCTS_PER_CATEGORY || "30", 10);
            const topLevelCategories = Math.max(1, Math.ceil(products / maxProductsPerBranch));
            // Distribute products evenly across categories
            const productsPerBranch = Math.ceil(products / topLevelCategories);

            // Create cache
            const cache = createCacheFromEnv();

            // Generate blueprint
            const generator = new BlueprintGenerator({
                totalProducts: products,
                topLevelCategories,
                productsPerBranch,
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
            "Hydrate blueprint with AI-generated content. Supports selective modes: 'categories' (update only category names), 'properties' (update only product properties, preserves names for image stability). Use 'force' to re-hydrate everything.",
        parameters: z.object({
            name: z.string().describe("SalesChannel name (must have existing blueprint)"),
            only: z
                .enum(["categories", "properties"])
                .optional()
                .describe(
                    "Selective hydration: 'categories' updates only categories, 'properties' updates only product properties (preserves names)"
                ),
            force: z
                .boolean()
                .default(false)
                .describe(
                    "Force full re-hydration even if hydrated blueprint exists. Warning: changes product names, triggering image regeneration."
                ),
        }),
        execute: async (args) => {
            // Validate name
            const validation = validateSubdomainName(args.name);
            if (!validation.valid) {
                return `Error: Invalid name - ${validation.error}`;
            }
            const salesChannelName = validation.sanitized;

            // Enable logging
            logger.configure({ minLevel: "info" });

            // Load cache
            const cache = createCacheFromEnv();

            // Check if hydrated blueprint exists
            const existingHydratedBlueprint = cache.loadHydratedBlueprint(salesChannelName);

            // Safety check: require --only or --force if hydrated blueprint exists
            if (existingHydratedBlueprint && !args.only && !args.force) {
                return `Error: Hydrated blueprint already exists for "${salesChannelName}"

Re-hydrating will change product names and trigger image regeneration.

Options:
  only: "categories"   Update only category names/descriptions
  only: "properties"   Update only product properties (preserves names)
  force: true          Force full re-hydration (regenerates everything)`;
            }

            // Load base blueprint
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
                const dataHydrator = new DataHydrator();
                const swEnvUrl = process.env.SW_ENV_URL;
                if (swEnvUrl) {
                    await dataHydrator.authenticateWithClientCredentials(
                        swEnvUrl,
                        process.env.SW_CLIENT_ID,
                        process.env.SW_CLIENT_SECRET
                    );
                    existingProperties = await dataHydrator.getExistingPropertyGroups();
                }
            } catch {
                // Proceed without existing properties
            }

            // Create hydrator
            const hydrator = new BlueprintHydrator(textProvider);
            let hydratedBlueprint: HydratedBlueprint;

            // Execute hydration based on mode
            if (args.only === "categories" && existingHydratedBlueprint) {
                hydratedBlueprint = await hydrator.hydrateCategoriesOnly(existingHydratedBlueprint);
            } else if (args.only === "properties" && existingHydratedBlueprint) {
                hydratedBlueprint = await hydrator.hydratePropertiesOnly(
                    existingHydratedBlueprint,
                    existingProperties
                );
            } else {
                hydratedBlueprint = await hydrator.hydrate(blueprint, existingProperties);
            }

            // Collect properties
            const collector = new PropertyCollector();
            const propertyGroups = collector.collectFromBlueprint(
                hydratedBlueprint,
                existingProperties
            );
            hydratedBlueprint.propertyGroups = propertyGroups;

            // Save hydrated blueprint
            cache.saveHydratedBlueprint(salesChannelName, hydratedBlueprint);

            const modeText = args.only || "full";
            return `Blueprint hydrated successfully!

SalesChannel: ${salesChannelName}
Mode: ${modeText}
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
            logger.configure({ minLevel: "info" });

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
