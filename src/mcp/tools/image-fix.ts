/**
 * Image Fix Tool for MCP Server
 *
 * Regenerates product images when they are missing, broken, or need updating.
 */

import type { FastMCP } from "fastmcp";

import { z } from "zod";

import { createCacheFromEnv } from "../../cache.js";
import { DEFAULT_PROCESSOR_OPTIONS, runProcessors } from "../../post-processors/index.js";
import { createProvidersFromEnv } from "../../providers/index.js";
import { createApiHelpers, createShopwareAdminClient, DataHydrator } from "../../shopware/index.js";
import { validateSubdomainName } from "../../utils/index.js";

export function registerImageFixTools(server: FastMCP): void {
    server.addTool({
        name: "image_fix",
        description:
            "Regenerate images for a specific product. Useful when product images are missing, broken, or need to be updated. Generates new images and uploads them to Shopware.",
        parameters: z.object({
            name: z.string().describe("SalesChannel name (must have existing hydrated blueprint)"),
            product: z
                .string()
                .describe("Product name (partial match) or product ID to regenerate images for"),
            dryRun: z
                .boolean()
                .default(false)
                .describe(
                    "If true, only show what would be done without generating or uploading images"
                ),
        }),
        execute: async (args) => {
            // Validate name
            const validation = validateSubdomainName(args.name);
            if (!validation.valid) {
                return `Error: Invalid name - ${validation.error}`;
            }
            const salesChannelName = validation.sanitized;

            const cache = createCacheFromEnv();
            const blueprint = cache.loadHydratedBlueprint(salesChannelName);

            if (!blueprint) {
                return `Error: No hydrated blueprint found for "${salesChannelName}"

Run generate first:
  generate(name: "${salesChannelName}", description: "Your store description")`;
            }

            // Find the product in blueprint (by name or ID)
            const searchTerm = args.product.toLowerCase();
            const product = blueprint.products.find(
                (p) => p.id === args.product || p.name.toLowerCase().includes(searchTerm)
            );

            if (!product) {
                const availableProducts = blueprint.products
                    .slice(0, 5)
                    .map((p) => `  - ${p.name}`)
                    .join("\n");
                return `Error: Product "${args.product}" not found in blueprint

Available products (first 5):
${availableProducts}`;
            }

            const imageDescriptions = product.metadata.imageDescriptions;
            if (imageDescriptions.length === 0) {
                return `Error: Product "${product.name}" has no image descriptions in metadata`;
            }

            const results: string[] = [];
            results.push(`=== Image Fix ===`);
            results.push(`SalesChannel: ${salesChannelName}`);
            results.push(`Product: ${product.name} (${product.id})`);
            results.push(`Images to generate: ${imageDescriptions.length}`);
            for (const desc of imageDescriptions) {
                results.push(`  - ${desc.view}: ${desc.prompt.substring(0, 50)}...`);
            }
            results.push(``);

            if (args.dryRun) {
                results.push(
                    `[DRY RUN] Would generate and upload ${imageDescriptions.length} images`
                );
                return results.join("\n");
            }

            // Generate images
            const { image: imageProvider } = createProvidersFromEnv();

            for (const desc of imageDescriptions) {
                results.push(`Generating ${desc.view} image...`);

                // Delete existing cached image if any
                cache.images.deleteImageWithView(
                    salesChannelName,
                    product.id,
                    desc.view,
                    "product_media"
                );

                const imageData = await imageProvider.generateImage(desc.prompt);
                if (!imageData) {
                    results.push(`  ✗ Failed to generate ${desc.view} image`);
                    continue;
                }

                cache.images.saveImageWithView(
                    salesChannelName,
                    product.id,
                    desc.view,
                    imageData,
                    desc.prompt,
                    undefined,
                    "product_media"
                );
                results.push(`  ✓ Generated and cached ${desc.view} image`);
            }

            // Upload to Shopware
            results.push(``);
            results.push(`Uploading to Shopware...`);

            const swEnvUrl = process.env.SW_ENV_URL;
            if (!swEnvUrl) {
                return results.join("\n") + "\n\nError: SW_ENV_URL is required for upload";
            }

            const dataHydrator = new DataHydrator();
            await dataHydrator.authenticateWithClientCredentials(
                swEnvUrl,
                process.env.SW_CLIENT_ID,
                process.env.SW_CLIENT_SECRET
            );

            const salesChannel = await dataHydrator.findSalesChannelByName(salesChannelName);
            if (!salesChannel) {
                return (
                    results.join("\n") +
                    `\n\nError: SalesChannel "${salesChannelName}" not found in Shopware`
                );
            }

            // Create API helpers
            const adminClient = createShopwareAdminClient({
                baseURL: swEnvUrl,
                clientId: process.env.SW_CLIENT_ID,
                clientSecret: process.env.SW_CLIENT_SECRET,
            });
            const apiHelpers = createApiHelpers(adminClient, swEnvUrl, () =>
                dataHydrator.getAccessToken()
            );

            const { text: textProvider, image: localImageProvider } = createProvidersFromEnv();

            // Create a filtered blueprint with just this product
            const filteredBlueprint = {
                ...blueprint,
                products: [product],
            };

            // Run only the image processor
            const processorResults = await runProcessors(
                {
                    salesChannelId: salesChannel.id,
                    salesChannelName,
                    blueprint: filteredBlueprint,
                    cache,
                    textProvider,
                    imageProvider: localImageProvider,
                    shopwareUrl: swEnvUrl,
                    getAccessToken: () => dataHydrator.getAccessToken(),
                    api: apiHelpers,
                    options: {
                        ...DEFAULT_PROCESSOR_OPTIONS,
                        dryRun: false,
                    },
                },
                ["images"]
            );

            let totalProcessed = 0;
            let totalErrors = 0;
            for (const result of processorResults) {
                totalProcessed += result.processed;
                totalErrors += result.errors.length;
            }

            results.push(`  Uploaded: ${totalProcessed}, Errors: ${totalErrors}`);
            results.push(``);
            results.push(`=== Image Fix Complete ===`);

            return results.join("\n");
        },
    });
}
