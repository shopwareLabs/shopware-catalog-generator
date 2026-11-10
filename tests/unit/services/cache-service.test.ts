import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DataCache } from "../../../src/cache.js";
import {
    clearCache,
    emptyTrash,
    listCache,
    listTrash,
    restoreFromTrash,
    restoreTargetPath,
} from "../../../src/services/cache-service.js";

describe("cache-service", () => {
    let root: string;
    let cache: DataCache;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "cache-service-"));
        cache = new DataCache({ cacheDir: path.join(root, "generated") });
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const hasError = (lines: string[]): boolean => lines.some((l) => l.startsWith("Error:"));

    test("lists cached SalesChannels with their metadata", () => {
        expect(listCache(cache)).toEqual(["No cached data found."]);

        cache.saveSalesChannelMetadata("garden", "Garden tools", "sc-1");
        const lines = listCache(cache);

        expect(lines).toContain("  garden");
        expect(lines).toContain("    Description: Garden tools");
        expect(lines).toContain("    Shopware ID: sc-1");
        expect(lines.at(-1)).toBe("Total: 1 SalesChannel(s)");
    });

    test("clear prints what it moved (the CLI used to print nothing)", () => {
        cache.saveSalesChannelMetadata("garden", "Garden tools");

        const lines = clearCache({ salesChannel: "garden" }, cache);

        expect(lines[0]).toStartWith('Moved cache for "garden" to trash');
        expect(fs.existsSync(cache.getSalesChannelDir("garden"))).toBe(false);
        expect(cache.listTrash()).toHaveLength(1);
    });

    test("clear reports a missing SalesChannel without failing", () => {
        expect(clearCache({ salesChannel: "missing" }, cache)).toEqual([
            'No cache found for SalesChannel "missing".',
        ]);
    });

    test("restores a cleared SalesChannel into CACHE_DIR, not into generated/", () => {
        cache.saveSalesChannelMetadata("garden", "Garden tools");
        clearCache({ salesChannel: "garden" }, cache);
        const [item = ""] = cache.listTrash();

        expect(restoreTargetPath(cache, item)).toBe(cache.getSalesChannelDir("garden"));
        const lines = restoreFromTrash({ item }, cache);

        expect(hasError(lines)).toBe(false);
        expect(cache.loadSalesChannelMetadata("garden")?.description).toBe("Garden tools");
        expect(listTrash(cache)).toEqual(["Trash is empty."]);
    });

    test("restore never overwrites a non-empty target", () => {
        cache.saveSalesChannelMetadata("garden", "Old");
        clearCache({ salesChannel: "garden" }, cache);
        cache.saveSalesChannelMetadata("garden", "New");
        const [item = ""] = cache.listTrash();

        const lines = restoreFromTrash({ item }, cache);

        expect(lines[0]).toStartWith("Error: Restore target already exists");
        expect(cache.loadSalesChannelMetadata("garden")?.description).toBe("New");
        expect(cache.listTrash()).toEqual([item]);
    });

    test("restore all counts restored and skipped items", () => {
        cache.saveSalesChannelMetadata("garden", "Garden");
        cache.saveSalesChannelMetadata("music", "Music");
        clearCache({ salesChannel: "garden" }, cache);
        clearCache({ salesChannel: "music" }, cache);
        cache.saveSalesChannelMetadata("music", "New music");

        const lines = restoreFromTrash({ all: true }, cache);

        expect(lines[0]).toBe("Restore-all complete: 1 restored, 1 skipped, 0 failed");
        expect(hasError(lines)).toBe(false);
    });

    test("restore without item lists the trash", () => {
        expect(restoreFromTrash({}, cache)).toEqual(["Trash is empty."]);
        cache.saveSalesChannelMetadata("garden", "Garden");
        clearCache({ salesChannel: "garden" }, cache);

        expect(restoreFromTrash({}, cache)[0]).toBe("Please specify an item to restore:");
    });

    test("restoring an unknown item is an error", () => {
        expect(restoreFromTrash({ item: "nope" }, cache)[0]).toStartWith(
            'Error: Failed to restore "nope"'
        );
    });

    test("empty trash needs confirm", () => {
        cache.saveSalesChannelMetadata("garden", "Garden");
        clearCache({}, cache);

        expect(hasError(emptyTrash({ confirm: false }, cache))).toBe(true);
        expect(cache.listTrash()).toHaveLength(1);

        expect(emptyTrash({ confirm: true }, cache)).toEqual([
            "Permanently deleted 1 item(s) from trash.",
        ]);
        expect(emptyTrash({ confirm: true }, cache)).toEqual(["Trash is already empty."]);
    });
});
