/**
 * Variant settings - how many variants a variant product gets
 *
 * Set per store at blueprint creation (flags or env vars) and stored in the blueprint,
 * so the hydrated blueprint and the Shopware upload always agree.
 */

import { z } from "zod";

/** Variant settings stored in `blueprint.variants` */
export interface VariantSettings {
    /** Colours per variant product with a Color group */
    colors: number;
    /** Options per other variant group (Size, Material, ...) */
    options: number;
    /** Upper limit for the variants of one product (cartesian product of all groups) */
    maxVariants: number;
    /** Share of products that get variants (0-1) */
    share: number;
}

/** Range and default of one setting */
export interface VariantSettingLimit {
    min: number;
    max: number;
    default: number;
    /** Whole numbers only */
    integer: boolean;
}

/** Ranges and defaults; the CLI, env vars and MCP tools all validate against these */
export const VARIANT_SETTING_LIMITS: Record<keyof VariantSettings, VariantSettingLimit> = {
    colors: { min: 2, max: 12, default: 4, integer: true },
    options: { min: 2, max: 8, default: 3, integer: true },
    maxVariants: { min: 4, max: 100, default: 24, integer: true },
    share: { min: 0, max: 1, default: 0.3, integer: false },
};

/** Default variant settings */
export const DEFAULT_VARIANT_SETTINGS: VariantSettings = {
    colors: VARIANT_SETTING_LIMITS.colors.default,
    options: VARIANT_SETTING_LIMITS.options.default,
    maxVariants: VARIANT_SETTING_LIMITS.maxVariants.default,
    share: VARIANT_SETTING_LIMITS.share.default,
};

function limitSchema(limit: VariantSettingLimit): z.ZodNumber {
    const base = limit.integer ? z.number().int() : z.number();
    return base.min(limit.min).max(limit.max);
}

/** Zod schema per setting (used by MCP tool parameters) */
export const VariantSettingSchemas = {
    colors: limitSchema(VARIANT_SETTING_LIMITS.colors),
    options: limitSchema(VARIANT_SETTING_LIMITS.options),
    maxVariants: limitSchema(VARIANT_SETTING_LIMITS.maxVariants),
    share: limitSchema(VARIANT_SETTING_LIMITS.share),
};

/** Zod schema for stored variant settings */
export const VariantSettingsSchema = z.object(VariantSettingSchemas);
