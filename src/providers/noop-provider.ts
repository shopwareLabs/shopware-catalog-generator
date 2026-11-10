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

/** False for the disabled image provider (IMAGE_PROVIDER=none) */
export function imagesEnabled(provider: ImageProvider): boolean {
    return !(provider instanceof NoOpImageProvider);
}
