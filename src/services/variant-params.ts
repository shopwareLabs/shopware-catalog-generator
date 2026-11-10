/**
 * Variant setting parameters shared by the MCP tools and the HTTP server (same ranges as the CLI flags)
 */

import type { VariantSettingOverrides } from "../blueprint/index.js";

import { VARIANT_SETTING_LIMITS, VariantSettingSchemas } from "../types/index.js";

const { colors, options, maxVariants, share } = VARIANT_SETTING_LIMITS;

/** Zod shape to spread into a tool's parameters */
export const variantSettingParams = {
    variantColors: VariantSettingSchemas.colors
        .optional()
        .describe(
            `Colours per colour variant product, ${colors.min}-${colors.max} (default: ${colors.default}, env VARIANT_COLORS)`
        ),
    variantOptions: VariantSettingSchemas.options
        .optional()
        .describe(
            `Options per other variant group (Size, Material, ...), ${options.min}-${options.max} (default: ${options.default}, env VARIANT_OPTIONS)`
        ),
    maxVariants: VariantSettingSchemas.maxVariants
        .optional()
        .describe(
            `Max variants per product, ${maxVariants.min}-${maxVariants.max} (default: ${maxVariants.default}, env MAX_VARIANTS)`
        ),
    variantShare: VariantSettingSchemas.share
        .optional()
        .describe(
            `Share of products with variants, ${share.min}-${share.max} (default: ${share.default}, env VARIANT_SHARE). ` +
                `Only at blueprint creation`
        ),
};

/** Tool arguments with the variant setting parameters */
export interface VariantSettingArgs {
    variantColors?: number;
    variantOptions?: number;
    maxVariants?: number;
    variantShare?: number;
}

/** Map tool arguments to service overrides (unset values are left out) */
export function variantOverridesFromParams(args: VariantSettingArgs): VariantSettingOverrides {
    const overrides: VariantSettingOverrides = {
        colors: args.variantColors,
        options: args.variantOptions,
        maxVariants: args.maxVariants,
        share: args.variantShare,
    };
    return Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
}
