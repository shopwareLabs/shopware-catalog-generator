/**
 * Variant Resolver - Resolves variant configs from AI-suggested group names
 *
 * Uses property cache for known groups, generates options for unknown groups via AI.
 */

import { z } from "zod";

import type { CachedPropertyGroup, TextProvider, VariantConfig } from "../types/index.js";

import { PropertyCache } from "../property-cache.js";
import { executeWithRetry, logger, randomSamplePercent, toKebabCase } from "../utils/index.js";

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

export class VariantResolver {
    constructor(
        private readonly textProvider: TextProvider,
        private readonly propertyCache: PropertyCache
    ) {}

    /**
     * Resolve variant configs from AI-suggested group names
     * Uses cache for known groups, generates options for unknown groups
     */
    async resolveVariantConfigs(
        suggestedGroups: string[] | undefined,
        productContext: { name: string; category: string }
    ): Promise<VariantConfig[]> {
        if (!suggestedGroups || suggestedGroups.length === 0) {
            return [];
        }

        const configs: VariantConfig[] = [];

        for (const groupName of suggestedGroups) {
            const config = await this.resolveSingleVariantConfig(groupName, productContext);
            if (config) {
                configs.push(config);
            }
        }

        return configs;
    }

    /**
     * Resolve a single variant config from a group name.
     * Returns null if the group cannot be resolved.
     */
    async resolveSingleVariantConfig(
        groupName: string,
        productContext: { name: string; category: string }
    ): Promise<VariantConfig | null> {
        const normalizedName = this.propertyCache.resolveGroupName(groupName);

        const cached = this.propertyCache.get(normalizedName);
        if (cached) {
            return this.buildVariantConfigFromCache(cached, groupName);
        }

        if (normalizedName.toLowerCase() === "color" || groupName.toLowerCase() === "color") {
            return this.handleColorFallback();
        }

        return this.generateVariantConfigViaAI(groupName, productContext);
    }

    /**
     * Build a VariantConfig from cached property data.
     */
    buildVariantConfigFromCache(cached: CachedPropertyGroup, originalName: string): VariantConfig {
        const selectedOptions = randomSamplePercent(cached.options, 0.4, 0.6);
        const finalOptions =
            selectedOptions.length >= 2
                ? selectedOptions
                : cached.options.slice(0, Math.min(2, cached.options.length));

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
    handleColorFallback(): VariantConfig | null {
        logger.warn(
            `AI suggested "Color" but it's not in cache - this shouldn't happen. Skipping.`
        );

        const colorFromCache = this.propertyCache.get("Color");
        if (!colorFromCache) {
            return null;
        }

        const selectedOptions = randomSamplePercent(colorFromCache.options, 0.4, 0.6);
        const finalOptions =
            selectedOptions.length >= 2
                ? selectedOptions
                : colorFromCache.options.slice(0, Math.min(2, colorFromCache.options.length));

        return {
            group: colorFromCache.name,
            selectedOptions: finalOptions,
            priceModifiers: {},
        };
    }

    /**
     * Generate a VariantConfig via AI for unknown property groups.
     */
    async generateVariantConfigViaAI(
        groupName: string,
        productContext: { name: string; category: string }
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
        productContext: { name: string; category: string }
    ): Promise<VariantConfig> {
        if (groupName.toLowerCase() === "color") {
            throw new Error("Color must not be generated via AI - use universal cache");
        }

        const prompt = `Generate property options for a variant property group.

Product context:
- Product: "${productContext.name}"
- Category: "${productContext.category}"
- Property group: "${groupName}"

Generate 5-8 realistic options for this property group.
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

        const selectedOptions = randomSamplePercent(validated.options, 0.4, 0.6);
        const finalOptions =
            selectedOptions.length >= 2 ? selectedOptions : validated.options.slice(0, 2);

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
