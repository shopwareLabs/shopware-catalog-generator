import { describe, expect, mock, test } from "bun:test";

import type { PostProcessorContext } from "../../../src/post-processors/index.js";

import {
    cleanupProcessors,
    DEFAULT_PROCESSOR_OPTIONS,
    ImageProcessor,
    ManufacturerProcessor,
    ReviewProcessor,
    registry,
    runProcessors,
    TestingProcessor,
    VariantProcessor,
    VideoProcessor,
} from "../../../src/post-processors/index.js";
import { ShopwareCapabilities } from "../../../src/shopware/version.js";
import { logger } from "../../../src/utils/index.js";
import { TEST_SHOPWARE_VERSION } from "../../helpers/post-processor-context.js";
import { MockApiHelpers } from "../../mocks/index.js";

// Mock context for testing
function createMockContext(): PostProcessorContext {
    return {
        salesChannelId: "test-sc-id",
        salesChannelName: "test-store",
        blueprint: {
            version: "1.0",
            createdAt: new Date().toISOString(),
            hydratedAt: new Date().toISOString(),
            salesChannel: {
                name: "test-store",
                description: "Test store",
            },
            categories: [],
            products: [],
            propertyGroups: [],
        },
        cache: {} as PostProcessorContext["cache"],
        api: new MockApiHelpers(),
        shopware: ShopwareCapabilities.fromVersion(TEST_SHOPWARE_VERSION),
        options: {
            batchSize: 5,
            dryRun: false,
        },
    };
}

describe("PostProcessor Registry", () => {
    test("has all processors registered", () => {
        const names = registry.getNames();

        // CMS element processors
        expect(names).toContain("cms-text");
        expect(names).toContain("cms-images");
        expect(names).toContain("cms-video");
        expect(names).toContain("cms-text-images");
        expect(names).toContain("cms-commerce");
        expect(names).toContain("cms-form");
        expect(names).toContain("cms-footer-pages");
        expect(names).toContain("cms-testing");
        // Other processors
        expect(names).toContain("images");
        expect(names).toContain("manufacturers");
        expect(names).toContain("reviews");
        expect(names).toContain("variants");
    });

    test("can get processor by name", () => {
        const imageProcessor = registry.get("images");
        expect(imageProcessor).toBeDefined();
        expect(imageProcessor?.name).toBe("images");

        const manufacturerProcessor = registry.get("manufacturers");
        expect(manufacturerProcessor).toBeDefined();
        expect(manufacturerProcessor?.name).toBe("manufacturers");
    });

    test("returns undefined for unknown processor", () => {
        const unknown = registry.get("unknown-processor");
        expect(unknown).toBeUndefined();
    });

    test("has correct processor descriptions", () => {
        const imageProcessor = registry.get("images");
        expect(imageProcessor?.description).toContain("image");

        const manufacturerProcessor = registry.get("manufacturers");
        expect(manufacturerProcessor?.description).toContain("manufacturer");
    });

    test("getAll returns all processors", () => {
        const all = registry.getAll();
        // 9 CMS processors + 12 other processors = 21 total
        expect(all.length).toBe(21);
        expect(all.map((p) => p.name)).toContain("variant-images");
        expect(all.map((p) => p.name)).toContain("media-product");
        expect(all.map((p) => p.name)).toContain("cms-video");
        expect(all.map((p) => p.name)).toContain("cms-footer-pages");
        expect(all.map((p) => p.name)).toContain("cms-testing");
        expect(all.map((p) => p.name)).toContain("cross-selling");
        expect(all.map((p) => p.name)).toContain("digital-product");
        expect(all.map((p) => p.name)).toContain("images");
        expect(all.map((p) => p.name)).toContain("manufacturers");
        expect(all.map((p) => p.name)).toContain("reviews");
        expect(all.map((p) => p.name)).toContain("variants");
    });

    test("has method works correctly", () => {
        expect(registry.has("images")).toBe(true);
        expect(registry.has("manufacturers")).toBe(true);
        expect(registry.has("nonexistent")).toBe(false);
    });
});

describe("PostProcessor Dependencies", () => {
    test("video processor has no dependencies", () => {
        expect(VideoProcessor.dependsOn).toEqual([]);
    });

    test("testing processor depends on all element processors", () => {
        expect(TestingProcessor.dependsOn).toContain("cms-text");
        expect(TestingProcessor.dependsOn).toContain("cms-images");
        expect(TestingProcessor.dependsOn).toContain("cms-video");
        expect(TestingProcessor.dependsOn).toContain("cms-text-images");
        expect(TestingProcessor.dependsOn).toContain("cms-commerce");
        expect(TestingProcessor.dependsOn).toContain("cms-form");
    });

    test("images processor has no dependencies", () => {
        expect(ImageProcessor.dependsOn).toEqual([]);
    });

    test("manufacturers processor has no dependencies", () => {
        expect(ManufacturerProcessor.dependsOn).toEqual([]);
    });

    test("reviews processor has no dependencies", () => {
        expect(ReviewProcessor.dependsOn).toEqual([]);
    });

    test("variants processor depends on manufacturers", () => {
        expect(VariantProcessor.dependsOn).toContain("manufacturers");
    });
});

describe("PostProcessor Options", () => {
    test("DEFAULT_PROCESSOR_OPTIONS has batchSize", () => {
        expect(DEFAULT_PROCESSOR_OPTIONS.batchSize).toBe(5);
    });

    test("DEFAULT_PROCESSOR_OPTIONS has dryRun false", () => {
        expect(DEFAULT_PROCESSOR_OPTIONS.dryRun).toBe(false);
    });
});

describe("PostProcessor Interface", () => {
    test("all processors have required properties", () => {
        const processors = registry.getAll();

        for (const processor of processors) {
            expect(typeof processor.name).toBe("string");
            expect(processor.name.length).toBeGreaterThan(0);

            expect(typeof processor.description).toBe("string");
            expect(processor.description.length).toBeGreaterThan(0);

            expect(Array.isArray(processor.dependsOn)).toBe(true);

            expect(typeof processor.process).toBe("function");
        }
    });

    test("processor names are unique", () => {
        const names = registry.getNames();
        const uniqueNames = new Set(names);
        expect(uniqueNames.size).toBe(names.length);
    });
});

describe("runProcessors", () => {
    test("throws error for unknown processor", async () => {
        logger.setMcpMode(true);
        const context = createMockContext();

        await expect(runProcessors(context, ["unknown-processor"])).rejects.toThrow(
            /Unknown processor/
        );

        logger.setMcpMode(false);
    });

    test("returns empty array for empty selection", async () => {
        logger.setMcpMode(true);
        const context = createMockContext();

        const results = await runProcessors(context, []);

        expect(results).toEqual([]);
        logger.setMcpMode(false);
    });

    test("clears the shop cache once after all processors", async () => {
        logger.setMcpMode(true);
        const context = createMockContext();

        await runProcessors(context, []);

        const api = context.api as MockApiHelpers;
        expect(api.getCallsByMethod("httpDelete").map((c) => c.endpoint)).toEqual([
            "_action/cache",
        ]);
        logger.setMcpMode(false);
    });

    test("keeps the shop cache on a dry run and survives a failed clear", async () => {
        logger.setMcpMode(true);
        const dryRun = createMockContext();
        dryRun.options.dryRun = true;
        await runProcessors(dryRun, []);
        expect((dryRun.api as MockApiHelpers).getCallsByMethod("httpDelete")).toEqual([]);

        const failing = createMockContext();
        failing.api.httpDelete = async () => {
            throw new Error("403");
        };
        await expect(runProcessors(failing, [])).resolves.toEqual([]);
        logger.setMcpMode(false);
    });

    test("catches processor errors and returns error result", async () => {
        logger.setMcpMode(true);
        const context = createMockContext();

        // Create a mock processor that throws
        const errorProcessor = {
            name: "error-test",
            description: "Test processor that throws",
            dependsOn: [],
            process: mock(async () => {
                throw new Error("Test error");
            }),
        };

        // Temporarily register the error processor
        const originalGet = registry.get.bind(registry);
        const originalHas = registry.has.bind(registry);
        const originalGetAll = registry.getAll.bind(registry);

        registry.get = (name: string) => {
            if (name === "error-test") return errorProcessor;
            return originalGet(name);
        };
        registry.has = (name: string) => {
            if (name === "error-test") return true;
            return originalHas(name);
        };
        registry.getAll = () => [...originalGetAll(), errorProcessor];

        const results = await runProcessors(context, ["error-test"]);

        expect(results.length).toBe(1);
        const result = results[0];
        if (!result) throw new Error("Expected result");
        expect(result.name).toBe("error-test");
        expect(result.errors).toContain("Test error");
        expect(result.processed).toBe(0);

        // Restore original methods
        registry.get = originalGet;
        registry.has = originalHas;
        registry.getAll = originalGetAll;
        logger.setMcpMode(false);
    });

    test("runs processors in dependency order", async () => {
        logger.setMcpMode(true);
        const context = createMockContext();

        const executionOrder: string[] = [];

        const firstProcessor = {
            name: "first-test",
            description: "First processor",
            dependsOn: [],
            process: mock(async () => {
                executionOrder.push("first-test");
                return { name: "first-test", processed: 1, skipped: 0, errors: [], durationMs: 0 };
            }),
        };

        const secondProcessor = {
            name: "second-test",
            description: "Second processor (depends on first)",
            dependsOn: ["first-test"],
            process: mock(async () => {
                executionOrder.push("second-test");
                return { name: "second-test", processed: 1, skipped: 0, errors: [], durationMs: 0 };
            }),
        };

        // Mock registry methods
        const originalGet = registry.get.bind(registry);
        const originalHas = registry.has.bind(registry);
        const originalGetAll = registry.getAll.bind(registry);

        registry.get = (name: string) => {
            if (name === "first-test") return firstProcessor;
            if (name === "second-test") return secondProcessor;
            return originalGet(name);
        };
        registry.has = (name: string) => {
            if (name === "first-test" || name === "second-test") return true;
            return originalHas(name);
        };
        registry.getAll = () => [...originalGetAll(), firstProcessor, secondProcessor];

        const results = await runProcessors(context, ["second-test", "first-test"]);

        expect(results.length).toBe(2);
        expect(executionOrder[0]).toBe("first-test");
        expect(executionOrder[1]).toBe("second-test");

        // Restore
        registry.get = originalGet;
        registry.has = originalHas;
        registry.getAll = originalGetAll;
        logger.setMcpMode(false);
    });

    test("runs independent processors in parallel batches", async () => {
        logger.setMcpMode(true);
        const context = createMockContext();

        const processorA = {
            name: "parallel-a",
            description: "Parallel A",
            dependsOn: [],
            process: mock(async () => {
                return { name: "parallel-a", processed: 1, skipped: 0, errors: [], durationMs: 0 };
            }),
        };

        const processorB = {
            name: "parallel-b",
            description: "Parallel B",
            dependsOn: [],
            process: mock(async () => {
                return { name: "parallel-b", processed: 1, skipped: 0, errors: [], durationMs: 0 };
            }),
        };

        // Mock registry methods
        const originalGet = registry.get.bind(registry);
        const originalHas = registry.has.bind(registry);
        const originalGetAll = registry.getAll.bind(registry);

        registry.get = (name: string) => {
            if (name === "parallel-a") return processorA;
            if (name === "parallel-b") return processorB;
            return originalGet(name);
        };
        registry.has = (name: string) => {
            if (name === "parallel-a" || name === "parallel-b") return true;
            return originalHas(name);
        };
        registry.getAll = () => [...originalGetAll(), processorA, processorB];

        const results = await runProcessors(context, ["parallel-a", "parallel-b"]);

        expect(results.length).toBe(2);
        expect(processorA.process).toHaveBeenCalled();
        expect(processorB.process).toHaveBeenCalled();

        // Restore
        registry.get = originalGet;
        registry.has = originalHas;
        registry.getAll = originalGetAll;
        logger.setMcpMode(false);
    });
});

describe("cleanupProcessors", () => {
    test("throws error for unknown processor", async () => {
        logger.setMcpMode(true);
        const context = createMockContext();

        await expect(cleanupProcessors(context, ["unknown-processor"])).rejects.toThrow(
            /Unknown processor/
        );

        logger.setMcpMode(false);
    });

    test("returns empty array when no processors have cleanup", async () => {
        logger.setMcpMode(true);
        const context = createMockContext();

        const noCleanupProcessor = {
            name: "no-cleanup-test",
            description: "Processor without cleanup",
            dependsOn: [],
            process: mock(async () => ({
                name: "no-cleanup-test",
                processed: 0,
                skipped: 0,
                errors: [],
                durationMs: 0,
            })),
            // No cleanup method
        };

        const originalGet = registry.get.bind(registry);
        const originalHas = registry.has.bind(registry);

        registry.get = (name: string) => {
            if (name === "no-cleanup-test") return noCleanupProcessor;
            return originalGet(name);
        };
        registry.has = (name: string) => {
            if (name === "no-cleanup-test") return true;
            return originalHas(name);
        };

        const results = await cleanupProcessors(context, ["no-cleanup-test"]);

        expect(results).toEqual([]);

        registry.get = originalGet;
        registry.has = originalHas;
        logger.setMcpMode(false);
    });

    test("runs cleanup for processors with cleanup method", async () => {
        logger.setMcpMode(true);
        const context = createMockContext();

        const cleanupProcessor = {
            name: "cleanup-test",
            description: "Processor with cleanup",
            dependsOn: [],
            process: mock(async () => ({
                name: "cleanup-test",
                processed: 0,
                skipped: 0,
                errors: [],
                durationMs: 0,
            })),
            cleanup: mock(async () => ({
                name: "cleanup-test",
                deleted: 5,
                errors: [],
                durationMs: 0,
            })),
        };

        const originalGet = registry.get.bind(registry);
        const originalHas = registry.has.bind(registry);

        registry.get = (name: string) => {
            if (name === "cleanup-test") return cleanupProcessor;
            return originalGet(name);
        };
        registry.has = (name: string) => {
            if (name === "cleanup-test") return true;
            return originalHas(name);
        };

        const results = await cleanupProcessors(context, ["cleanup-test"]);

        expect(results.length).toBe(1);
        const result = results[0];
        if (!result) throw new Error("Expected cleanup result");
        expect(result.name).toBe("cleanup-test");
        expect(result.deleted).toBe(5);
        expect(cleanupProcessor.cleanup).toHaveBeenCalled();

        registry.get = originalGet;
        registry.has = originalHas;
        logger.setMcpMode(false);
    });

    test("catches cleanup errors and returns error result", async () => {
        logger.setMcpMode(true);
        const context = createMockContext();

        const errorCleanupProcessor = {
            name: "error-cleanup-test",
            description: "Processor with failing cleanup",
            dependsOn: [],
            process: mock(async () => ({
                name: "error-cleanup-test",
                processed: 0,
                skipped: 0,
                errors: [],
                durationMs: 0,
            })),
            cleanup: mock(async () => {
                throw new Error("Cleanup failed");
            }),
        };

        const originalGet = registry.get.bind(registry);
        const originalHas = registry.has.bind(registry);

        registry.get = (name: string) => {
            if (name === "error-cleanup-test") return errorCleanupProcessor;
            return originalGet(name);
        };
        registry.has = (name: string) => {
            if (name === "error-cleanup-test") return true;
            return originalHas(name);
        };

        const results = await cleanupProcessors(context, ["error-cleanup-test"]);

        expect(results.length).toBe(1);
        const result = results[0];
        if (!result) throw new Error("Expected error cleanup result");
        expect(result.name).toBe("error-cleanup-test");
        expect(result.errors).toContain("Cleanup failed");
        expect(result.deleted).toBe(0);

        registry.get = originalGet;
        registry.has = originalHas;
        logger.setMcpMode(false);
    });

    test("handles cleanup with errors in result", async () => {
        logger.setMcpMode(true);
        const context = createMockContext();

        const partialErrorProcessor = {
            name: "partial-error-test",
            description: "Processor with partial cleanup errors",
            dependsOn: [],
            process: mock(async () => ({
                name: "partial-error-test",
                processed: 0,
                skipped: 0,
                errors: [],
                durationMs: 0,
            })),
            cleanup: mock(async () => ({
                name: "partial-error-test",
                deleted: 3,
                errors: ["Failed to delete item 1", "Failed to delete item 2"],
                durationMs: 0,
            })),
        };

        const originalGet = registry.get.bind(registry);
        const originalHas = registry.has.bind(registry);

        registry.get = (name: string) => {
            if (name === "partial-error-test") return partialErrorProcessor;
            return originalGet(name);
        };
        registry.has = (name: string) => {
            if (name === "partial-error-test") return true;
            return originalHas(name);
        };

        const results = await cleanupProcessors(context, ["partial-error-test"]);

        expect(results.length).toBe(1);
        const result = results[0];
        if (!result) throw new Error("Expected partial error result");
        expect(result.deleted).toBe(3);
        expect(result.errors.length).toBe(2);

        registry.get = originalGet;
        registry.has = originalHas;
        logger.setMcpMode(false);
    });
});

describe("runProcessors ordering (characterization)", () => {
    interface FakeResult {
        name: string;
        processed: number;
        skipped: number;
        errors: string[];
        durationMs: number;
    }

    interface FakeProcessor {
        name: string;
        description: string;
        dependsOn: string[];
        process: (context: PostProcessorContext) => Promise<FakeResult>;
    }

    /** Swap the registry for fake processors while running fn */
    async function withFakeProcessors<T>(fakes: FakeProcessor[], fn: () => Promise<T>): Promise<T> {
        const originalGet = registry.get.bind(registry);
        const originalHas = registry.has.bind(registry);
        const originalGetAll = registry.getAll.bind(registry);
        const byName = new Map(fakes.map((f) => [f.name, f]));
        registry.get = (name: string) => byName.get(name) ?? originalGet(name);
        registry.has = (name: string) => byName.has(name) || originalHas(name);
        registry.getAll = () => [...originalGetAll(), ...fakes];
        logger.setMcpMode(true);
        try {
            return await fn();
        } finally {
            registry.get = originalGet;
            registry.has = originalHas;
            registry.getAll = originalGetAll;
            logger.setMcpMode(false);
        }
    }

    /** Fake processor that records start/end events */
    function fake(name: string, dependsOn: string[], events: string[]): FakeProcessor {
        return {
            name,
            description: name,
            dependsOn,
            process: async () => {
                events.push(`start:${name}`);
                await Promise.resolve();
                events.push(`end:${name}`);
                return { name, processed: 1, skipped: 0, errors: [], durationMs: 0 };
            },
        };
    }

    test("throws on circular dependencies without running anything", async () => {
        const events: string[] = [];
        const a = fake("cycle-a", ["cycle-b"], events);
        const b = fake("cycle-b", ["cycle-a"], events);

        await withFakeProcessors([a, b], async () => {
            await expect(
                runProcessors(createMockContext(), ["cycle-a", "cycle-b"])
            ).rejects.toThrow("Circular dependency detected in processors");
        });
        expect(events).toEqual([]);
    });

    test("ignores dependencies that are not selected", async () => {
        const events: string[] = [];
        const a = fake("dep-missing-a", ["dep-missing-b"], events);
        const c = fake("dep-missing-c", [], events);

        const results = await withFakeProcessors([a, c], () =>
            runProcessors(createMockContext(), ["dep-missing-a", "dep-missing-c"])
        );

        expect(results.map((r) => r.name)).toEqual(["dep-missing-a", "dep-missing-c"]);
        // Both run in one parallel batch
        expect(events).toEqual([
            "start:dep-missing-a",
            "start:dep-missing-c",
            "end:dep-missing-a",
            "end:dep-missing-c",
        ]);
    });

    test("runs a diamond in three batches with the middle in parallel", async () => {
        const events: string[] = [];
        const root = fake("dia-root", [], events);
        const left = fake("dia-left", ["dia-root"], events);
        const right = fake("dia-right", ["dia-root"], events);
        const leaf = fake("dia-leaf", ["dia-left", "dia-right"], events);

        const results = await withFakeProcessors([leaf, right, left, root], () =>
            runProcessors(createMockContext(), ["dia-leaf", "dia-right", "dia-left", "dia-root"])
        );

        expect(results.map((r) => r.name)).toEqual([
            "dia-root",
            "dia-right",
            "dia-left",
            "dia-leaf",
        ]);
        expect(events).toEqual([
            "start:dia-root",
            "end:dia-root",
            "start:dia-right",
            "start:dia-left",
            "end:dia-right",
            "end:dia-left",
            "start:dia-leaf",
            "end:dia-leaf",
        ]);
    });

    test("starts a new batch when the next processor depends on the current batch", async () => {
        const events: string[] = [];
        const a = fake("chain-a", [], events);
        const b = fake("chain-b", [], events);
        const c = fake("chain-c", ["chain-b"], events);

        await withFakeProcessors([a, b, c], () =>
            runProcessors(createMockContext(), ["chain-a", "chain-b", "chain-c"])
        );

        expect(events).toEqual([
            "start:chain-a",
            "start:chain-b",
            "end:chain-a",
            "end:chain-b",
            "start:chain-c",
            "end:chain-c",
        ]);
    });

    test("passes the selection as activeProcessors and keeps the processor result", async () => {
        const seen: PostProcessorContext[] = [];
        const p: FakeProcessor = {
            name: "active-test",
            description: "active",
            dependsOn: [],
            process: async (context) => {
                seen.push(context);
                return {
                    name: "active-test",
                    processed: 2,
                    skipped: 1,
                    errors: ["x"],
                    durationMs: 99999,
                };
            },
        };

        const results = await withFakeProcessors([p], () =>
            runProcessors(createMockContext(), ["active-test"])
        );

        expect(seen[0]?.options.activeProcessors).toEqual(["active-test"]);
        expect(seen[0]?.options.batchSize).toBe(5);
        expect(results[0]?.processed).toBe(2);
        expect(results[0]?.skipped).toBe(1);
        expect(results[0]?.errors).toEqual(["x"]);
        expect(results[0]?.durationMs).toBeLessThan(99999);
    });

    test("reports the first unknown processor with the available names", async () => {
        logger.setMcpMode(true);
        await expect(
            runProcessors(createMockContext(), ["images", "nope-1", "nope-2"])
        ).rejects.toThrow(/Unknown processor: "nope-1"\. Available: .*images/);
        logger.setMcpMode(false);
    });

    test("cleanupProcessors runs only selected processors with cleanup, in order, with this bound", async () => {
        const calls: string[] = [];
        class WithCleanup {
            readonly description = "cleanup";
            readonly dependsOn: string[] = [];
            constructor(readonly name: string) {}
            async process(): Promise<FakeResult> {
                return { name: this.name, processed: 0, skipped: 0, errors: [], durationMs: 0 };
            }
            async cleanup(): Promise<{
                name: string;
                deleted: number;
                errors: string[];
                durationMs: number;
            }> {
                calls.push(this.name);
                return { name: this.name, deleted: 1, errors: [], durationMs: 99999 };
            }
        }
        const first = new WithCleanup("cl-first");
        const second = new WithCleanup("cl-second");
        const none = fake("cl-none", [], []);

        const results = await withFakeProcessors([first, none, second], () =>
            cleanupProcessors(createMockContext(), ["cl-second", "cl-none", "cl-first"])
        );

        expect(calls).toEqual(["cl-second", "cl-first"]);
        expect(results.map((r) => r.name)).toEqual(["cl-second", "cl-first"]);
        expect(results[0]?.deleted).toBe(1);
        expect(results[0]?.durationMs).toBeLessThan(99999);
    });

    test("refuses to register a processor name twice", () => {
        const duplicate = fake("images", [], []);
        expect(() => registry.register(duplicate)).toThrow(
            'Processor "images" is already registered'
        );
    });

    test("turns a thrown non-Error value into an error result", async () => {
        const p: FakeProcessor = {
            name: "throws-plain",
            description: "throws",
            dependsOn: [],
            process: () => Promise.reject("plain failure"),
        };

        const results = await withFakeProcessors([p], () =>
            runProcessors(createMockContext(), ["throws-plain"])
        );

        expect(results).toHaveLength(1);
        expect(results[0]?.name).toBe("throws-plain");
        expect(results[0]?.processed).toBe(0);
        expect(results[0]?.skipped).toBe(0);
        expect(results[0]?.errors).toEqual(["plain failure"]);
        expect(results[0]?.durationMs).toBeGreaterThanOrEqual(0);
        expect(results[0]?.durationMs).toBeLessThan(60_000);
    });

    test("cleanupProcessors turns a throwing cleanup into an error result", async () => {
        const failing = {
            ...fake("cl-throws", [], []),
            cleanup: () => Promise.reject(new Error("locked")),
        };
        const plain = {
            ...fake("cl-throws-plain", [], []),
            cleanup: () => Promise.reject("busy"),
        };

        const results = await withFakeProcessors([failing, plain], () =>
            cleanupProcessors(createMockContext(), ["cl-throws", "cl-throws-plain"])
        );

        expect(results.map((r) => [r.name, r.deleted, r.errors])).toEqual([
            ["cl-throws", 0, ["locked"]],
            ["cl-throws-plain", 0, ["busy"]],
        ]);
        results.forEach((r) => {
            expect(r.durationMs).toBeGreaterThanOrEqual(0);
            expect(r.durationMs).toBeLessThan(60_000);
        });
    });

    test("cleanupProcessors returns nothing when no selected processor has cleanup", async () => {
        const results = await withFakeProcessors([fake("cl-only-none", [], [])], () =>
            cleanupProcessors(createMockContext(), ["cl-only-none"])
        );

        expect(results).toEqual([]);
    });
});
