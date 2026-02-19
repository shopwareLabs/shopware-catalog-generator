import type { ImageGenerationOptions, ImageProvider } from "../../src/types/providers.js";

/**
 * Mock image provider for testing
 * Returns a small valid base64 image or null
 */
export class MockImageProvider implements ImageProvider {
    readonly name = "mock";
    readonly isSequential = false;
    readonly maxConcurrency = 5;

    private shouldSucceed = true;
    private callLog: Array<{ prompt: string; options?: ImageGenerationOptions }> = [];
    private customImage: string | null = null;

    setShouldSucceed(value: boolean): void {
        this.shouldSucceed = value;
    }

    setCustomImage(base64: string): void {
        this.customImage = base64;
    }

    getPrompts(): string[] {
        return this.callLog.map((c) => c.prompt);
    }

    getCalls(): Array<{ prompt: string; options?: ImageGenerationOptions }> {
        return [...this.callLog];
    }

    reset(): void {
        this.callLog = [];
        this.shouldSucceed = true;
        this.customImage = null;
    }

    get callCount(): number {
        return this.callLog.length;
    }

    async generateImage(prompt: string, options?: ImageGenerationOptions): Promise<string | null> {
        this.callLog.push({ prompt, options });

        if (!this.shouldSucceed) return null;
        if (this.customImage) return this.customImage;

        return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    }
}

/**
 * Mock image provider that always fails
 */
export class FailingImageProvider implements ImageProvider {
    readonly name = "failing-mock";
    readonly isSequential = false;
    readonly maxConcurrency = 1;

    async generateImage(
        _prompt: string,
        _options?: ImageGenerationOptions
    ): Promise<string | null> {
        return null;
    }
}

/**
 * Mock image provider that simulates rate limiting with delays
 */
export class SlowImageProvider implements ImageProvider {
    readonly name = "slow-mock";
    readonly isSequential = true;
    readonly maxConcurrency = 1;

    private delayMs: number;

    constructor(delayMs = 100) {
        this.delayMs = delayMs;
    }

    async generateImage(
        _prompt: string,
        _options?: ImageGenerationOptions
    ): Promise<string | null> {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    }
}
