import type { ImageProvider } from "../../src/types/providers.js";

/**
 * Mock image provider for testing
 * Returns a small valid base64 image or null
 */
export class MockImageProvider implements ImageProvider {
    readonly name = "mock";
    readonly isSequential = false;
    readonly maxConcurrency = 5;

    private shouldSucceed = true;
    private callLog: string[] = [];
    private customImage: string | null = null;

    /**
     * Set whether image generation should succeed
     */
    setShouldSucceed(value: boolean): void {
        this.shouldSucceed = value;
    }

    /**
     * Set a custom base64 image to return
     */
    setCustomImage(base64: string): void {
        this.customImage = base64;
    }

    /**
     * Get all prompts that were passed to this provider
     */
    getPrompts(): string[] {
        return [...this.callLog];
    }

    /**
     * Clear call history and reset state
     */
    reset(): void {
        this.callLog = [];
        this.shouldSucceed = true;
        this.customImage = null;
    }

    /**
     * Get the number of calls made
     */
    get callCount(): number {
        return this.callLog.length;
    }

    async generateImage(prompt: string): Promise<string | null> {
        this.callLog.push(prompt);

        if (!this.shouldSucceed) {
            return null;
        }

        if (this.customImage) {
            return this.customImage;
        }

        // Return a minimal valid PNG (1x1 transparent pixel)
        // This is a valid base64-encoded PNG image
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

    async generateImage(_prompt: string): Promise<string | null> {
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

    async generateImage(_prompt: string): Promise<string | null> {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    }
}
