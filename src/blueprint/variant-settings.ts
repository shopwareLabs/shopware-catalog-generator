/**
 * Variant settings - resolve, validate and apply them (no AI)
 *
 * Every choice here is seeded with the product ID, so the same blueprint always yields
 * the same variant products and options. The hydrated blueprint is what gets uploaded.
 */

import type {
    Blueprint,
    BlueprintProduct,
    VariantConfig,
    VariantSettingLimit,
    VariantSettings,
} from "../types/index.js";

import { DEFAULT_VARIANT_SETTINGS, VARIANT_SETTING_LIMITS } from "../types/index.js";
import { createSeededRandom } from "../utils/index.js";

type VariantSettingKey = keyof VariantSettings;

const SETTING_KEYS: VariantSettingKey[] = ["colors", "options", "maxVariants", "share"];

/** CLI flag per setting */
export const VARIANT_SETTING_FLAGS: Record<VariantSettingKey, string> = {
    colors: "--variant-colors",
    options: "--variant-options",
    maxVariants: "--max-variants",
    share: "--variant-share",
};

/** Environment variable per setting */
export const VARIANT_SETTING_ENV: Record<VariantSettingKey, string> = {
    colors: "VARIANT_COLORS",
    options: "VARIANT_OPTIONS",
    maxVariants: "MAX_VARIANTS",
    share: "VARIANT_SHARE",
};

/** Raw override values (CLI flags or MCP arguments) */
export type VariantSettingOverrides = Partial<Record<VariantSettingKey, string | number>>;

/** Name of the colour group that keeps its default colour first */
const COLOR_GROUP = "color";

/** Smallest option count a group is reduced to before it is dropped */
const MIN_OPTIONS = 2;

/** Thrown for a value that is not a number or outside its range */
export class VariantSettingsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "VariantSettingsError";
    }
}

function describeRange(limit: VariantSettingLimit): string {
    const kind = limit.integer ? "a whole number" : "a number";
    return `${kind} between ${limit.min} and ${limit.max}`;
}

function parseSetting(key: VariantSettingKey, raw: string | number, source: string): number {
    const limit = VARIANT_SETTING_LIMITS[key];
    const value = typeof raw === "number" ? raw : Number(String(raw).trim());
    const valid =
        String(raw).trim() !== "" &&
        Number.isFinite(value) &&
        (!limit.integer || Number.isInteger(value)) &&
        value >= limit.min &&
        value <= limit.max;
    if (!valid) {
        throw new VariantSettingsError(
            `${source} must be ${describeRange(limit)} (got "${String(raw)}")`
        );
    }
    return value;
}

function resolveSetting(
    key: VariantSettingKey,
    overrides: VariantSettingOverrides,
    env: Record<string, string | undefined>,
    base: VariantSettings
): number {
    const flagValue = overrides[key];
    if (flagValue !== undefined) {
        return parseSetting(key, flagValue, VARIANT_SETTING_FLAGS[key]);
    }
    const envName = VARIANT_SETTING_ENV[key];
    const envValue = env[envName];
    if (envValue !== undefined && envValue.trim() !== "") {
        return parseSetting(key, envValue, envName);
    }
    return base[key];
}

/**
 * Resolve variant settings: flag beats env var beats base (stored settings or defaults).
 *
 * @throws VariantSettingsError for a value that is not a number or outside its range
 */
export function resolveVariantSettings(
    overrides: VariantSettingOverrides = {},
    env: Record<string, string | undefined> = process.env,
    base: VariantSettings = DEFAULT_VARIANT_SETTINGS
): VariantSettings {
    return {
        colors: resolveSetting("colors", overrides, env, base),
        options: resolveSetting("options", overrides, env, base),
        maxVariants: resolveSetting("maxVariants", overrides, env, base),
        share: resolveSetting("share", overrides, env, base),
    };
}

/** True when any override is set */
export function hasVariantOverrides(overrides: VariantSettingOverrides): boolean {
    return SETTING_KEYS.some((key) => overrides[key] !== undefined);
}

/** Settings stored in the blueprint, defaults for older blueprints */
export function blueprintVariantSettings(blueprint: Pick<Blueprint, "variants">): VariantSettings {
    return blueprint.variants ?? DEFAULT_VARIANT_SETTINGS;
}

/** One-line summary for CLI output */
export function formatVariantSettings(settings: VariantSettings): string {
    const share = Math.round(settings.share * 100);
    return (
        `${share}% variant products, ${settings.colors} colours, ` +
        `${settings.options} options per other group, max ${settings.maxVariants} variants`
    );
}

/** Seeded shuffle (Fisher-Yates) */
function seededShuffle<T>(items: readonly T[], seed: string): T[] {
    const random = createSeededRandom(seed);
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        const current = result[i];
        const other = result[j];
        if (current === undefined || other === undefined) continue;
        result[i] = other;
        result[j] = current;
    }
    return result;
}

function uniqueByName(values: readonly string[]): string[] {
    const seen = new Set<string>();
    return values
        .map((value) => value.trim())
        .filter((value) => {
            const key = value.toLowerCase();
            if (value === "" || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

/**
 * Mark exactly round(products × share) products as variant products.
 * The choice is seeded with the product IDs, so it is stable for a blueprint.
 */
export function assignVariantProducts(products: BlueprintProduct[], share: number): void {
    const count = Math.round(products.length * share);
    const ranked = [...products].sort(
        (a, b) => variantRank(a.id) - variantRank(b.id) || a.id.localeCompare(b.id)
    );
    const variantIds = new Set(ranked.slice(0, count).map((p) => p.id));
    for (const product of products) {
        product.metadata.isVariant = variantIds.has(product.id);
    }
}

function variantRank(productId: string): number {
    return createSeededRandom(`variant:${productId}`)();
}

/**
 * Pick exactly `count` options from a pool (fewer if the pool is smaller).
 * Seeded, so the same product always gets the same options.
 */
export function pickOptions(pool: readonly string[], count: number, seed: string): string[] {
    return seededShuffle(uniqueByName(pool), seed).slice(0, Math.max(0, count));
}

/**
 * Pick exactly `count` options with the preferred ones first (for colours: the product's
 * own colour, then the colours the AI chose), topped up from the pool when there are too few.
 */
export function pickPreferredOptions(
    preferred: readonly string[],
    pool: readonly string[],
    count: number,
    seed: string
): string[] {
    const chosen = uniqueByName(preferred).slice(0, count);
    if (chosen.length >= count) return chosen;

    const taken = new Set(chosen.map((c) => c.toLowerCase()));
    const rest = pool.filter((option) => !taken.has(option.trim().toLowerCase()));
    return [...chosen, ...pickOptions(rest, count - chosen.length, seed)];
}

/** Number of variants a set of configs produces (cartesian product) */
export function countVariants(configs: readonly VariantConfig[]): number {
    if (configs.length === 0) return 0;
    return configs.reduce((total, config) => total * config.selectedOptions.length, 1);
}

/** True for the colour group, which keeps its default colour first */
export function isColorVariantGroup(group: string): boolean {
    return group.trim().toLowerCase() === COLOR_GROUP;
}

function isColorGroup(config: VariantConfig): boolean {
    return isColorVariantGroup(config.group);
}

function withOptions(config: VariantConfig, options: string[]): VariantConfig {
    const priceModifiers = Object.fromEntries(
        Object.entries(config.priceModifiers).filter(([option]) => options.includes(option))
    );
    return { ...config, selectedOptions: options, priceModifiers };
}

/** Index of the group to shrink next: the largest non-colour group, then the colour group */
function nextGroupToShrink(configs: readonly VariantConfig[]): number {
    const shrinkable = configs
        .map((config, index) => ({ config, index }))
        .filter(({ config }) => config.selectedOptions.length > MIN_OPTIONS);
    const others = shrinkable.filter(({ config }) => !isColorGroup(config));
    const pool = others.length > 0 ? others : shrinkable;
    const largest = pool.reduce<{ config: VariantConfig; index: number } | undefined>(
        (best, entry) =>
            !best || entry.config.selectedOptions.length > best.config.selectedOptions.length
                ? entry
                : best,
        undefined
    );
    return largest?.index ?? -1;
}

/** Index of the last non-colour group (dropped when shrinking is not enough) */
function lastDroppableGroup(configs: readonly VariantConfig[]): number {
    for (let i = configs.length - 1; i >= 0; i--) {
        const config = configs[i];
        if (config && !isColorGroup(config) && configs.length > 1) return i;
    }
    return -1;
}

/**
 * Cap the variants of one product at `maxVariants`.
 *
 * Order: shrink the other groups to 2 options (largest first), then the colours to 2
 * (the default colour stays first), then drop other groups from the end.
 */
export function capVariantConfigs(
    configs: readonly VariantConfig[],
    maxVariants: number
): VariantConfig[] {
    let result = configs.map((config) => withOptions(config, [...config.selectedOptions]));

    while (countVariants(result) > maxVariants) {
        const shrinkIndex = nextGroupToShrink(result);
        if (shrinkIndex >= 0) {
            result = result.map((config, index) =>
                index === shrinkIndex
                    ? withOptions(config, config.selectedOptions.slice(0, -1))
                    : config
            );
            continue;
        }
        const dropIndex = lastDroppableGroup(result);
        if (dropIndex < 0) break;
        result = result.filter((_, index) => index !== dropIndex);
    }

    return result;
}

/** Inputs for re-picking the options of one product with new settings */
export interface RepickInput {
    productId: string;
    configs: readonly VariantConfig[];
    settings: VariantSettings;
    /** All known options of a group (cache), used to top up */
    poolFor: (group: string) => string[];
    /** Default colour of the product (stays the first colour) */
    defaultColor?: string;
    /** New colours to add after the existing ones (e.g. chosen by the AI) */
    extraColors?: readonly string[];
}

/**
 * Re-pick the options of one product for new settings (`hydrate --only=variants`).
 * Existing options stay first, so lowering a count keeps the first ones and raising it
 * only adds new options. Then the variant cap is applied.
 */
export function repickVariantConfigs(input: RepickInput): VariantConfig[] {
    const { productId, settings } = input;
    const configs = input.configs.map((config) => {
        const isColor = isColorVariantGroup(config.group);
        const preferred = isColor
            ? [
                  ...(input.defaultColor ? [input.defaultColor] : []),
                  ...config.selectedOptions,
                  ...(input.extraColors ?? []),
              ]
            : config.selectedOptions;
        const count = isColor ? settings.colors : settings.options;
        const seed = `variant-options:${productId}:${config.group.toLowerCase()}`;
        const options = pickPreferredOptions(preferred, input.poolFor(config.group), count, seed);
        const priceModifiers = Object.fromEntries(
            options.map((option) => [option, config.priceModifiers[option] ?? 1.0])
        );
        return { ...config, selectedOptions: options, priceModifiers };
    });
    return capVariantConfigs(configs, settings.maxVariants);
}

/** Number of colours a product still needs to reach the colour count of the settings */
export function missingColorCount(
    configs: readonly VariantConfig[] | undefined,
    defaultColor: string | undefined,
    settings: VariantSettings
): number {
    const colorConfig = configs?.find((config) => isColorVariantGroup(config.group));
    if (!colorConfig) return 0;
    const known = uniqueByName([
        ...(defaultColor ? [defaultColor] : []),
        ...colorConfig.selectedOptions,
    ]);
    return Math.max(0, settings.colors - known.length);
}

/**
 * Default colour of a product: the stored one, else its own Color property,
 * else the first option of its colour variant group.
 */
export function productDefaultColor(product: BlueprintProduct): string | undefined {
    if (product.metadata.defaultColor) return product.metadata.defaultColor;
    const own = product.metadata.properties.find((p) =>
        ["color", "colour"].includes(p.group.trim().toLowerCase())
    )?.value;
    if (own) return own;
    const colorConfig = product.metadata.variantConfigs?.find((c) => isColorVariantGroup(c.group));
    return colorConfig?.selectedOptions[0];
}

/** Variant products that need more colours for the given settings (`hydrate --only=variants`) */
export function productsMissingColors(
    products: readonly BlueprintProduct[],
    settings: VariantSettings
): BlueprintProduct[] {
    return products.filter(
        (p) =>
            p.metadata.isVariant &&
            missingColorCount(p.metadata.variantConfigs, productDefaultColor(p), settings) > 0
    );
}
