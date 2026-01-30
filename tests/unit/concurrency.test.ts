import { describe, expect, it } from "bun:test";

import { ConcurrencyLimiter } from "../../src/utils/concurrency.js";

describe("ConcurrencyLimiter", () => {
    describe("constructor", () => {
        it("should create limiter with valid maxConcurrency", () => {
            const limiter = new ConcurrencyLimiter(5);
            expect(limiter.limit).toBe(5);
        });

        it("should throw error for maxConcurrency < 1", () => {
            expect(() => new ConcurrencyLimiter(0)).toThrow("maxConcurrency must be at least 1");
            expect(() => new ConcurrencyLimiter(-1)).toThrow("maxConcurrency must be at least 1");
        });

        it("should report isSequential correctly", () => {
            expect(new ConcurrencyLimiter(1).isSequential).toBe(true);
            expect(new ConcurrencyLimiter(2).isSequential).toBe(false);
            expect(new ConcurrencyLimiter(5).isSequential).toBe(false);
        });
    });

    describe("schedule", () => {
        it("should execute single task immediately", async () => {
            const limiter = new ConcurrencyLimiter(1);
            const result = await limiter.schedule(async () => 42);
            expect(result).toBe(42);
        });

        it("should return task result", async () => {
            const limiter = new ConcurrencyLimiter(3);
            const result = await limiter.schedule(async () => ({ foo: "bar" }));
            expect(result).toEqual({ foo: "bar" });
        });

        it("should handle task errors", async () => {
            const limiter = new ConcurrencyLimiter(2);
            await expect(
                limiter.schedule(async () => {
                    throw new Error("Task failed");
                })
            ).rejects.toThrow("Task failed");
        });

        it("should track running count correctly", async () => {
            const limiter = new ConcurrencyLimiter(2);
            expect(limiter.runningCount).toBe(0);

            const promise = limiter.schedule(async () => {
                expect(limiter.runningCount).toBe(1);
                return "done";
            });

            await promise;
            expect(limiter.runningCount).toBe(0);
        });
    });

    describe("concurrency limiting", () => {
        it("should limit concurrent executions to maxConcurrency", async () => {
            const limiter = new ConcurrencyLimiter(2);
            let maxConcurrent = 0;
            let currentConcurrent = 0;

            const tasks = Array.from({ length: 5 }, (_, i) =>
                limiter.schedule(async () => {
                    currentConcurrent++;
                    maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
                    // Simulate async work
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    currentConcurrent--;
                    return i;
                })
            );

            await Promise.all(tasks);

            expect(maxConcurrent).toBe(2);
        });

        it("should process sequentially when maxConcurrency is 1", async () => {
            const limiter = new ConcurrencyLimiter(1);
            const order: number[] = [];

            const tasks = [1, 2, 3].map((n) =>
                limiter.schedule(async () => {
                    order.push(n);
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    return n;
                })
            );

            await Promise.all(tasks);

            expect(order).toEqual([1, 2, 3]);
        });

        it("should track queue length correctly", async () => {
            const limiter = new ConcurrencyLimiter(1);

            // Start a slow task
            const slowTask = limiter.schedule(async () => {
                await new Promise((resolve) => setTimeout(resolve, 50));
                return "slow";
            });

            // Queue more tasks while first is running
            await new Promise((resolve) => setTimeout(resolve, 5));
            const task2 = limiter.schedule(async () => "fast1");
            const task3 = limiter.schedule(async () => "fast2");

            // Check queue length (should have 2 waiting)
            expect(limiter.queueLength).toBeGreaterThanOrEqual(1);

            await Promise.all([slowTask, task2, task3]);
            expect(limiter.queueLength).toBe(0);
        });
    });

    describe("all", () => {
        it("should execute all tasks with concurrency limit", async () => {
            const limiter = new ConcurrencyLimiter(2);
            let maxConcurrent = 0;
            let currentConcurrent = 0;

            const tasks = [1, 2, 3, 4].map((n) => async () => {
                currentConcurrent++;
                maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
                await new Promise((resolve) => setTimeout(resolve, 10));
                currentConcurrent--;
                return n * 2;
            });

            const results = await limiter.all(tasks);

            expect(results).toEqual([2, 4, 6, 8]);
            expect(maxConcurrent).toBe(2);
        });

        it("should preserve order in results", async () => {
            const limiter = new ConcurrencyLimiter(3);

            const tasks = [100, 50, 10, 75].map((delay) => async () => {
                await new Promise((resolve) => setTimeout(resolve, delay));
                return delay;
            });

            const results = await limiter.all(tasks);

            // Results should be in input order, not completion order
            expect(results).toEqual([100, 50, 10, 75]);
        });

        it("should handle empty task array", async () => {
            const limiter = new ConcurrencyLimiter(5);
            const results = await limiter.all([]);
            expect(results).toEqual([]);
        });
    });

    describe("error handling", () => {
        it("should not block queue on task failure", async () => {
            const limiter = new ConcurrencyLimiter(1);
            const results: string[] = [];

            const task1 = limiter
                .schedule(async () => {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    throw new Error("First fails");
                })
                .catch(() => {
                    results.push("error1");
                });

            const task2 = limiter.schedule(async () => {
                results.push("success2");
                return "ok";
            });

            await Promise.all([task1, task2]);

            // Both should complete - error1 first (scheduled first), then success2
            expect(results).toContain("error1");
            expect(results).toContain("success2");
            expect(results.length).toBe(2);
        });

        it("should release slot even on error", async () => {
            const limiter = new ConcurrencyLimiter(2);

            // Start failing tasks
            const failingTasks = [1, 2].map(() =>
                limiter
                    .schedule(async () => {
                        await new Promise((resolve) => setTimeout(resolve, 5));
                        throw new Error("fail");
                    })
                    .catch(() => "caught")
            );

            await Promise.all(failingTasks);

            // Should be able to run new tasks after failures
            expect(limiter.runningCount).toBe(0);
            const result = await limiter.schedule(async () => "after-error");
            expect(result).toBe("after-error");
        });
    });
});
