import { describe, expect, test } from "bun:test";

import type { PostProcessorResult } from "../../../src/post-processors/index.js";

import {
    formatProcessorErrorLine,
    formatProductSyncErrorLine,
} from "../../../src/services/generate-service.js";

function processorResult(name: string, errors: string[] = []): PostProcessorResult {
    return { name, processed: 1, skipped: 0, errors, durationMs: 10 };
}

describe("formatProcessorErrorLine", () => {
    test("returns undefined when no processor reported errors", () => {
        const line = formatProcessorErrorLine([
            processorResult("images"),
            processorResult("theme"),
        ]);
        expect(line).toBeUndefined();
    });

    test("returns undefined for an empty result list", () => {
        expect(formatProcessorErrorLine([])).toBeUndefined();
    });

    test("builds an Error: line naming each failing processor with its error count", () => {
        const line = formatProcessorErrorLine([
            processorResult("images"),
            processorResult("theme", ["config update failed", "media missing"]),
            processorResult("reviews", ["sync failed"]),
        ]);
        expect(line).toBe("Error: 3 post-processor error(s): theme (2), reviews (1)");
    });

    test("starts with the Error: prefix that CLI wrappers turn into a non-zero exit", () => {
        const line = formatProcessorErrorLine([processorResult("theme", ["failed"])]);
        expect(line?.startsWith("Error:")).toBe(true);
    });
});

describe("formatProductSyncErrorLine", () => {
    test("returns undefined when every product was uploaded", () => {
        expect(formatProductSyncErrorLine({ synced: 90, failed: 0 })).toBeUndefined();
    });

    test("builds an Error: line with the failed and total product count", () => {
        expect(formatProductSyncErrorLine({ synced: 40, failed: 50 })).toBe(
            "Error: 50 of 90 products failed to upload (see log for the Shopware response)"
        );
    });
});
