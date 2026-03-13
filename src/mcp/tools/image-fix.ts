/**
 * Image Fix Tool for MCP Server
 *
 * Thin wrapper that delegates to src/services/image-fix-service.ts and returns output.
 */

import type { FastMCP } from "fastmcp";

import { z } from "zod";

import type { HydratedBlueprint } from "../../types/index.js";

import { DataCache, createCacheFromEnv } from "../../cache.js";
import {
    fixCategoryImages,
    fixCmsImages,
    fixProductImages,
    fixThemeImages,
    THEME_MEDIA_KEYS,
} from "../../services/image-fix-service.js";
import { validateSubdomainName } from "../../utils/index.js";

// Re-export for backwards-compatibility (tests may import from here)
export { THEME_MEDIA_KEYS };

export function registerImageFixTools(server: FastMCP): void {
    server.addTool({
        name: "image_fix",
        description:
            "Regenerate images for a product, category, CMS page, or theme media. " +
            "Deletes cached images, regenerates via AI, and uploads to Shopware.",
        parameters: z.object({
            name: z.string().describe("SalesChannel name (must have existing hydrated blueprint)"),
            target: z
                .string()
                .optional()
                .describe(
                    "Target to regenerate: product name/ID, category name/ID, CMS page name, " +
                        'or theme media key (logo, favicon, share, all). Required for all types except theme (defaults to "all")'
                ),
            type: z
                .enum(["product", "category", "cms", "theme"])
                .default("product")
                .describe("Type of image to regenerate"),
            dryRun: z
                .boolean()
                .default(false)
                .describe("If true, only show what would be done without generating or uploading"),
        }),
        execute: async (args) => {
            const validation = validateSubdomainName(args.name);
            if (!validation.valid) {
                return `Error: Invalid name - ${validation.error}`;
            }
            const salesChannelName = validation.sanitized;

            const cache: DataCache = createCacheFromEnv();
            const blueprint: HydratedBlueprint | null =
                cache.loadHydratedBlueprint(salesChannelName);

            if (!blueprint) {
                return `Error: No hydrated blueprint found for "${salesChannelName}"`;
            }

            if (args.type === "theme") {
                const lines = await fixThemeImages(
                    salesChannelName,
                    blueprint,
                    cache,
                    args.target,
                    args.dryRun
                );
                return lines.join("\n");
            }

            if (!args.target) {
                return `Error: --target is required for type "${args.type}"`;
            }

            if (args.type === "product") {
                const lines = await fixProductImages(
                    salesChannelName,
                    blueprint,
                    cache,
                    args.target,
                    args.dryRun
                );
                return lines.join("\n");
            }

            if (args.type === "category") {
                const lines = await fixCategoryImages(
                    salesChannelName,
                    blueprint,
                    cache,
                    args.target,
                    args.dryRun
                );
                return lines.join("\n");
            }

            const lines = await fixCmsImages(
                salesChannelName,
                blueprint,
                cache,
                args.target,
                args.dryRun
            );
            return lines.join("\n");
        },
    });
}
