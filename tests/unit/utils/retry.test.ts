import { describe, expect, mock, test } from "bun:test";

import {
    DEFAULT_BASE_DELAY_MS,
    DEFAULT_MAX_RETRIES,
    executeWithRetry,
    getRetryAfterMs,
    isRateLimitError,
    sleep,
} from "../../../src/utils/retry.js";

describe("retry utilities", () => {
    describe("isRateLimitError", () => {
        test("returns true for 429 status code", () => {
            expect(isRateLimitError("Error: 429 Too Many Requests")).toBe(true);
        });

        test("returns true for RateLimitReached", () => {
            expect(isRateLimitError("RateLimitReached: Exceeded quota")).toBe(true);
        });

        test("returns true for rate limit message", () => {
            expect(isRateLimitError("You have hit the rate limit")).toBe(true);
        });

        test("returns true for too many requests", () => {
            expect(isRateLimitError("Error: too many requests")).toBe(true);
        });

        test("returns false for other errors", () => {
            expect(isRateLimitError("Network error")).toBe(false);
            expect(isRateLimitError("Internal server error")).toBe(false);
            expect(isRateLimitError("Not found")).toBe(false);
        });

        test("is case insensitive", () => {
            expect(isRateLimitError("RATELIMITREACHED")).toBe(true);
            expect(isRateLimitError("Rate Limit exceeded")).toBe(true);
        });

        test("detects OpenAI RateLimitError by status", () => {
            const error = { status: 429, message: "Rate limit exceeded" };
            expect(isRateLimitError(error)).toBe(true);
        });

        test("detects OpenAI RateLimitError by code", () => {
            const error = { code: "RateLimitReached", message: "Limit hit" };
            expect(isRateLimitError(error)).toBe(true);
        });

        test("detects error by constructor name", () => {
            class RateLimitError extends Error {
                constructor() {
                    super("Rate limit");
                }
            }
            expect(isRateLimitError(new RateLimitError())).toBe(true);
        });

        test("handles null and undefined", () => {
            expect(isRateLimitError(null)).toBe(false);
            expect(isRateLimitError(undefined)).toBe(false);
        });
    });

    describe("sleep", () => {
        test("resolves after specified duration", async () => {
            const start = Date.now();
            await sleep(50);
            const elapsed = Date.now() - start;
            expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some timing variance
        });
    });

    describe("executeWithRetry", () => {
        test("returns result on first success", async () => {
            const fn = mock(() => Promise.resolve("success"));

            const result = await executeWithRetry(fn);

            expect(result).toBe("success");
            expect(fn).toHaveBeenCalledTimes(1);
        });

        test("does not retry on non-rate-limit errors", async () => {
            const fn = mock(() => Promise.reject(new Error("Some error")));

            await expect(executeWithRetry(fn)).rejects.toThrow("Some error");
            expect(fn).toHaveBeenCalledTimes(1);
        });

        test("retries on rate limit errors", async () => {
            let attempts = 0;
            // Simulate error with retry-after header to use short delay
            const fn = mock(() => {
                attempts++;
                if (attempts < 2) {
                    const error = Object.assign(new Error("429 Too Many Requests"), {
                        headers: { "retry-after": "0.01" }, // Very short for testing
                    });
                    return Promise.reject(error);
                }
                return Promise.resolve("success");
            });

            const result = await executeWithRetry(fn, { maxRetries: 3, baseDelay: 10 });

            expect(result).toBe("success");
            expect(fn).toHaveBeenCalledTimes(2);
        });

        test("respects maxRetries option", async () => {
            // Use error with retry-after header to speed up test
            const fn = mock(() => {
                const error = Object.assign(new Error("429 Rate limit"), {
                    headers: { "retry-after": "0.01" },
                });
                return Promise.reject(error);
            });

            await expect(executeWithRetry(fn, { maxRetries: 2, baseDelay: 10 })).rejects.toThrow(
                "429 Rate limit"
            );

            expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
        });

        test("calls onRetry callback when retrying", async () => {
            let attempts = 0;
            const fn = mock(() => {
                attempts++;
                if (attempts < 2) {
                    return Promise.reject(new Error("429"));
                }
                return Promise.resolve("success");
            });

            const onRetry = mock();

            await executeWithRetry(fn, {
                maxRetries: 3,
                baseDelay: 10,
                onRetry,
            });

            expect(onRetry).toHaveBeenCalledTimes(1);
            const [attempt, delay, error] = onRetry.mock.calls[0] ?? [];
            expect(attempt).toBe(1);
            expect(delay).toBe(10);
            expect(error).toBeInstanceOf(Error);
        });

        test("uses exponential backoff", async () => {
            let attempts = 0;
            const delays: number[] = [];
            const fn = mock(() => {
                attempts++;
                if (attempts < 4) {
                    return Promise.reject(new Error("RateLimitReached"));
                }
                return Promise.resolve("success");
            });

            await executeWithRetry(fn, {
                maxRetries: 5,
                baseDelay: 100,
                onRetry: (_attempt, delay) => {
                    delays.push(delay);
                },
            });

            // Delays should be: 100, 200, 400 (exponential backoff)
            expect(delays).toEqual([100, 200, 400]);
        });

        test("retries on OpenAI-style rate limit errors", async () => {
            let attempts = 0;
            const fn = mock(() => {
                attempts++;
                if (attempts < 2) {
                    // Simulate OpenAI RateLimitError
                    const error = Object.assign(new Error("Rate limit exceeded"), {
                        status: 429,
                        code: "RateLimitReached",
                    });
                    return Promise.reject(error);
                }
                return Promise.resolve("success");
            });

            const result = await executeWithRetry(fn, { maxRetries: 3, baseDelay: 10 });

            expect(result).toBe("success");
            expect(fn).toHaveBeenCalledTimes(2);
        });
    });

    describe("default constants", () => {
        test("DEFAULT_MAX_RETRIES is 5", () => {
            expect(DEFAULT_MAX_RETRIES).toBe(5);
        });

        test("DEFAULT_BASE_DELAY_MS is 10000 (10s for rate limits)", () => {
            expect(DEFAULT_BASE_DELAY_MS).toBe(10000);
        });
    });

    describe("getRetryAfterMs", () => {
        test("extracts retry-after header in seconds", () => {
            const error = {
                headers: { "retry-after": "30" },
            };
            expect(getRetryAfterMs(error)).toBe(30000);
        });

        test("returns 0 for missing headers", () => {
            expect(getRetryAfterMs({})).toBe(0);
            expect(getRetryAfterMs({ headers: {} })).toBe(0);
        });

        test("returns 0 for invalid retry-after value", () => {
            const error = { headers: { "retry-after": "invalid" } };
            expect(getRetryAfterMs(error)).toBe(0);
        });

        test("returns 0 for retry-after of 0", () => {
            const error = { headers: { "retry-after": "0" } };
            expect(getRetryAfterMs(error)).toBe(0);
        });

        test("returns 0 for unreasonably large retry-after (>5min)", () => {
            // Ignore values > 300s to avoid waiting hours for daily limits
            const error = { headers: { "retry-after": "3600" } };
            expect(getRetryAfterMs(error)).toBe(0);
        });

        test("accepts retry-after up to 5 minutes", () => {
            const error = { headers: { "retry-after": "300" } };
            expect(getRetryAfterMs(error)).toBe(300000);
        });

        test("handles null and undefined", () => {
            expect(getRetryAfterMs(null)).toBe(0);
            expect(getRetryAfterMs(undefined)).toBe(0);
        });
    });
});
