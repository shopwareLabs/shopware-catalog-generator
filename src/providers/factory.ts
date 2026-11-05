import type {
    AIProviderType,
    ImageProvider,
    ImageProviderType,
    ModelSelection,
    ProviderConfig,
    TextProvider,
} from "../types/index.js";

import {
    AI_PROVIDER_TYPES,
    DEFAULT_POLLINATIONS_IMAGE_MODEL,
    PROVIDER_DEFAULTS,
} from "../types/index.js";
import { logger } from "../utils/index.js";
import { NoOpImageProvider } from "./noop-provider.js";
import { OpenAIImageProvider, OpenAITextProvider } from "./openai-provider.js";
import { PollinationsImageProvider, PollinationsTextProvider } from "./pollinations-provider.js";

/**
 * Create providers from environment variables
 */
export function createProvidersFromEnv(): { text: TextProvider; image: ImageProvider } {
    return createProviders(providerConfigFromEnv());
}

/**
 * Read provider configuration from environment variables
 */
export function providerConfigFromEnv(): ProviderConfig {
    return {
        aiProvider: parseAIProvider(process.env.AI_PROVIDER),
        apiKey: process.env.AI_API_KEY,
        textModel: process.env.AI_MODEL,
        imageProvider: process.env.IMAGE_PROVIDER as ImageProviderType | undefined,
        imageApiKey: process.env.IMAGE_API_KEY,
        imageModel: process.env.IMAGE_MODEL,
        imageQuality: process.env.IMAGE_QUALITY,
    };
}

/**
 * Validate the AI_PROVIDER value. Defaults to Pollinations when unset.
 * Fails loudly for GitHub Models, which was retired on 2026-07-30.
 */
export function parseAIProvider(value: string | undefined): AIProviderType {
    if (!value) return "pollinations";

    if (value === "github-models") {
        throw new Error(
            "GitHub Models was retired on 2026-07-30. Set AI_PROVIDER=pollinations " +
                "(free key at enter.pollinations.ai) or AI_PROVIDER=openai in your .env file."
        );
    }

    const provider = AI_PROVIDER_TYPES.find((type) => type === value);
    if (!provider) {
        throw new Error(
            `Unknown AI_PROVIDER "${value}". Use one of: ${AI_PROVIDER_TYPES.join(", ")}.`
        );
    }
    return provider;
}

/**
 * Resolve which providers and models a config will use, without creating providers.
 * Mirrors the defaults applied by createTextProvider/createImageProvider.
 */
export function resolveModelSelection(config: ProviderConfig): ModelSelection {
    const textProvider = config.aiProvider;
    const textModel = config.textModel || PROVIDER_DEFAULTS[textProvider].textModel;
    const imageProvider = resolveImageProviderType(config);

    if (imageProvider === "openai") {
        const hasKey = Boolean(config.imageApiKey || config.apiKey);
        if (!hasKey) {
            return { textProvider, textModel, imageProvider: "none", imageFreeTier: false };
        }
        return {
            textProvider,
            textModel,
            imageProvider,
            imageModel: config.imageModel || "gpt-image-1-mini",
            imageQuality: config.imageQuality || "low",
            imageFreeTier: false,
        };
    }

    if (imageProvider === "pollinations") {
        const keyed = Boolean(config.imageApiKey) || (config.apiKey ?? "").startsWith("sk_");
        return {
            textProvider,
            textModel,
            imageProvider,
            imageModel: config.imageModel || DEFAULT_POLLINATIONS_IMAGE_MODEL,
            imageFreeTier: !keyed,
        };
    }

    return { textProvider, textModel, imageProvider: "none", imageFreeTier: false };
}

/**
 * Determine the image provider type (explicit override, main provider, or Pollinations fallback)
 */
function resolveImageProviderType(config: ProviderConfig): ImageProviderType {
    if (config.imageProvider) return config.imageProvider;
    if (!PROVIDER_DEFAULTS[config.aiProvider].supportsImages) return "pollinations";
    return config.aiProvider === "pollinations" ? "pollinations" : "openai";
}

/**
 * Create text and image providers based on configuration
 */
export function createProviders(config: ProviderConfig): {
    text: TextProvider;
    image: ImageProvider;
} {
    const textProvider = createTextProvider(config);
    const imageProvider = createImageProvider(config);

    logger.info(`Text provider: ${textProvider.name} (sequential: ${textProvider.isSequential})`, {
        cli: true,
    });
    logger.info(
        `Image provider: ${imageProvider.name} (sequential: ${imageProvider.isSequential})`,
        {
            cli: true,
        }
    );

    return { text: textProvider, image: imageProvider };
}

/**
 * Create a text provider based on the AI provider type
 */
function createTextProvider(config: ProviderConfig): TextProvider {
    const defaults = PROVIDER_DEFAULTS[config.aiProvider];
    const model = config.textModel || defaults.textModel;

    // Validate API key for providers that require it
    if (defaults.requiresApiKey && !config.apiKey) {
        throw new Error(
            `API key is required for ${config.aiProvider}. Set AI_API_KEY in your .env file.`
        );
    }

    const apiKey = config.apiKey ?? "";

    switch (config.aiProvider) {
        case "openai":
            return new OpenAITextProvider(apiKey, model);

        case "pollinations":
            return new PollinationsTextProvider(model, apiKey);

        default:
            throw new Error(`Unknown AI provider: ${config.aiProvider}`);
    }
}

/**
 * Create an image provider based on configuration
 * Falls back to pollinations if the main provider doesn't support images
 */
function createImageProvider(config: ProviderConfig): ImageProvider {
    const imageProviderType = resolveImageProviderType(config);

    switch (imageProviderType) {
        case "openai": {
            // For OpenAI images, we need an API key
            const apiKey = config.imageApiKey || config.apiKey;
            if (!apiKey) {
                logger.warn("No API key for OpenAI image generation. Disabling images.");
                return new NoOpImageProvider();
            }
            const model = config.imageModel || "gpt-image-1-mini";
            const quality = config.imageQuality || "low";
            return new OpenAIImageProvider(apiKey, model, quality);
        }

        case "pollinations": {
            const pollinationsModel = config.imageModel || DEFAULT_POLLINATIONS_IMAGE_MODEL;

            // Use explicit IMAGE_API_KEY if set, otherwise:
            // - sk_ keys: pass through (no balance constraints)
            // - pk_ keys: omit key to use free tier (preserves pollen for text)
            // - no key: use free tier
            if (config.imageApiKey) {
                return new PollinationsImageProvider(config.imageApiKey, pollinationsModel);
            }

            const mainKey = config.apiKey ?? "";
            if (mainKey.startsWith("sk_")) {
                return new PollinationsImageProvider(mainKey, pollinationsModel);
            }

            if (mainKey.startsWith("pk_")) {
                logger.info(
                    "Using Pollinations free image generation (pk_ key preserved for text)",
                    { cli: true }
                );
            } else if (mainKey && !mainKey.startsWith("sk_")) {
                logger.info("Using Pollinations free image generation (no image API key needed)", {
                    cli: true,
                });
            }

            return new PollinationsImageProvider("", pollinationsModel);
        }

        case "none":
            return new NoOpImageProvider();

        default:
            throw new Error(`Unknown image provider: ${imageProviderType}`);
    }
}
