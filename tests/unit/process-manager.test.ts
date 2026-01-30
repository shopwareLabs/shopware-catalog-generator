/**
 * Unit tests for server/process-manager module
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { ProcessManager } from "../../src/server/process-manager.js";
import { sleep } from "../../src/utils/retry.js";

describe("ProcessManager", () => {
    let manager: ProcessManager;

    beforeEach(() => {
        manager = new ProcessManager();
    });

    describe("generateId", () => {
        test("generates unique IDs", () => {
            const id1 = manager.generateId();
            const id2 = manager.generateId();

            expect(id1).not.toBe(id2);
            expect(id1).toMatch(/^proc_\d+_[a-z0-9]+$/);
            expect(id2).toMatch(/^proc_\d+_[a-z0-9]+$/);
        });

        test("ID starts with proc_ prefix", () => {
            const id = manager.generateId();
            expect(id.startsWith("proc_")).toBe(true);
        });
    });

    describe("start", () => {
        test("returns process ID", () => {
            const processId = manager.start("Test process", async () => {
                return "done";
            });

            expect(processId).toMatch(/^proc_\d+_[a-z0-9]+$/);
        });

        test("creates process in pending/running state", () => {
            const processId = manager.start("Test process", async () => {
                await sleep(100);
                return "done";
            });

            const state = manager.get(processId);
            expect(state).toBeDefined();
            if (state) {
                expect(["pending", "running"]).toContain(state.status);
            }
        });

        test("sets initial progress", () => {
            const processId = manager.start("Test process", async () => {
                return "done";
            });

            const state = manager.get(processId);
            expect(state?.progress).toEqual({
                phase: "initializing",
                current: 0,
                total: 0,
            });
        });

        test("sets process name", () => {
            const processId = manager.start("My Task Name", async () => {
                return "done";
            });

            const state = manager.get(processId);
            expect(state?.name).toBe("My Task Name");
        });

        test("sets startedAt timestamp", () => {
            const before = new Date();
            const processId = manager.start("Test", async () => "done");
            const after = new Date();

            const state = manager.get(processId);
            expect(state?.startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
            expect(state?.startedAt.getTime()).toBeLessThanOrEqual(after.getTime());
        });
    });

    describe("task execution", () => {
        test("task receives context with id", async () => {
            let receivedId: string | undefined;

            const processId = manager.start("Test", async (ctx) => {
                receivedId = ctx.id;
                return "done";
            });

            await sleep(50);
            expect(receivedId).toBe(processId);
        });

        test("task can log messages via context", async () => {
            const processId = manager.start("Test", async (ctx) => {
                ctx.log("First message");
                ctx.log("Second message");
                return "done";
            });

            await sleep(50);
            const logs = manager.getLogs(processId);
            expect(logs.some((l) => l.includes("First message"))).toBe(true);
            expect(logs.some((l) => l.includes("Second message"))).toBe(true);
        });

        test("task can update progress via context", async () => {
            const processId = manager.start("Test", async (ctx) => {
                ctx.setProgress("phase1", 1, 3);
                await sleep(10);
                ctx.setProgress("phase2", 2, 3);
                return "done";
            });

            await sleep(50);
            const state = manager.get(processId);
            // Should have final progress
            expect(state?.progress.phase).toBe("phase2");
            expect(state?.progress.current).toBe(2);
            expect(state?.progress.total).toBe(3);
        });

        test("completed task has status completed", async () => {
            const processId = manager.start("Test", async () => {
                return { success: true };
            });

            await sleep(50);
            const state = manager.get(processId);
            expect(state?.status).toBe("completed");
        });

        test("completed task has result", async () => {
            const processId = manager.start("Test", async () => {
                return { products: 90, categories: 52 };
            });

            await sleep(50);
            const state = manager.get(processId);
            expect(state?.result).toEqual({ products: 90, categories: 52 });
        });

        test("completed task has completedAt timestamp", async () => {
            const processId = manager.start("Test", async () => {
                await sleep(10); // Ensure some time passes
                return "done";
            });

            await sleep(50);
            const state = manager.get(processId);
            expect(state?.completedAt).toBeDefined();
            expect(state?.completedAt?.getTime()).toBeGreaterThanOrEqual(state?.startedAt.getTime() ?? 0);
        });

        test("failed task has status failed", async () => {
            const processId = manager.start("Test", async () => {
                throw new Error("Something went wrong");
            });

            await sleep(50);
            const state = manager.get(processId);
            expect(state?.status).toBe("failed");
        });

        test("failed task has error message", async () => {
            const processId = manager.start("Test", async () => {
                throw new Error("Authentication failed");
            });

            await sleep(50);
            const state = manager.get(processId);
            expect(state?.error).toBe("Authentication failed");
        });

        test("failed task has completedAt timestamp", async () => {
            const processId = manager.start("Test", async () => {
                throw new Error("Failed");
            });

            await sleep(50);
            const state = manager.get(processId);
            expect(state?.completedAt).toBeDefined();
        });
    });

    describe("get", () => {
        test("returns process state by ID", () => {
            const processId = manager.start("Test", async () => "done");
            const state = manager.get(processId);

            expect(state).toBeDefined();
            expect(state?.id).toBe(processId);
        });

        test("returns undefined for unknown ID", () => {
            const state = manager.get("proc_unknown_123456");
            expect(state).toBeUndefined();
        });
    });

    describe("getActive", () => {
        test("returns empty array when no processes", () => {
            expect(manager.getActive()).toEqual([]);
        });

        test("returns running processes", async () => {
            const processId = manager.start("Test", async () => {
                await sleep(100);
                return "done";
            });

            const active = manager.getActive();
            expect(active.length).toBe(1);
            if (active[0]) {
                expect(active[0].id).toBe(processId);
            }
        });

        test("excludes completed processes", async () => {
            manager.start("Fast", async () => "done");
            await sleep(50);

            const active = manager.getActive();
            expect(active.length).toBe(0);
        });

        test("excludes failed processes", async () => {
            manager.start("Failing", async () => {
                throw new Error("Fail");
            });
            await sleep(50);

            const active = manager.getActive();
            expect(active.length).toBe(0);
        });
    });

    describe("getLogs", () => {
        test("returns empty array for unknown process", () => {
            expect(manager.getLogs("proc_unknown_123")).toEqual([]);
        });

        test("returns all logs by default", async () => {
            const processId = manager.start("Test", async (ctx) => {
                ctx.log("Message 1");
                ctx.log("Message 2");
                ctx.log("Message 3");
                return "done";
            });

            await sleep(50);
            const logs = manager.getLogs(processId);
            // Includes system logs (Starting, Completed) + user logs
            expect(logs.length).toBeGreaterThanOrEqual(3);
        });

        test("returns logs from offset", async () => {
            const processId = manager.start("Test", async (ctx) => {
                ctx.log("A");
                ctx.log("B");
                ctx.log("C");
                return "done";
            });

            await sleep(50);
            const allLogs = manager.getLogs(processId);
            const fromOffset = manager.getLogs(processId, 2);

            expect(fromOffset.length).toBe(allLogs.length - 2);
        });

        test("logs have timestamp prefix", async () => {
            const processId = manager.start("Test", async (ctx) => {
                ctx.log("Test message");
                return "done";
            });

            await sleep(50);
            const logs = manager.getLogs(processId);
            // Format: [HH:MM:SS] message
            expect(logs.every((l) => /^\[\d{2}:\d{2}:\d{2}\]/.test(l))).toBe(true);
        });
    });

    describe("has", () => {
        test("returns true for existing process", () => {
            const processId = manager.start("Test", async () => "done");
            expect(manager.has(processId)).toBe(true);
        });

        test("returns false for unknown process", () => {
            expect(manager.has("proc_unknown_123")).toBe(false);
        });
    });

    describe("getStats", () => {
        test("returns zero stats when empty", () => {
            expect(manager.getStats()).toEqual({
                total: 0,
                active: 0,
                completed: 0,
                failed: 0,
            });
        });

        test("counts active processes", () => {
            manager.start("Test", async () => {
                await sleep(100);
                return "done";
            });

            const stats = manager.getStats();
            expect(stats.active).toBe(1);
            expect(stats.total).toBe(1);
        });

        test("counts completed processes", async () => {
            manager.start("Test", async () => "done");
            await sleep(50);

            const stats = manager.getStats();
            expect(stats.completed).toBe(1);
            expect(stats.active).toBe(0);
        });

        test("counts failed processes", async () => {
            manager.start("Test", async () => {
                throw new Error("Fail");
            });
            await sleep(50);

            const stats = manager.getStats();
            expect(stats.failed).toBe(1);
            expect(stats.completed).toBe(0);
        });

        test("counts multiple processes correctly", async () => {
            // Start a long-running process
            manager.start("Running", async () => {
                await sleep(200);
                return "done";
            });

            // Start and complete a process
            manager.start("Completed", async () => "done");

            // Start and fail a process
            manager.start("Failed", async () => {
                throw new Error("Fail");
            });

            await sleep(50);

            const stats = manager.getStats();
            expect(stats.total).toBe(3);
            expect(stats.active).toBe(1);
            expect(stats.completed).toBe(1);
            expect(stats.failed).toBe(1);
        });
    });

    describe("log trimming", () => {
        test("trims logs when exceeding max", async () => {
            const processId = manager.start("Test", async (ctx) => {
                // Log more than MAX_LOGS (1000)
                for (let i = 0; i < 1010; i++) {
                    ctx.log(`Message ${i}`);
                }
                return "done";
            });

            await sleep(100);
            const logs = manager.getLogs(processId);
            // Should be trimmed to MAX_LOGS (1000)
            expect(logs.length).toBeLessThanOrEqual(1000);
        });
    });
});
