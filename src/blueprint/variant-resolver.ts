/**
 * Variant Resolver - Resolves variant configs from AI-suggested group names
 *
 * Uses property cache for known groups, generates options for unknown groups via AI.
 */

import { z } from "zod";

import type {
    CachedPropertyGroup,
    TextProvider,
    VariantConfig,
    VariantSettings,
} from "../types/index.js";

import { PropertyCache } from "../property-cache.js";
import { DEFAULT_VARIANT_SETTINGS } from "../types/index.js";
import { executeWithRetry, logger, toKebabCase } from "../utils/index.js";
import { capVariantConfigs, pickPreferredOptions, pickOptions } from "./variant-settings.js";

const PropertyOptionsResponseSchema = z.object({
    groupName: z.string(),
    options: z.array(z.string()),
    priceModifiers: z
        .array(
            z.object({
                option: z.string(),
                modifier: z.number(),
            })
        )
        .nullable(),
});

/** Product the variant options are picked for */
export interface VariantProductContext {
    name: string;
    category: string;
    /** Seed for the option picks (same product → same options). Defaults to the name */
    productId?: string;
    /** Preferred colours, the product's own colour first (then the AI's choice) */
    colors?: string[];
}

export class VariantResolver {
    constructor(
        private readonly textProvider: TextProvider,
        private readonly propertyCache: PropertyCache,
        private readonly settings: VariantSettings = DEFAULT_VARIANT_SETTINGS
    ) {}

    /**
     * Resolve variant configs from AI-suggested group names.
     * Uses cache for known groups, generates options for unknown groups. Picks the exact
     * number of options from the settings and caps the variant count.
     */
    async resolveVariantConfigs(
        suggestedGroups: string[] | undefined,
        productContext: VariantProductContext
    ): Promise<VariantConfig[]> {
        if (!suggestedGroups || suggestedGroups.length === 0) {
            return [];
        }

        const configs: VariantConfig[] = [];
        const seen = new Set<string>();

        for (const groupName of suggestedGroups) {
            const config = await this.resolveSingleVariantConfig(groupName, productContext);
            if (!config || seen.has(config.group.toLowerCase())) continue;
            seen.add(config.group.toLowerCase());
            configs.push(config);
        }

        return capVariantConfigs(configs, this.settings.maxVariants);
    }

    /** Pick the exact option count for a group (colours keep the preferred ones first) */
    private pickGroupOptions(
        groupName: string,
        pool: string[],
        productContext: VariantProductContext
    ): string[] {
        const seed = `variant-options:${productContext.productId ?? productContext.name}:${groupName.toLowerCase()}`;
        if (groupName.toLowerCase() === "color") {
            return pickPreferredOptions(
                productContext.colors ?? [],
                pool,
                this.settings.colors,
                seed
            );
        }
        return pickOptions(pool, this.settings.options, seed);
    }

    /**
     * Resolve a single variant config from a group name.
     * Returns null if the group cannot be resolved.
     */
    async resolveSingleVariantConfig(
        groupName: string,
        productContext: VariantProductContext
    ): Promise<VariantConfig | null> {
        const normalizedName = this.propertyCache.resolveGroupName(groupName);

        const cached = this.propertyCache.get(normalizedName);
        if (cached) {
            return this.buildVariantConfigFromCache(cached, groupName, productContext);
        }

        if (normalizedName.toLowerCase() === "color" || groupName.toLowerCase() === "color") {
            return this.handleColorFallback(productContext);
        }

        return this.generateVariantConfigViaAI(groupName, productContext);
    }

    /**
     * Build a VariantConfig from cached property data.
     */
    buildVariantConfigFromCache(
        cached: CachedPropertyGroup,
        originalName: string,
        productContext: VariantProductContext = { name: originalName, category: "" }
    ): VariantConfig {
        const finalOptions = this.pickGroupOptions(cached.name, cached.options, productContext);

        const priceModifiers: Record<string, number> = {};
        for (const opt of finalOptions) {
            priceModifiers[opt] = cached.priceModifiers?.[opt] ?? 1.0;
        }

        logger.debug(`Property cache hit for "${originalName}" -> "${cached.name}"`, {
            data: { options: finalOptions.length },
        });

        return {
            group: cached.name,
            selectedOptions: finalOptions,
            priceModifiers,
        };
    }

    /**
     * Handle Color when it's suggested but not found via normalized name.
     */
    handleColorFallback(productContext: VariantProductContext): VariantConfig | null {
        const colorFromCache = this.propertyCache.get("Color");
        const pool = colorFromCache?.options ?? [];
        const selectedOptions = this.pickGroupOptions("Color", pool, productContext);
        if (selectedOptions.length < 2) {
            logger.warn(`AI suggested "Color" but no colours are known for it. Skipping.`);
            return null;
        }

        return {
            group: colorFromCache?.name ?? "Color",
            selectedOptions,
            priceModifiers: {},
        };
    }

    /**
     * Generate a VariantConfig via AI for unknown property groups.
     */
    async generateVariantConfigViaAI(
        groupName: string,
        productContext: VariantProductContext
    ): Promise<VariantConfig | null> {
        logger.info(`Property cache miss for "${groupName}", generating options...`);

        try {
            return await this.generatePropertyOptions(groupName, productContext);
        } catch (error) {
            logger.error(`Failed to generate options for "${groupName}"`, { data: error });
            return null;
        }
    }

    /**
     * Generate property options using AI for a new group
     * Note: Color should NEVER be generated here - it must come from universal cache
     */
    async generatePropertyOptions(
        groupName: string,
        productContext: VariantProductContext
    ): Promise<VariantConfig> {
        if (groupName.toLowerCase() === "color") {
            throw new Error("Color must not be generated via AI - use universal cache");
        }

        const prompt = `Generate property options for a variant property group.

Product context:
- Product: "${productContext.name}"
- Category: "${productContext.category}"
- Property group: "${groupName}"

Generate ${Math.max(5, this.settings.options + 2)}-${Math.max(8, this.settings.options + 4)} realistic options for this property group.
Options should be:
- Appropriate for the product type
- Realistic for e-commerce variants
- Short (1-3 words each)

Also suggest price modifiers (multipliers) where appropriate:
- 1.0 = base price
- 0.9 = 10% cheaper
- 1.1 = 10% more expensive

Return JSON:
{
  "groupName": "${groupName}",
  "options": ["Option 1", "Option 2", ...],
  "priceModifiers": [{"option": "Option 1", "modifier": 1.0}, {"option": "Option 2", "modifier": 1.1}, ...]
}`;

        const response = await executeWithRetry(() =>
            this.textProvider.generateCompletion(
                [
                    {
                        role: "system",
                        content: "You are a JSON generator. Output ONLY valid JSON.",
                    },
                    { role: "user", content: prompt },
                ],
                PropertyOptionsResponseSchema,
                "PropertyOptionsResponse"
            )
        );

        const parsed = JSON.parse(response);
        const validated = PropertyOptionsResponseSchema.parse(parsed);

        const priceModifiersRecord: Record<string, number> = {};
        if (validated.priceModifiers) {
            for (const pm of validated.priceModifiers) {
                priceModifiersRecord[pm.option] = pm.modifier;
            }
        }

        const displayType = PropertyCache.inferDisplayType(groupName);
        const cachedGroup: CachedPropertyGroup = {
            name: validated.groupName,
            slug: toKebabCase(validated.groupName),
            displayType,
            options: validated.options,
            priceModifiers:
                Object.keys(priceModifiersRecord).length > 0 ? priceModifiersRecord : undefined,
            createdAt: new Date().toISOString(),
            source: "ai-generated",
        };
        this.propertyCache.save(cachedGroup);

        logger.info(`Generated and cached new property group "${groupName}"`, {
            data: { options: validated.options.length },
        });

        const finalOptions = this.pickGroupOptions(
            validated.groupName,
            validated.options,
            productContext
        );

        const priceModifiers: Record<string, number> = {};
        for (const opt of finalOptions) {
            priceModifiers[opt] = priceModifiersRecord[opt] ?? 1.0;
        }

        return {
            group: validated.groupName,
            selectedOptions: finalOptions,
            priceModifiers,
        };
    }
}
