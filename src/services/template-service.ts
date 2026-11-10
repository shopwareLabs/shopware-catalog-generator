/**
 * Template Service - metadata that ships with a template in the templates repo.
 *
 * `generation.json` is written during hydration and translation (which generator version
 * and models produced each part). `template metadata` combines it with the catalog content
 * and the e2e lane results into `template.json`.
 *
 * Returns string[] (output lines) so both CLI (prints) and MCP (joins) can consume it.
 */

import fs from "node:fs";
import path from "node:path";

import type { DataCache } from "../cache.js";
import type {
    GenerationStep,
    HydratedBlueprint,
    LaneResult,
    ModelInfo,
    ModelSelection,
    TemplateInfo,
} from "../types/index.js";

import { formatVariantSettings } from "../blueprint/variant-settings.js";
import { cacheFileForDisplay, createCacheFromEnv } from "../cache.js";
import { TEMPLATE_INFO_SCHEMA_VERSION } from "../types/index.js";
import { getGeneratorInfo } from "../utils/generator-version.js";
import { countCategories } from "../utils/index.js";

const SOURCE_LANGUAGE = "en";

/** Generation step for the given models. Pass `withImages` when the step generated images. */
export function buildGenerationStep(
    selection: ModelSelection,
    withImages: boolean,
    now: Date = new Date()
): GenerationStep {
    const step: GenerationStep = {
        at: now.toISOString(),
        generator: getGeneratorInfo(),
        text: { provider: selection.textProvider, model: selection.textModel },
    };
    const image = imageModelInfo(selection);
    if (!withImages || !image) return step;
    return { ...step, image };
}

function imageModelInfo(selection: ModelSelection): ModelInfo | undefined {
    if (!selection.imageModel || selection.imageProvider === "none") return undefined;
    const info: ModelInfo = { provider: selection.imageProvider, model: selection.imageModel };
    return selection.imageQuality ? { ...info, quality: selection.imageQuality } : info;
}

// =============================================================================
// Lane results (e2e-results/<timestamp>/ from test-e2e-lanes.sh)
// =============================================================================

/** Store name from the "# Lane matrix: <store>" heading of summary.md */
export function readLaneRunStore(runDir: string): string | undefined {
    const summary = path.join(runDir, "summary.md");
    if (!fs.existsSync(summary)) return undefined;
    const match = fs.readFileSync(summary, "utf-8").match(/^# Lane matrix: (.+)$/m);
    return match?.[1]?.trim();
}

/** Run date from a "YYYYMMDD-HHMMSS" directory name, else the directory's mtime */
function runDateOf(runDir: string): string {
    const match = path.basename(runDir).match(/^(\d{4})(\d{2})(\d{2})-\d{6}$/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
    return fs.statSync(runDir).mtime.toISOString().slice(0, 10);
}

/**
 * A lane passed when no step in steps.tsv failed and the verify step ran and passed.
 * Returns undefined for directories without lane results.
 */
export function readLaneResult(laneDir: string, testedAt: string): LaneResult | undefined {
    const stepsFile = path.join(laneDir, "steps.tsv");
    if (!fs.existsSync(stepsFile)) return undefined;

    const steps = fs
        .readFileSync(stepsFile, "utf-8")
        .split("\n")
        .map((line) => line.split("\t"))
        .filter((cols) => cols.length >= 2);
    const anyFailed = steps.some((cols) => cols[1]?.trim() !== "pass");
    const verifyPassed = steps.some(
        (cols) => cols[0]?.trim() === "verify" && cols[1]?.trim() === "pass"
    );

    return {
        lane: path.basename(laneDir),
        shopwareVersion: readShopwareVersion(laneDir),
        passed: verifyPassed && !anyFailed,
        testedAt,
    };
}

function readShopwareVersion(laneDir: string): string {
    const versionFile = path.join(laneDir, "version.txt");
    if (fs.existsSync(versionFile)) {
        const version = fs.readFileSync(versionFile, "utf-8").trim();
        if (version) return version;
    }
    const verifyFile = path.join(laneDir, "verify.json");
    if (!fs.existsSync(verifyFile)) return "unknown";
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(verifyFile, "utf-8"));
        if (typeof parsed !== "object" || parsed === null) return "unknown";
        const version: unknown = Reflect.get(parsed, "shopwareVersion");
        return typeof version === "string" && version ? version : "unknown";
    } catch {
        return "unknown";
    }
}

/** All lane results of one lane-matrix run, sorted by lane */
export function readLaneResults(runDir: string): LaneResult[] {
    const testedAt = runDateOf(runDir);
    return fs
        .readdirSync(runDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => readLaneResult(path.join(runDir, entry.name), testedAt))
        .filter((result): result is LaneResult => result !== undefined)
        .sort((a, b) => a.lane.localeCompare(b.lane, undefined, { numeric: true }));
}

/** New lane results replace older results of the same lane */
export function mergeLaneResults(previous: LaneResult[], next: LaneResult[]): LaneResult[] {
    const lanes = new Set(next.map((r) => r.lane));
    return [...previous.filter((r) => !lanes.has(r.lane)), ...next].sort((a, b) =>
        a.lane.localeCompare(b.lane, undefined, { numeric: true })
    );
}

// =============================================================================
// template.json
// =============================================================================

export interface BuildTemplateInfoParams {
    name: string;
    blueprint: HydratedBlueprint;
    steps: Record<string, GenerationStep>;
    translationLocales: string[];
    testedOn: LaneResult[];
    now?: Date;
}

export function buildTemplateInfo(params: BuildTemplateInfoParams): TemplateInfo {
    const hydrate = params.steps.hydrate;
    const info: TemplateInfo = {
        schemaVersion: TEMPLATE_INFO_SCHEMA_VERSION,
        name: params.name,
        description: params.blueprint.salesChannel.description,
        createdAt: (params.now ?? new Date()).toISOString(),
        generator: getGeneratorInfo(),
        content: {
            products: params.blueprint.products.length,
            categories: countCategories(params.blueprint.categories),
            languages: [SOURCE_LANGUAGE, ...params.translationLocales],
            variantProducts: params.blueprint.products.filter((p) => p.metadata.isVariant).length,
            ...(params.blueprint.variants ? { variants: { ...params.blueprint.variants } } : {}),
        },
        steps: params.steps,
        testedOn: params.testedOn,
    };
    if (!hydrate) return info;
    return {
        ...info,
        models: hydrate.image
            ? { text: hydrate.text, image: hydrate.image }
            : { text: hydrate.text },
    };
}

export function formatTemplateInfo(info: TemplateInfo): string[] {
    const generator = info.generator.commit
        ? `${info.generator.version} (${info.generator.commit})`
        : info.generator.version;
    const lines = [
        `  Generator: ${generator}`,
        `  Content: ${info.content.products} products, ${info.content.categories} categories`,
        `  Languages: ${info.content.languages.join(", ")}`,
        `  Variants: ${formatTemplateVariants(info)}`,
        `  Text model: ${formatModel(info.models?.text)}`,
        `  Image model: ${formatModel(info.models?.image)}`,
    ];
    if (info.testedOn.length === 0) return [...lines, `  Tested on: -`];
    return [
        ...lines,
        `  Tested on:`,
        ...info.testedOn.map(
            (r) =>
                `    ${r.lane}: ${r.shopwareVersion} ${r.passed ? "PASS" : "FAIL"} (${r.testedAt})`
        ),
    ];
}

function formatTemplateVariants(info: TemplateInfo): string {
    const { variantProducts, variants } = info.content;
    const products = variantProducts === undefined ? "?" : String(variantProducts);
    if (!variants) return `${products} variant products (settings not recorded)`;
    return `${products} variant products; settings: ${formatVariantSettings(variants)}`;
}

function formatModel(model: ModelInfo | undefined): string {
    if (!model) return "unknown";
    const quality = model.quality ? `, ${model.quality}` : "";
    return `${model.provider}/${model.model}${quality}`;
}

/** One-line summary, logged when a template is used */
export function summarizeTemplateInfo(info: TemplateInfo): string {
    const date = info.createdAt.slice(0, 10);
    const passed = info.testedOn.filter((r) => r.passed).map((r) => r.lane);
    const tested = passed.length > 0 ? `, tested on ${passed.join(", ")}` : "";
    return (
        `generator ${info.generator.version}, ${date}, ` +
        `text ${formatModel(info.models?.text)}, ` +
        `languages ${info.content.languages.join(", ")}${tested}`
    );
}

// =============================================================================
// `template metadata` command
// =============================================================================

export interface TemplateMetadataOptions {
    /** e2e-results/<timestamp> directory of a test-e2e-lanes.sh run */
    e2eDir?: string;
    now?: Date;
}

export function writeTemplateMetadata(
    salesChannelName: string,
    options: TemplateMetadataOptions = {},
    cache: DataCache = createCacheFromEnv()
): string[] {
    const blueprint = cache.loadHydratedBlueprint(salesChannelName);
    if (!blueprint) {
        return [
            `Error: No hydrated blueprint found for "${salesChannelName}". ` +
                `Run: blueprint hydrate --name=${salesChannelName}`,
        ];
    }

    const laneResults = readLaneResultsFor(salesChannelName, options.e2eDir);
    if (typeof laneResults === "string") return [laneResults];

    const previous = cache.loadTemplateInfo(salesChannelName);
    const steps = cache.loadGenerationLog(salesChannelName)?.steps ?? previous?.steps ?? {};
    const info = buildTemplateInfo({
        name: salesChannelName,
        blueprint,
        steps,
        translationLocales: cache.listTranslationLocales(salesChannelName),
        testedOn: mergeLaneResults(previous?.testedOn ?? [], laneResults),
        now: options.now,
    });
    cache.saveTemplateInfo(salesChannelName, info);

    const warnings = info.models
        ? []
        : [`  ⚠ No recorded hydration run: models are unknown (hydrated before metadata existed)`];
    return [
        `=== Template Metadata ===`,
        `Name: ${salesChannelName}`,
        ...formatTemplateInfo(info),
        ...warnings,
        `  Saved to: ${cacheFileForDisplay(cache, salesChannelName, "template.json")}`,
    ];
}

/** Lane results of an e2e run, or an error line when the run does not match the store */
function readLaneResultsFor(salesChannelName: string, e2eDir?: string): LaneResult[] | string {
    if (!e2eDir) return [];
    if (!fs.existsSync(e2eDir)) return `Error: e2e results directory not found: ${e2eDir}`;
    const store = readLaneRunStore(e2eDir);
    if (store && store !== salesChannelName) {
        return `Error: ${e2eDir} is a lane run for "${store}", not "${salesChannelName}"`;
    }
    const results = readLaneResults(e2eDir);
    if (results.length === 0) return `Error: No lane results found in ${e2eDir}`;
    return results;
}
