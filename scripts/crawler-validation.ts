/**
 * Pure parts of the crawler validation script (scripts/validate-crawlers.ts):
 * expectation checks and table formatting. The crawl function is injected, so
 * this module makes no network calls and can be unit-tested.
 */

import type { InspirationData } from "../src/crawlers/index.js";

export interface StoreSpec {
    name: string;
    url: string;
    platform: string;
    minCategories: number;
    minProducts: number;
    requireColors: boolean;
    skipOnFetchError?: boolean;
    note?: string;
}

export interface StoreResult {
    spec: StoreSpec;
    data?: InspirationData;
    error?: string;
    passed: boolean;
    failures: string[];
    durationMs: number;
}

export type CrawlFn = (url: string) => Promise<InspirationData>;

const TABLE_WIDTH = 90;

/** List every minimum expectation of the spec that the crawl result misses. */
export function checkStoreExpectations(spec: StoreSpec, data: InspirationData): string[] {
    const failures: string[] = [];
    if (data.categories.length < spec.minCategories) {
        failures.push(`categories: got ${data.categories.length}, expected ≥${spec.minCategories}`);
    }
    if (data.exampleProducts.length < spec.minProducts) {
        failures.push(
            `products: got ${data.exampleProducts.length}, expected ≥${spec.minProducts}`
        );
    }
    if (spec.requireColors && !data.brandColors) {
        failures.push("brand colors: none extracted (expected some)");
    }
    return failures;
}

/** Result for a store whose crawl threw; passes only when the spec allows fetch errors. */
export function fetchErrorResult(spec: StoreSpec, err: unknown, durationMs: number): StoreResult {
    const message = err instanceof Error ? err.message : String(err);
    const passed = spec.skipOnFetchError === true;
    return {
        spec,
        error: message,
        passed,
        failures: passed ? [] : [`fetch failed: ${message}`],
        durationMs,
    };
}

export async function validateStore(
    spec: StoreSpec,
    crawl: CrawlFn,
    now: () => number = Date.now
): Promise<StoreResult> {
    const start = now();
    try {
        const data = await crawl(spec.url);
        const durationMs = now() - start;
        const failures = checkStoreExpectations(spec, data);
        return { spec, data, passed: failures.length === 0, failures, durationMs };
    } catch (err) {
        return fetchErrorResult(spec, err, now() - start);
    }
}

export function colorHex(colors?: InspirationData["brandColors"]): string {
    if (!colors) return "none    ";
    return colors.primary.padEnd(8);
}

/** Pad a label to the width, or cut it with an ellipsis when it is longer. */
export function bar(label: string, width = 18): string {
    return label.length > width ? label.slice(0, width - 1) + "…" : label.padEnd(width);
}

export function formatTableHeader(): string[] {
    return [
        "\nValidating crawlers against known stores...\n",
        `${"Store".padEnd(16)} ${"Platform".padEnd(18)} ${"Categories".padEnd(12)} ${"Products".padEnd(10)} ${"Colors".padEnd(10)} ${"Time".padEnd(7)} Status`,
        "─".repeat(TABLE_WIDTH),
    ];
}

/** Row start, printed before the crawl so slow stores show progress. */
export function formatRowPrefix(spec: StoreSpec): string {
    return `  ${bar(spec.name, 14)} ${bar(spec.platform, 16)} `;
}

function countLabel(count: number | undefined, min: number): string {
    return count === undefined ? "error" : `${count}/≥${min}`;
}

/** Row end plus one indented line per failure. */
export function formatRowResult(result: StoreResult): string[] {
    const { spec, data } = result;
    const cats = countLabel(data?.categories.length, spec.minCategories);
    const prods = countLabel(data?.exampleProducts.length, spec.minProducts);
    const colors = colorHex(data?.brandColors);
    const time = `${(result.durationMs / 1000).toFixed(1)}s`;
    const status = result.passed ? "✅ PASS" : "❌ FAIL";
    const row = `${cats.padEnd(12)} ${prods.padEnd(10)} ${colors.padEnd(10)} ${time.padEnd(7)} ${status}`;
    return [row, ...result.failures.map((f) => `    ↳ ${f}`)];
}

export interface ValidationSummary {
    failed: number;
    lines: string[];
}

export function summarizeResults(results: StoreResult[]): ValidationSummary {
    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;
    const lines = ["\n" + "─".repeat(TABLE_WIDTH), `Results: ${passed} pass, ${failed} fail\n`];
    if (failed === 0) return { failed, lines };
    return {
        failed,
        lines: [
            ...lines,
            "Note: results are flaky by nature — live sites change bot protection, sitemaps, and HTML",
            "structure without notice. Update the spec thresholds if a change appears permanent.\n",
        ],
    };
}
