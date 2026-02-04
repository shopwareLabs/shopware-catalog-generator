import { describe, expect, mock, test } from "bun:test";

import {
    DEFAULT_BASE_DELAY_MS,
    DEFAULT_MAX_RETRIES,
    DEFAULT_TIMEOUT_MS,
    executeWithRetry,
    getRetryAfterMs,
    isRateLimitError,
    sleep,
    TimeoutError,
    withTimeout,
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

    describe("withTimeout", () => {
        test("returns result when function completes before timeout", async () => {
            const fn = async () => {
                await sleep(10);
                return "success";
            };

            const result = await withTimeout(fn, 1000);
            expect(result).toBe("success");
        });

        test("throws TimeoutError when function exceeds timeout", async () => {
            const fn = async () => {
                await sleep(500);
                return "should not reach";
            };

            await expect(withTimeout(fn, 50)).rejects.toThrow(TimeoutError);
        });

        test("TimeoutError contains timeout duration", async () => {
            const fn = async () => {
                await sleep(500);
                return "should not reach";
            };

            try {
                await withTimeout(fn, 50);
                expect(true).toBe(false); // Should not reach
            } catch (error) {
                expect(error).toBeInstanceOf(TimeoutError);
                if (error instanceof TimeoutError) {
                    expect(error.timeoutMs).toBe(50);
                    expect(error.message).toContain("50ms");
                }
            }
        });

        test("skips timeout when timeoutMs is 0", async () => {
            const fn = async () => {
                await sleep(10);
                return "success";
            };

            const result = await withTimeout(fn, 0);
            expect(result).toBe("success");
        });

        test("skips timeout when timeoutMs is negative", async () => {
            const fn = async () => {
                await sleep(10);
                return "success";
            };

            const result = await withTimeout(fn, -1);
            expect(result).toBe("success");
        });

        test("passes AbortSignal to function", async () => {
            let receivedSignal: AbortSignal | undefined;
            const fn = async (signal?: AbortSignal) => {
                receivedSignal = signal;
                return "success";
            };

            await withTimeout(fn, 1000);
            expect(receivedSignal).toBeDefined();
            expect(receivedSignal).toBeInstanceOf(AbortSignal);
        });
    });

    describe("executeWithRetry with timeout", () => {
        test("retries on timeout errors", async () => {
            let attempts = 0;
            const fn = async () => {
                attempts++;
                if (attempts < 2) {
                    await sleep(200); // Will timeout
                }
                return "success";
            };

            const result = await executeWithRetry(fn, {
                maxRetries: 3,
                baseDelay: 10,
                timeout: 50, // Very short timeout
            });

            expect(result).toBe("success");
            expect(attempts).toBe(2);
        });

        test("throws after max retries on persistent timeout", async () => {
            const fn = async () => {
                await sleep(200); // Always times out
                return "should not reach";
            };

            await expect(
                executeWithRetry(fn, {
                    maxRetries: 2,
                    baseDelay: 10,
                    timeout: 50,
                })
            ).rejects.toThrow(TimeoutError);
        });

        test("does not apply timeout when timeout is 0", async () => {
            const fn = mock(async () => {
                await sleep(10);
                return "success";
            });

            const result = await executeWithRetry(fn, {
                maxRetries: 1,
                timeout: 0,
            });

            expect(result).toBe("success");
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });

    describe("DEFAULT_TIMEOUT_MS", () => {
        test("DEFAULT_TIMEOUT_MS is 120000 (2 minutes)", () => {
            expect(DEFAULT_TIMEOUT_MS).toBe(120000);
        });
    });

    describe("TimeoutError", () => {
        test("has correct name", () => {
            const error = new TimeoutError("test", 1000);
            expect(error.name).toBe("TimeoutError");
        });

        test("has correct message", () => {
            const error = new TimeoutError("test message", 1000);
            expect(error.message).toBe("test message");
        });

        test("has timeoutMs property", () => {
            const error = new TimeoutError("test", 5000);
            expect(error.timeoutMs).toBe(5000);
        });
    });
});
