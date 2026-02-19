import type { ImageGenerationOptions, ImageProvider } from "../types/index.js";

/**
 * No-operation image provider
 * Used when image generation is disabled
 */
export class NoOpImageProvider implements ImageProvider {
    readonly isSequential = false;
    readonly maxConcurrency = 1;
    readonly name = "none";

    async generateImage(
        _prompt: string,
        _options?: ImageGenerationOptions
    ): Promise<string | null> {
        return null;
    }
}
