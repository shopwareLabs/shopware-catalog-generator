import { describe, expect, test } from "bun:test";

import type { InspirationData } from "../../../src/crawlers/index.js";

import {
    bar,
    checkStoreExpectations,
    colorHex,
    fetchErrorResult,
    formatRowPrefix,
    formatRowResult,
    formatTableHeader,
    summarizeResults,
    validateStore,
    type StoreResult,
    type StoreSpec,
} from "../../../scripts/crawler-validation.js";

const SPEC: StoreSpec = {
    name: "Example",
    url: "https://example.com",
    platform: "Shopware 6",
    minCategories: 2,
    minProducts: 1,
    requireColors: true,
};

function inspiration(overrides: Partial<InspirationData> = {}): InspirationData {
    return {
        sourceUrl: "https://example.com",
        crawledAt: "2026-01-01T00:00:00.000Z",
        categories: ["Sofas", "Chairs"],
        exampleProducts: [{ name: "Oslo" }],
        brandColors: { primary: "#112233", secondary: "#445566" },
        ...overrides,
    };
}

function clock(...times: number[]): () => number {
    let i = 0;
    return () => times[i++] ?? 0;
}

describe("checkStoreExpectations", () => {
    test("no failures when every minimum is met exactly", () => {
        expect(checkStoreExpectations(SPEC, inspiration())).toEqual([]);
    });

    test("reports too few categories and products", () => {
        const data = inspiration({ categories: ["Sofas"], exampleProducts: [] });
        expect(checkStoreExpectations(SPEC, data)).toEqual([
            "categories: got 1, expected ≥2",
            "products: got 0, expected ≥1",
        ]);
    });

    test("reports missing brand colors only when required", () => {
        const data = inspiration({ brandColors: undefined });
        expect(checkStoreExpectations(SPEC, data)).toEqual([
            "brand colors: none extracted (expected some)",
        ]);
        expect(checkStoreExpectations({ ...SPEC, requireColors: false }, data)).toEqual([]);
    });
});

describe("validateStore", () => {
    test("passes with duration when the crawl meets the spec", async () => {
        const data = inspiration();
        const result = await validateStore(SPEC, async () => data, clock(1000, 3500));
        expect(result).toEqual({ spec: SPEC, data, passed: true, failures: [], durationMs: 2500 });
    });

    test("passes the store URL to the crawl function", async () => {
        const urls: string[] = [];
        await validateStore(SPEC, async (url) => {
            urls.push(url);
            return inspiration();
        });
        expect(urls).toEqual(["https://example.com"]);
    });

    test("fails when expectations are missed", async () => {
        const result = await validateStore(SPEC, async () => inspiration({ categories: [] }));
        expect(result.passed).toBe(false);
        expect(result.failures).toEqual(["categories: got 0, expected ≥2"]);
    });

    test("turns a thrown crawl into a fetch failure", async () => {
        const result = await validateStore(
            SPEC,
            async () => {
                throw new Error("HTTP 403");
            },
            clock(0, 700)
        );
        expect(result).toEqual({
            spec: SPEC,
            error: "HTTP 403",
            passed: false,
            failures: ["fetch failed: HTTP 403"],
            durationMs: 700,
        });
    });
});

describe("fetchErrorResult", () => {
    test("passes without failures when the spec skips fetch errors", () => {
        const result = fetchErrorResult({ ...SPEC, skipOnFetchError: true }, "boom", 5);
        expect(result.passed).toBe(true);
        expect(result.failures).toEqual([]);
        expect(result.error).toBe("boom");
    });
});

describe("formatting", () => {
    test("colorHex pads the primary color or shows none", () => {
        expect(colorHex(undefined)).toBe("none    ");
        expect(colorHex({ primary: "#abc", secondary: "#def" })).toBe("#abc    ");
    });

    test("bar pads short labels and cuts long ones with an ellipsis", () => {
        expect(bar("abc", 5)).toBe("abc  ");
        expect(bar("abcde", 5)).toBe("abcde");
        expect(bar("abcdef", 5)).toBe("abcd…");
        expect(bar("x")).toHaveLength(18);
    });

    test("header has title, column names and a rule", () => {
        const [title, columns, rule] = formatTableHeader();
        expect(title).toContain("Validating crawlers");
        expect(columns).toStartWith("Store ");
        expect(columns).toEndWith("Status");
        expect(rule).toBe("─".repeat(90));
    });

    test("row prefix shows the store name and platform", () => {
        expect(formatRowPrefix(SPEC)).toBe(`  ${"Example".padEnd(14)} ${"Shopware 6".padEnd(16)} `);
    });

    test("row result for a passing crawl", () => {
        const result: StoreResult = {
            spec: SPEC,
            data: inspiration(),
            passed: true,
            failures: [],
            durationMs: 1234,
        };
        expect(formatRowResult(result)).toEqual([
            `${"2/≥2".padEnd(12)} ${"1/≥1".padEnd(10)} ${"#112233 ".padEnd(10)} ${"1.2s".padEnd(7)} ✅ PASS`,
        ]);
    });

    test("row result for a failed fetch lists the failure", () => {
        const result = fetchErrorResult(SPEC, new Error("timeout"), 0);
        expect(formatRowResult(result)).toEqual([
            `${"error".padEnd(12)} ${"error".padEnd(10)} ${"none    ".padEnd(10)} ${"0.0s".padEnd(7)} ❌ FAIL`,
            "    ↳ fetch failed: timeout",
        ]);
    });
});

describe("summarizeResults", () => {
    const pass: StoreResult = { spec: SPEC, passed: true, failures: [], durationMs: 0 };
    const fail: StoreResult = { spec: SPEC, passed: false, failures: ["x"], durationMs: 0 };

    test("all passing: counts only, no flakiness note", () => {
        const summary = summarizeResults([pass, pass]);
        expect(summary.failed).toBe(0);
        expect(summary.lines).toEqual(["\n" + "─".repeat(90), "Results: 2 pass, 0 fail\n"]);
    });

    test("failures add the flakiness note", () => {
        const summary = summarizeResults([pass, fail]);
        expect(summary.failed).toBe(1);
        expect(summary.lines[1]).toBe("Results: 1 pass, 1 fail\n");
        expect(summary.lines).toHaveLength(4);
        expect(summary.lines[2]).toStartWith("Note: results are flaky");
    });
});
