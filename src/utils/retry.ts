/**
 * Retry utilities for handling rate limits and transient failures
 */

import { logger } from "./logger.js";

/** Default maximum retry attempts */
export const DEFAULT_MAX_RETRIES = 5;

/** Default base delay for exponential backoff (ms) - 10s to handle 10/60s rate limits */
export const DEFAULT_BASE_DELAY_MS = 10000;

/** Default timeout for operations (ms) - 2 minutes */
export const DEFAULT_TIMEOUT_MS = 120000;

/** Options for retry behavior */
export interface RetryOptions {
    /** Maximum number of retry attempts (default: 5) */
    maxRetries?: number;
    /** Base delay in ms for exponential backoff (default: 10000) */
    baseDelay?: number;
    /** Timeout in ms for each attempt (default: 120000). Set to 0 to disable. */
    timeout?: number;
    /** Optional callback when retrying */
    onRetry?: (attempt: number, delay: number, error: Error) => void;
}

/**
 * Error thrown when an operation times out
 */
export class TimeoutError extends Error {
    constructor(
        message: string,
        public readonly timeoutMs: number
    ) {
        super(message);
        this.name = "TimeoutError";
    }
}

/**
 * Execute a function with a timeout using Promise.race pattern
 *
 * @param fn - The async function to execute (can optionally accept AbortSignal for cancellation)
 * @param timeoutMs - Timeout in milliseconds
 * @returns The result of the function
 * @throws TimeoutError if the operation times out
 */
export async function withTimeout<T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    timeoutMs: number
): Promise<T> {
    if (timeoutMs <= 0) {
        return fn();
    }

    const controller = new AbortController();

    // Create a timeout promise that rejects after the specified time
    const timeoutPromise = new Promise<never>((_, reject) => {
        const timeoutId = setTimeout(() => {
            controller.abort(); // Signal cancellation to the function if it supports it
            reject(new TimeoutError(`Operation timed out after ${timeoutMs}ms`, timeoutMs));
        }, timeoutMs);

        // Clean up timeout if the function completes first
        // We need to store the timeoutId for cleanup, but we can't do it here
        // Instead, we'll let the timeout be garbage collected
        controller.signal.addEventListener("abort", () => clearTimeout(timeoutId), { once: true });
    });

    // Race the function against the timeout
    try {
        return await Promise.race([fn(controller.signal), timeoutPromise]);
    } finally {
        // Cancel the timeout if function completed
        controller.abort();
    }
}

/**
 * Execute a function with retry logic and exponential backoff for rate limits
 *
 * @param fn - The async function to execute (can optionally accept AbortSignal for timeout support)
 * @param options - Retry configuration options
 * @returns The result of the function
 * @throws The last error if all retries are exhausted
 */
export async function executeWithRetry<T>(
    fn: ((signal?: AbortSignal) => Promise<T>) | (() => Promise<T>),
    options: RetryOptions = {}
): Promise<T> {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseDelay = options.baseDelay ?? DEFAULT_BASE_DELAY_MS;
    const timeout = options.timeout ?? 0; // Default: no timeout (0 = disabled)
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // Execute with optional timeout
            if (timeout > 0) {
                return await withTimeout(fn, timeout);
            }
            return await fn();
        } catch (error) {
            lastError = error as Error;

            // Check if it's a rate limit error or timeout error (retriable)
            const isRetriable = isRateLimitError(error) || error instanceof TimeoutError;

            if (isRetriable && attempt < maxRetries) {
                // Try to get retry-after from error, otherwise use exponential backoff
                const retryAfterMs = getRetryAfterMs(error);
                const exponentialDelay = baseDelay * Math.pow(2, attempt);
                // Use retry-after if valid, otherwise exponential backoff
                const delay = retryAfterMs > 0 ? retryAfterMs : exponentialDelay;

                if (options.onRetry) {
                    options.onRetry(attempt + 1, delay, lastError);
                } else {
                    const reason = error instanceof TimeoutError ? "Timeout" : "Rate limit hit";
                    logger.cli(
                        `${reason}, waiting ${delay / 1000}s before retry ${attempt + 1}/${maxRetries}...`,
                        "warn"
                    );
                }

                await sleep(delay);
                continue;
            }

            // For non-retriable errors, don't retry
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
