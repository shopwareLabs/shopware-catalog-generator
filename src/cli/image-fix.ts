/**
 * Image fix CLI command: regenerate images for products, categories, CMS pages, or theme media.
 *
 * Thin wrapper that delegates to src/services/image-fix-service.ts and prints output.
 */

import type { CliArgs } from "./shared.js";

import { createCacheFromEnv } from "../cache.js";
import {
    fixCategoryImages,
    fixCmsImages,
    fixProductImages,
    fixThemeImages,
} from "../services/image-fix-service.js";
import { CLIError, requireHydratedBlueprint, requireValidName } from "./shared.js";

type ImageFixType = "product" | "category" | "cms" | "theme";

export async function imageFixCommand(args: CliArgs): Promise<void> {
    const salesChannelName = requireValidName(args);
    const fixType = (args.type as ImageFixType) || "product";

    if (!["product", "category", "cms", "theme"].includes(fixType)) {
        throw new CLIError(
            `--type must be 'product', 'category', 'cms', or 'theme' (got: ${fixType})`,
            "INVALID_OPTION"
        );
    }

    const cache = createCacheFromEnv();
    const blueprint = requireHydratedBlueprint(cache, salesChannelName);
    const dryRun = args.dryRun ?? false;

    let lines: string[];

    if (fixType === "theme") {
        lines = await fixThemeImages(salesChannelName, blueprint, cache, args.target, dryRun);
    } else {
        if (!args.target) {
            throw new CLIError(
                `--target is required (${fixType === "cms" ? "CMS page name" : `${fixType} name or ID`})`,
                "MISSING_ARG"
            );
        }

        if (fixType === "product") {
            lines = await fixProductImages(salesChannelName, blueprint, cache, args.target, dryRun);
        } else if (fixType === "category") {
            lines = await fixCategoryImages(
                salesChannelName,
                blueprint,
                cache,
                args.target,
                dryRun
            );
        } else {
            lines = await fixCmsImages(salesChannelName, blueprint, cache, args.target, dryRun);
        }
    }

    for (const line of lines) {
        console.log(line);
    }
}
