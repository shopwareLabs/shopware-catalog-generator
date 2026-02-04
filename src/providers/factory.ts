import type {
    AIProviderType,
    ImageProvider,
    ImageProviderType,
    ProviderConfig,
    TextProvider,
} from "../types/index.js";

import { PROVIDER_DEFAULTS } from "../types/index.js";
import { logger } from "../utils/index.js";

import { GitHubModelsTextProvider } from "./github-models-provider.js";
import { NoOpImageProvider } from "./noop-provider.js";
import { OpenAIImageProvider, OpenAITextProvider } from "./openai-provider.js";
import { PollinationsImageProvider, PollinationsTextProvider } from "./pollinations-provider.js";

/**
 * Create providers from environment variables
 */
export function createProvidersFromEnv(): { text: TextProvider; image: ImageProvider } {
    const aiProvider = (process.env.AI_PROVIDER as AIProviderType) || "pollinations";
    const apiKey = process.env.AI_API_KEY;
    const textModel = process.env.AI_MODEL;
    const imageProvider = process.env.IMAGE_PROVIDER as ImageProviderType | undefined;
    const imageApiKey = process.env.IMAGE_API_KEY;
    const imageModel = process.env.IMAGE_MODEL;

    const config: ProviderConfig = {
        aiProvider,
        apiKey,
        textModel,
        imageProvider,
        imageApiKey,
        imageModel,
    };

    return createProviders(config);
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

    logger.cli(`Text provider: ${textProvider.name} (sequential: ${textProvider.isSequential})`);
    logger.cli(
        `Image provider: ${imageProvider.name} (sequential: ${imageProvider.isSequential})`
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

        case "github-models":
            return new GitHubModelsTextProvider(apiKey, model);

        case "pollinations":
            return new PollinationsTextProvider(model, config.apiKey);

        default:
            throw new Error(`Unknown AI provider: ${config.aiProvider}`);
    }
}

/**
 * Create an image provider based on configuration
 * Falls back to pollinations if the main provider doesn't support images
 */
function createImageProvider(config: ProviderConfig): ImageProvider {
    const mainDefaults = PROVIDER_DEFAULTS[config.aiProvider];

    // Determine which image provider to use
    let imageProviderType: ImageProviderType;

    if (config.imageProvider) {
        // Explicit override from config
        imageProviderType = config.imageProvider;
    } else if (mainDefaults.supportsImages) {
        // Use main provider if it supports images
        imageProviderType = config.aiProvider === "pollinations" ? "pollinations" : "openai";
    } else {
        // Fall back to pollinations for free images
        imageProviderType = "pollinations";
    }

    switch (imageProviderType) {
        case "openai": {
            // For OpenAI images, we need an API key
            const apiKey = config.imageApiKey || config.apiKey;
            if (!apiKey) {
                logger.warn(
                    "No API key for OpenAI image generation. Falling back to Pollinations."
                );
                return new PollinationsImageProvider();
            }
            const model = config.imageModel || "gpt-image-1.5";
            return new OpenAIImageProvider(apiKey, model);
        }

        case "pollinations": {
            const pollinationsApiKey = config.imageApiKey || config.apiKey;
            const pollinationsModel = config.imageModel || "flux";
            return new PollinationsImageProvider(pollinationsApiKey, pollinationsModel);
        }

        case "none":
            return new NoOpImageProvider();

        default:
            throw new Error(`Unknown image provider: ${imageProviderType}`);
    }
}
