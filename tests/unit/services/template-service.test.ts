import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import type { GenerationStep, ModelSelection } from "../../../src/types/index.js";

import { DataCache } from "../../../src/cache.js";
import {
    buildGenerationStep,
    buildTemplateInfo,
    formatTemplateInfo,
    mergeLaneResults,
    readLaneResult,
    readLaneResults,
    readLaneRunStore,
    summarizeTemplateInfo,
    writeTemplateMetadata,
} from "../../../src/services/template-service.js";
import { getGeneratorInfo } from "../../../src/utils/generator-version.js";
import {
    createTestBlueprint,
    createTestCategory,
    createTestProduct,
} from "../../helpers/blueprint-factory.js";

const TEST_BASE_DIR = "./test-template-service-temp";
const CACHE_DIR = `${TEST_BASE_DIR}/generated`;
const RUN_DIR = `${TEST_BASE_DIR}/e2e-results/20261109-123512`;
const STORE = "beauty";
const NOW = new Date("2026-11-09T10:00:00.000Z");

const SELECTION: ModelSelection = {
    textProvider: "openai",
    textModel: "gpt-6-luna",
    imageProvider: "openai",
    imageModel: "gpt-image-2.5-flare",
    imageQuality: "medium",
    imageFreeTier: false,
};

const PASSING_STEPS = "connect\tpass\nupload\tpass\nprocess:images\tpass\nverify\tpass\n";

function writeLane(lane: string, version: string, steps: string): void {
    const dir = path.join(RUN_DIR, lane);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "steps.tsv"), steps);
    fs.writeFileSync(path.join(dir, "version.txt"), `${version}\n`);
}

function writeSummary(store: string): void {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(path.join(RUN_DIR, "summary.md"), `# Lane matrix: ${store}\n\n| Lane |\n`);
}

function createCache(): DataCache {
    return new DataCache({ enabled: true, cacheDir: CACHE_DIR, useCache: true, saveToCache: true });
}

afterEach(() => {
    fs.rmSync(TEST_BASE_DIR, { recursive: true, force: true });
});

describe("buildGenerationStep", () => {
    test("records generator, text model and image model with quality", () => {
        const step = buildGenerationStep(SELECTION, true, NOW);

        expect(step).toEqual({
            at: "2026-11-09T10:00:00.000Z",
            generator: getGeneratorInfo(),
            text: { provider: "openai", model: "gpt-6-luna" },
            image: { provider: "openai", model: "gpt-image-2.5-flare", quality: "medium" },
        });
    });

    test("leaves out the image model for text-only steps", () => {
        expect(buildGenerationStep(SELECTION, false, NOW).image).toBeUndefined();
    });

    test("leaves out the image model when images are disabled", () => {
        const step = buildGenerationStep(
            { ...SELECTION, imageProvider: "none", imageModel: undefined },
            true,
            NOW
        );
        expect(step.image).toBeUndefined();
    });

    test("generator version comes from package.json", () => {
        const pkg: unknown = JSON.parse(fs.readFileSync("package.json", "utf-8"));
        expect(getGeneratorInfo().version).toBe(String(Reflect.get(Object(pkg), "version")));
    });
});

describe("lane results", () => {
    test("a lane passes when every step passed, including verify", () => {
        writeLane("67", "6.7.9999999.9999999-dev", PASSING_STEPS);

        expect(readLaneResult(path.join(RUN_DIR, "67"), "2026-11-09")).toEqual({
            lane: "67",
            shopwareVersion: "6.7.9999999.9999999-dev",
            passed: true,
            testedAt: "2026-11-09",
        });
    });

    test("a failed post-processor fails the lane", () => {
        writeLane(
            "68",
            "6.7.9999999.9999999-dev",
            PASSING_STEPS.replace("images\tpass", "images\tfail")
        );

        expect(readLaneResult(path.join(RUN_DIR, "68"), "2026-11-09")?.passed).toBe(false);
    });

    test("a lane that never reached verify fails", () => {
        writeLane("66", "6.6.9999999.9999999-dev", "connect\tpass\nupload\tpass\n");

        expect(readLaneResult(path.join(RUN_DIR, "66"), "2026-11-09")?.passed).toBe(false);
    });

    test("falls back to the version in verify.json", () => {
        const dir = path.join(RUN_DIR, "trunk");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "steps.tsv"), PASSING_STEPS);
        fs.writeFileSync(
            path.join(dir, "verify.json"),
            JSON.stringify({ shopwareVersion: "6.8.9999999.9999999-dev" })
        );

        expect(readLaneResult(dir, "2026-11-09")?.shopwareVersion).toBe("6.8.9999999.9999999-dev");
    });

    test("reads all lanes of a run, dated from the run directory, sorted numerically", () => {
        writeLane("trunk", "6.7.9999999.9999999-dev", PASSING_STEPS);
        writeLane("67", "6.7.9999999.9999999-dev", PASSING_STEPS);
        writeLane("65", "6.5.9999999.9999999-dev", PASSING_STEPS);
        fs.mkdirSync(path.join(RUN_DIR, "not-a-lane"), { recursive: true });

        const results = readLaneResults(RUN_DIR);

        expect(results.map((r) => r.lane)).toEqual(["65", "67", "trunk"]);
        expect(results.every((r) => r.testedAt === "2026-11-09")).toBe(true);
    });

    test("reads the store name from summary.md", () => {
        writeSummary("music");
        expect(readLaneRunStore(RUN_DIR)).toBe("music");
    });

    test("new results replace older results of the same lane", () => {
        const old = [
            { lane: "66", shopwareVersion: "6.6.1.0", passed: true, testedAt: "2026-10-01" },
            { lane: "67", shopwareVersion: "6.7.1.0", passed: false, testedAt: "2026-10-01" },
        ];
        const next = [
            { lane: "67", shopwareVersion: "6.7.2.0", passed: true, testedAt: "2026-11-09" },
        ];

        expect(mergeLaneResults(old, next)).toEqual([old[0]!, next[0]!]);
    });
});

describe("buildTemplateInfo", () => {
    const hydrate: GenerationStep = buildGenerationStep(SELECTION, true, NOW);
    const blueprint = createTestBlueprint({
        salesChannel: { name: STORE, description: "Beauty and skincare" },
        categories: [createTestCategory({ children: [createTestCategory({ id: "child" })] })],
        products: [createTestProduct(), createTestProduct({ id: "p2" })],
    });

    test("summarizes content, languages and the models of the full hydration", () => {
        const info = buildTemplateInfo({
            name: STORE,
            blueprint,
            steps: { hydrate },
            translationLocales: ["de-DE"],
            testedOn: [],
            now: NOW,
        });

        expect(info.description).toBe("Beauty and skincare");
        expect(info.content).toEqual({
            products: 2,
            categories: 2,
            languages: ["en", "de-DE"],
            variantProducts: 0,
        });
        expect(info.models).toEqual({ text: hydrate.text, image: hydrate.image });
        expect(info.createdAt).toBe("2026-11-09T10:00:00.000Z");
    });

    test("records the variant settings and the number of variant products", () => {
        const variants = { colors: 6, options: 2, maxVariants: 12, share: 0.5 };
        const variantProduct = createTestProduct({ id: "p3" });
        variantProduct.metadata.isVariant = true;
        const info = buildTemplateInfo({
            name: STORE,
            blueprint: {
                ...blueprint,
                variants,
                products: [...blueprint.products, variantProduct],
            },
            steps: {},
            translationLocales: [],
            testedOn: [],
        });

        expect(info.content.variantProducts).toBe(1);
        expect(info.content.variants).toEqual(variants);
        expect(formatTemplateInfo(info)).toContain(
            "  Variants: 1 variant products; settings: 50% variant products, 6 colours, 2 options per other group, max 12 variants"
        );
    });

    test("has no models when no full hydration was recorded", () => {
        const info = buildTemplateInfo({
            name: STORE,
            blueprint,
            steps: {},
            translationLocales: [],
            testedOn: [],
        });

        expect(info.models).toBeUndefined();
    });

    test("one-line summary names generator, model, languages and passed lanes", () => {
        const info = buildTemplateInfo({
            name: STORE,
            blueprint,
            steps: { hydrate },
            translationLocales: ["de-DE"],
            testedOn: [
                { lane: "67", shopwareVersion: "6.7", passed: true, testedAt: "2026-11-09" },
                { lane: "68", shopwareVersion: "6.8", passed: false, testedAt: "2026-11-09" },
            ],
            now: NOW,
        });

        const summary = summarizeTemplateInfo(info);

        expect(summary).toContain("2026-11-09");
        expect(summary).toContain("openai/gpt-6-luna");
        expect(summary).toContain("languages en, de-DE");
        expect(summary).toContain("tested on 67");
        expect(summary).not.toContain("68");
    });
});

describe("writeTemplateMetadata", () => {
    let cache: DataCache;

    beforeEach(() => {
        cache = createCache();
        cache.saveHydratedBlueprint(
            STORE,
            createTestBlueprint({ products: [createTestProduct()] })
        );
    });

    test("writes template.json from the generation log and lane results", () => {
        cache.recordGenerationStep(STORE, "hydrate", buildGenerationStep(SELECTION, true, NOW));
        writeSummary(STORE);
        writeLane("67", "6.7.9999999.9999999-dev", PASSING_STEPS);

        const lines = writeTemplateMetadata(STORE, { e2eDir: RUN_DIR, now: NOW }, cache);

        const info = cache.loadTemplateInfo(STORE);
        expect(lines[0]).toBe("=== Template Metadata ===");
        expect(info?.models?.image?.model).toBe("gpt-image-2.5-flare");
        expect(info?.testedOn).toEqual([
            {
                lane: "67",
                shopwareVersion: "6.7.9999999.9999999-dev",
                passed: true,
                testedAt: "2026-11-09",
            },
        ]);
    });

    test("keeps lane results of earlier runs", () => {
        writeSummary(STORE);
        writeLane("66", "6.6.9999999.9999999-dev", PASSING_STEPS);
        writeTemplateMetadata(STORE, { e2eDir: RUN_DIR }, cache);
        fs.rmSync(path.join(RUN_DIR, "66"), { recursive: true });
        writeLane("67", "6.7.9999999.9999999-dev", PASSING_STEPS);

        writeTemplateMetadata(STORE, { e2eDir: RUN_DIR }, cache);

        expect(cache.loadTemplateInfo(STORE)?.testedOn.map((r) => r.lane)).toEqual(["66", "67"]);
    });

    test("warns when the hydration models are unknown", () => {
        const lines = writeTemplateMetadata(STORE, {}, cache);

        expect(lines.some((l) => l.includes("models are unknown"))).toBe(true);
    });

    test("rejects a lane run of another store", () => {
        writeSummary("music");
        writeLane("67", "6.7.9999999.9999999-dev", PASSING_STEPS);

        const lines = writeTemplateMetadata(STORE, { e2eDir: RUN_DIR }, cache);

        expect(lines[0]).toStartWith("Error:");
        expect(lines[0]).toContain('"music"');
        expect(cache.loadTemplateInfo(STORE)).toBeNull();
    });

    test("fails without a hydrated blueprint", () => {
        const lines = writeTemplateMetadata("unknown-store", {}, cache);
        expect(lines[0]).toStartWith("Error: No hydrated blueprint");
    });
});

describe("generation log", () => {
    test("each step keeps only its last run", () => {
        const cache = createCache();
        const first = buildGenerationStep(SELECTION, false, new Date("2026-11-01T00:00:00Z"));
        const second = buildGenerationStep(SELECTION, false, NOW);

        cache.recordGenerationStep(STORE, "translate:de-DE", first);
        cache.recordGenerationStep(STORE, "hydrate", first);
        cache.recordGenerationStep(STORE, "translate:de-DE", second);

        expect(cache.loadGenerationLog(STORE)?.steps).toEqual({
            "translate:de-DE": second,
            hydrate: first,
        });
    });

    test("ignores an invalid generation.json", () => {
        const cache = createCache();
        fs.mkdirSync(cache.getSalesChannelDir(STORE), { recursive: true });
        fs.writeFileSync(path.join(cache.getSalesChannelDir(STORE), "generation.json"), "{}");

        expect(cache.loadGenerationLog(STORE)).toBeNull();
    });
});
