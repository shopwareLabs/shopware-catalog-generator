import { describe, expect, test } from "bun:test";

import {
    CmsProcessor,
    DEFAULT_PROCESSOR_OPTIONS,
    ImageProcessor,
    ManufacturerProcessor,
    ReviewProcessor,
    registry,
    VariantProcessor,
} from "../../../src/post-processors/index.js";

describe("PostProcessor Registry", () => {
    test("has all processors registered", () => {
        const names = registry.getNames();

        expect(names).toContain("cms");
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
        expect(all.length).toBe(5);
        expect(all.map((p) => p.name)).toContain("cms");
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
    test("cms processor has no dependencies", () => {
        expect(CmsProcessor.dependsOn).toEqual([]);
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
