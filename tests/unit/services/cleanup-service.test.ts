import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
    CleanupDeps,
    CleanupShopware,
    CoreCleanupOptions,
} from "../../../src/services/cleanup-service.js";

import { DataCache } from "../../../src/cache.js";
import { registry } from "../../../src/post-processors/index.js";
import {
    cleanupGlobal,
    cleanupSalesChannelData,
    resolveCleanupProcessors,
} from "../../../src/services/cleanup-service.js";
import { createTestBlueprint, createTestProduct } from "../../helpers/blueprint-factory.js";

interface FakeShopware extends CleanupShopware {
    calls: string[];
}

function fakeShopware(overrides: Partial<CleanupShopware> = {}): FakeShopware {
    const calls: string[] = [];
    return {
        calls,
        url: "http://shop.test",
        findSalesChannelId: async (name) => (name === "garden" ? "sc-garden" : null),
        cleanupProcessors: async (_name, id, processors, dryRun) => {
            calls.push(`processors:${id}:${processors.join(",")}:${dryRun}`);
            return processors.map((name) => ({ name, deleted: 2, errors: [], durationMs: 0 }));
        },
        cleanupCore: async (_name, options: CoreCleanupOptions) => {
            calls.push(`core:${options.deleteSalesChannel}:${options.deletePropertyGroups}`);
            return {
                products: 5,
                categories: 3,
                propertyGroups: 1,
                salesChannelDeleted: options.deleteSalesChannel,
                rootCategoryDeleted: options.deleteSalesChannel,
                errors: [],
            };
        },
        deleteProductsByIds: async (ids) => {
            calls.push(`products-by-id:${ids.join(",")}`);
            return ids.length;
        },
        deleteUnusedPropertyGroups: async (dryRun) => {
            calls.push(`unused-props:${dryRun}`);
            return 4;
        },
        deleteUnusedPropertyOptions: async (dryRun) => {
            calls.push(`unused-options:${dryRun}`);
            return 6;
        },
        deleteOrphanedProductMedia: async (dryRun) => {
            calls.push(`orphaned-media:${dryRun}`);
            return 1;
        },
        ...overrides,
    };
}

const BASE = {
    salesChannel: "garden",
    deleteSalesChannel: false,
    deleteProps: false,
    processors: [],
    full: false,
    dryRun: false,
};

describe("cleanup-service", () => {
    let root: string;
    let cache: DataCache;
    let shopware: FakeShopware;
    let deps: CleanupDeps;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-service-"));
        cache = new DataCache({ cacheDir: path.join(root, "generated") });
        shopware = fakeShopware();
        deps = { cache, connect: async () => shopware };
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const errors = (lines: string[]): string[] => lines.filter((l) => l.startsWith("Error:"));

    test("core cleanup deletes products and categories, not processor entities", async () => {
        const lines = await cleanupSalesChannelData(BASE, deps);

        expect(shopware.calls).toEqual(["products-by-id:", "core:false:false"]);
        expect(lines).toContain("Products deleted: 5");
        expect(lines.some((l) => l.startsWith("Note: Processor entities"))).toBe(true);
        expect(errors(lines)).toEqual([]);
    });

    test("deletes the cached blueprint's products by ID before the core cleanup", async () => {
        // Product IDs are deterministic: leftovers of a deleted SalesChannel would be reused
        cache.saveHydratedBlueprint(
            "garden",
            createTestBlueprint({
                products: [createTestProduct({ id: "p-1" }), createTestProduct({ id: "p-2" })],
            })
        );

        const lines = await cleanupSalesChannelData(BASE, deps);

        expect(shopware.calls).toEqual(["products-by-id:p-1,p-2", "core:false:false"]);
        expect(lines).toContain("Products deleted by blueprint ID: 2");
        expect(errors(lines)).toEqual([]);
    });

    test("dry run never runs the core cleanup", async () => {
        const lines = await cleanupSalesChannelData(
            { ...BASE, deleteSalesChannel: true, deleteProps: true, dryRun: true },
            deps
        );

        expect(shopware.calls).toEqual([]);
        expect(lines).toContain("[DRY RUN] Would delete:");
        expect(lines).toContain("  - The SalesChannel and its root category");
    });

    test("full dry run passes dryRun to the processors and skips the core cleanup", async () => {
        await cleanupSalesChannelData({ ...BASE, full: true, dryRun: true }, deps);

        expect(shopware.calls).toEqual([
            `processors:sc-garden:${registry.getNames().join(",")}:true`,
        ]);
    });

    test("full runs every processor, then the core cleanup, and keeps the SalesChannel", async () => {
        await cleanupSalesChannelData({ ...BASE, full: true }, deps);

        expect(shopware.calls).toEqual([
            `processors:sc-garden:${registry.getNames().join(",")}:false`,
            "products-by-id:",
            "core:false:false",
        ]);
    });

    test("processors only clean up their entities", async () => {
        const lines = await cleanupSalesChannelData({ ...BASE, processors: ["reviews"] }, deps);

        expect(shopware.calls).toEqual(["processors:sc-garden:reviews:false"]);
        expect(lines).toContain("Total deleted: 2");
    });

    test("an unknown processor fails before connecting", async () => {
        let connected = false;
        const lines = await cleanupSalesChannelData(
            { ...BASE, processors: ["unicorns"] },
            {
                cache,
                connect: async () => {
                    connected = true;
                    return shopware;
                },
            }
        );

        expect(errors(lines)[0]).toStartWith("Error: Unknown processor(s): unicorns");
        expect(connected).toBe(false);
    });

    test("a missing SalesChannel is an error for processor cleanup", async () => {
        const lines = await cleanupSalesChannelData(
            { ...BASE, salesChannel: "missing", processors: ["reviews"] },
            deps
        );

        expect(errors(lines)).toEqual(['Error: SalesChannel "missing" not found in Shopware.']);
        expect(shopware.calls).toEqual([]);
    });

    test("processor and core errors become Error lines (non-zero CLI exit)", async () => {
        shopware = fakeShopware({
            cleanupProcessors: async () => [
                { name: "reviews", deleted: 0, errors: ["boom"], durationMs: 0 },
            ],
            cleanupCore: async () => {
                throw new Error("core down");
            },
        });

        const lines = await cleanupSalesChannelData({ ...BASE, full: true }, deps);

        expect(errors(lines)).toEqual([
            "Error: Processor cleanup errors: reviews: boom",
            "Error: Core cleanup failed: core down",
        ]);
    });

    const coreSection = (lines: string[]): string[] => {
        const start = lines.indexOf("=== Core Cleanup ===");
        const end = lines.indexOf("", start);
        return lines.slice(start, end + 1);
    };

    test("core cleanup reports the options and counts", async () => {
        const plain = await cleanupSalesChannelData(BASE, deps);
        expect(coreSection(plain)).toEqual([
            "=== Core Cleanup ===",
            "Delete SalesChannel: No",
            "Delete property groups: No",
            "=== Core Cleanup Complete ===",
            "Products deleted: 5",
            "Categories deleted: 3",
            "",
        ]);

        const all = await cleanupSalesChannelData(
            { ...BASE, deleteProps: true, deleteSalesChannel: true },
            deps
        );
        expect(coreSection(all)).toEqual([
            "=== Core Cleanup ===",
            "Delete SalesChannel: Yes",
            "Delete property groups: Yes",
            "=== Core Cleanup Complete ===",
            "Products deleted: 5",
            "Categories deleted: 3",
            "Property groups deleted: 1",
            "SalesChannel deleted: Yes",
            "Root category deleted: Yes",
            "",
        ]);
    });

    test("core cleanup reports what was not deleted and its errors", async () => {
        shopware = fakeShopware({
            cleanupCore: async () => ({
                products: 0,
                categories: 0,
                propertyGroups: 0,
                salesChannelDeleted: false,
                rootCategoryDeleted: false,
                errors: ["a", "b"],
            }),
        });

        const lines = await cleanupSalesChannelData({ ...BASE, deleteSalesChannel: true }, deps);

        expect(lines).toContain("SalesChannel deleted: No");
        expect(lines).toContain("Root category deleted: No");
        expect(errors(lines)).toEqual(["Error: Core cleanup errors: a; b"]);
    });

    test("core dry run lists only the selected deletions", async () => {
        const plain = await cleanupSalesChannelData({ ...BASE, dryRun: true }, deps);
        expect(coreSection(plain)).toEqual([
            "=== Core Cleanup ===",
            "Delete SalesChannel: No",
            "Delete property groups: No",
            "[DRY RUN] Would delete:",
            '  - Products in SalesChannel "garden"',
            "  - Products of its cached blueprint (also without the SalesChannel)",
            "  - Categories under its root category",
            "",
        ]);

        const all = await cleanupSalesChannelData(
            { ...BASE, dryRun: true, deleteProps: true, deleteSalesChannel: true },
            deps
        );
        expect(all).toContain("  - All property groups");
        expect(all).toContain("  - The SalesChannel and its root category");
    });

    test("a failed core cleanup still shows the header", async () => {
        shopware = fakeShopware({
            cleanupCore: async () => {
                throw new Error("down");
            },
        });

        const lines = await cleanupSalesChannelData(BASE, deps);
        const start = lines.indexOf("=== Core Cleanup ===");

        expect(lines.slice(start, start + 4)).toEqual([
            "=== Core Cleanup ===",
            "Delete SalesChannel: No",
            "Delete property groups: No",
            "Error: Core cleanup failed: down",
        ]);
    });

    test("a failed connection is an error", async () => {
        const lines = await cleanupSalesChannelData(BASE, {
            cache,
            connect: async () => {
                throw new Error("SW_ENV_URL environment variable is required");
            },
        });

        expect(lines).toEqual(["Error: SW_ENV_URL environment variable is required"]);
    });

    test("hints at the local cache only when it exists", async () => {
        const without = await cleanupSalesChannelData(BASE, deps);
        cache.saveSalesChannelMetadata("garden", "Garden");
        const withCache = await cleanupSalesChannelData(BASE, deps);

        expect(without.some((l) => l.includes("cache_clear"))).toBe(false);
        expect(withCache.some((l) => l.includes("cache_clear"))).toBe(true);
    });

    test("global cleanups pass dryRun and sum their counts", async () => {
        const lines = await cleanupGlobal(
            { targets: ["unused-props", "unused-options", "orphaned-media"], dryRun: true },
            deps
        );

        expect(shopware.calls).toEqual([
            "unused-props:true",
            "unused-options:true",
            "orphaned-media:true",
        ]);
        expect(lines.at(-1)).toBe("Total entities that would be deleted: 11");
    });

    test("a failing global cleanup is an error, the others still run", async () => {
        shopware = fakeShopware({
            deleteUnusedPropertyGroups: async () => {
                throw new Error("timeout");
            },
        });

        const lines = await cleanupGlobal(
            { targets: ["unused-props", "orphaned-media"], dryRun: false },
            deps
        );

        expect(errors(lines)).toEqual(["Error: Unused Property Groups cleanup failed: timeout"]);
        expect(shopware.calls).toEqual(["orphaned-media:false"]);
    });

    test("resolveCleanupProcessors expands all and full", () => {
        expect(resolveCleanupProcessors(["all"], false)).toEqual(registry.getNames());
        expect(resolveCleanupProcessors([], true)).toEqual(registry.getNames());
        expect(resolveCleanupProcessors(["cms-home"], false)).toEqual(["cms-home"]);
    });
});
