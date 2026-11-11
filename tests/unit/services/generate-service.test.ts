import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PostProcessorResult } from "../../../src/post-processors/index.js";
import type { BlueprintProduct, HydratedBlueprint } from "../../../src/types/index.js";

import { createCacheFromEnv } from "../../../src/cache.js";
import {
    formatProcessorErrorLine,
    formatProductSyncErrorLine,
    runGenerate,
} from "../../../src/services/generate-service.js";
import {
    createTestBlueprint,
    createTestCategory,
    createTestProduct,
} from "../../helpers/blueprint-factory.js";

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

describe("runGenerate (dry run, blueprint steps)", () => {
    const NAME = "test-store";
    const CONNECTION = {
        url: "http://shop.test",
        credentials: { kind: "user" as const, username: "admin", password: "secret" },
    };
    let root = "";
    const originalCacheDir = process.env.CACHE_DIR;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "generate-service-"));
        process.env.CACHE_DIR = root;
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
        if (originalCacheDir === undefined) delete process.env.CACHE_DIR;
        else process.env.CACHE_DIR = originalCacheDir;
    });

    function products(names: string[]): BlueprintProduct[] {
        return names.map((name, i) => createTestProduct({ id: `prod-${i}`, name }));
    }

    function hydrated(names: string[]): HydratedBlueprint {
        return createTestBlueprint({
            salesChannel: { name: NAME, description: "Test store" },
            categories: [createTestCategory()],
            products: products(names),
        });
    }

    function saveBlueprints(
        hydratedNames: string[],
        blueprintProducts = hydratedNames.length
    ): void {
        const cache = createCacheFromEnv();
        const original = hydrated(Array.from({ length: blueprintProducts }, (_, i) => `P ${i}`));
        cache.saveBlueprint(NAME, original);
        cache.saveHydratedBlueprint(NAME, hydrated(hydratedNames));
    }

    async function run(options: Parameters<typeof runGenerate>[2] = {}): Promise<string[]> {
        const result = await runGenerate(NAME, "Test store", {
            dryRun: true,
            noTemplate: true,
            connection: CONNECTION,
            ...options,
        });
        return result.lines;
    }

    test("stops before the blueprint and AI hydration when the Shopware login fails", async () => {
        const lines = await run({
            dryRun: false,
            connection: {
                url: "http://127.0.0.1:9",
                credentials: { kind: "user", username: "admin", password: "wrong" },
            },
        });

        expect(lines.at(-1)).toStartWith("Error: Authentication with Shopware failed");
        expect(lines.some((l) => l.startsWith("Step 1"))).toBe(false);
        expect(createCacheFromEnv().hasBlueprint(NAME)).toBe(false);
    });

    test("uses the existing blueprints and stops after the dry run", async () => {
        saveBlueprints(["Alpha", "Beta"]);

        const lines = await run();

        expect(lines).toContain("Step 1: Using existing blueprint");
        expect(lines).toContain("Step 2: Using existing hydrated blueprint");
        expect(lines).toContain("  [DRY RUN] Would sync to http://shop.test");
        expect(lines.some((l) => l.includes("Variant settings are ignored"))).toBe(false);
        expect(lines.some((l) => l.includes("Auto-fixed"))).toBe(false);
        expect(lines.some((l) => l.includes("Partial hydration"))).toBe(false);
        expect(lines.some((l) => l.startsWith("Checking for pre-generated template"))).toBe(false);
    });

    test("warns that variant settings are ignored for an existing blueprint", async () => {
        saveBlueprints(["Alpha"]);

        const lines = await run({ variants: { colors: 6 } });

        expect(lines).toContain(
            `⚠ Variant settings are ignored for an existing blueprint. ` +
                `Use: blueprint hydrate --name=${NAME} --only=variants`
        );
    });

    test("does not warn for empty variant settings", async () => {
        saveBlueprints(["Alpha"]);

        const lines = await run({ variants: {} });

        expect(lines.some((l) => l.includes("Variant settings are ignored"))).toBe(false);
    });

    test("creates a missing blueprint before using the hydrated one", async () => {
        createCacheFromEnv().saveHydratedBlueprint(NAME, hydrated(["Alpha"]));

        const lines = await run({ products: 4 });

        expect(lines).toContain("Step 1: Creating blueprint...");
        expect(lines.some((l) => l.startsWith("==="))).toBe(true);
        expect(lines.filter((l) => l.startsWith("=== Blueprint Create"))).toEqual([]);
        expect(createCacheFromEnv().loadBlueprint(NAME)?.products.length).toBe(4);
        expect(lines).toContain("Step 2: Using existing hydrated blueprint");
    });

    test("returns the error of blueprint creation", async () => {
        createCacheFromEnv().saveHydratedBlueprint(NAME, hydrated(["Alpha"]));

        const lines = await run({ variants: { colors: 99 } });

        expect(lines.at(-1)?.startsWith("Error:")).toBe(true);
        expect(lines).not.toContain("Step 2: Using existing hydrated blueprint");
    });

    test("reports auto-fixed issues and saves the fixed blueprint", async () => {
        saveBlueprints(["Same", "Same"]);

        const lines = await run();

        expect(lines).toContain("  Auto-fixed 1 blueprint issue(s)");
        const names = createCacheFromEnv()
            .loadHydratedBlueprint(NAME)
            ?.products.map((p) => p.name);
        expect(new Set(names).size).toBe(2);
    });

    test("fails with the validation issues and a retry hint", async () => {
        saveBlueprints(["Product 1"]);

        const lines = await run();

        const error = lines.at(-1) ?? "";
        expect(error.startsWith("Error: Blueprint validation failed:\n")).toBe(true);
        expect(error).toContain("\n  - Found 1 placeholder product names (not hydrated by AI)\n");
        expect(
            error.endsWith(
                `\n\nThis may be caused by an interrupted hydration (e.g., API credits exhausted).\n` +
                    `To retry: bun run blueprint hydrate --name=${NAME} --rehydrate`
            )
        ).toBe(true);
    });

    test("re-hydrates an incomplete hydrated blueprint", async () => {
        saveBlueprints([]);
        const originalProvider = process.env.AI_PROVIDER;
        process.env.AI_PROVIDER = "github-models";
        const seen: string[] = [];

        try {
            // The retired provider throws once hydration needs the AI
            const thrown = await runGenerate(NAME, "Test store", {
                dryRun: true,
                noTemplate: true,
                connection: CONNECTION,
                hooks: { onLine: (line) => seen.push(line) },
            }).then(
                () => false,
                () => true
            );
            expect(thrown).toBe(true);
            expect(createCacheFromEnv().hasHydratedBlueprint(NAME)).toBe(false);
        } finally {
            if (originalProvider === undefined) delete process.env.AI_PROVIDER;
            else process.env.AI_PROVIDER = originalProvider;
        }
        expect(seen).toContain(
            "  Detected incomplete hydrated blueprint (likely from a previous failed attempt). Re-hydrating..."
        );
        expect(seen).toContain("Step 2: Hydrating blueprint...");
    });

    test("warns about a partial hydration", async () => {
        saveBlueprints(["Alpha"], 3);

        const lines = await run();

        expect(lines).toContain(`  ⚠ Partial hydration: 1/3 products were generated.`);
        expect(lines).toContain(
            `  To regenerate all products: bun run blueprint hydrate --name=${NAME} --rehydrate`
        );
    });

    test("does not warn when all products are hydrated or no blueprint exists", async () => {
        createCacheFromEnv().saveHydratedBlueprint(NAME, hydrated(["Alpha"]));
        createCacheFromEnv().saveBlueprint(NAME, hydrated(["P 0"]));

        const lines = await run();

        expect(lines.some((l) => l.includes("Partial hydration"))).toBe(false);
    });
});
