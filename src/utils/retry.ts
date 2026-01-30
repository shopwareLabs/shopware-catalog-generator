/**
 * Retry utilities for handling rate limits and transient failures
 */

/** Default maximum retry attempts */
export const DEFAULT_MAX_RETRIES = 5;

/** Default base delay for exponential backoff (ms) - 10s to handle 10/60s rate limits */
export const DEFAULT_BASE_DELAY_MS = 10000;

/** Options for retry behavior */
export interface RetryOptions {
    /** Maximum number of retry attempts (default: 3) */
    maxRetries?: number;
    /** Base delay in ms for exponential backoff (default: 2000) */
    baseDelay?: number;
    /** Optional callback when retrying */
    onRetry?: (attempt: number, delay: number, error: Error) => void;
}

/**
 * Execute a function with retry logic and exponential backoff for rate limits
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration options
 * @returns The result of the function
 * @throws The last error if all retries are exhausted
 */
export async function executeWithRetry<T>(
    fn: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseDelay = options.baseDelay ?? DEFAULT_BASE_DELAY_MS;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error as Error;

            // Check if it's a rate limit error
            if (isRateLimitError(error)) {
                if (attempt < maxRetries) {
                    // Try to get retry-after from error, otherwise use exponential backoff
                    const retryAfterMs = getRetryAfterMs(error);
                    const exponentialDelay = baseDelay * Math.pow(2, attempt);
                    // Use retry-after if valid, otherwise exponential backoff
                    const delay = retryAfterMs > 0 ? retryAfterMs : exponentialDelay;

                    if (options.onRetry) {
                        options.onRetry(attempt + 1, delay, lastError);
                    } else {
                        console.warn(
                            `Rate limit hit, waiting ${delay / 1000}s before retry ${attempt + 1}/${maxRetries}...`
                        );
                    }

                    await sleep(delay);
                    continue;
                }
            }

            // For non-rate-limit errors, don't retry
            throw error;
        }
    }

    throw lastError;
}

/**
 * Extract retry-after delay from error headers (in milliseconds)
 * Returns 0 if not found or invalid
 *
 * Note: Only uses 'retry-after' header, NOT 'x-ratelimit-timeremaining'
 * which represents time until window reset (could be hours for daily limits)
 */
export function getRetryAfterMs(error: unknown): number {
    if (error && typeof error === "object") {
        const err = error as Record<string, unknown>;

        // Check for headers object (OpenAI style)
        if (err.headers && typeof err.headers === "object") {
            const headers = err.headers as Record<string, string>;
            const retryAfter = headers["retry-after"];
            if (retryAfter) {
                const seconds = parseInt(retryAfter, 10);
                // Only use reasonable values (max 5 minutes)
                if (!isNaN(seconds) && seconds > 0 && seconds <= 300) {
                    return seconds * 1000;
                }
            }
        }
    }

    return 0;
}

/**
 * Check if an error indicates a rate limit
 * Handles both string messages and Error objects (including OpenAI's RateLimitError)
 */
export function isRateLimitError(error: unknown): boolean {
    // Check Error object properties (OpenAI library)
    if (error && typeof error === "object") {
        const err = error as Record<string, unknown>;

        // Check status code
        if (err.status === 429) return true;

        // Check error code (OpenAI style)
        if (err.code === "RateLimitReached") return true;

        // Check error name
        if (err.name === "RateLimitError") return true;

        // Check constructor name
        if (err.constructor?.name === "RateLimitError") return true;
    }

    // Fallback to string matching
    const errorMessage = String(error).toLowerCase();
    return (
        errorMessage.includes("429") ||
        errorMessage.includes("ratelimitreached") ||
        errorMessage.includes("rate limit") ||
        errorMessage.includes("too many requests")
    );
}

/**
 * Sleep for a specified duration
 *
 * @param ms - Duration in milliseconds
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
