import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DataCache } from "../../src/cache.js";

function runCacheCli(
    args: string[],
    cacheDir: string
): { stdout: string; stderr: string; exitCode: number } {
    const proc = Bun.spawnSync({
        cmd: [process.execPath, "run", "src/cache-cli.ts", ...args],
        cwd: process.cwd(),
        env: { ...process.env, CACHE_DIR: cacheDir },
        stdout: "pipe",
        stderr: "pipe",
    });

    return {
        stdout: Buffer.from(proc.stdout).toString("utf8"),
        stderr: Buffer.from(proc.stderr).toString("utf8"),
        exitCode: proc.exitCode,
    };
}

describe("cache-cli restore flags", () => {
    let tempDir: string;
    let cacheDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-cli-test-"));
        cacheDir = path.join(tempDir, "generated");
    });

    afterEach(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true });
        }
    });

    test("restore with no item shows choices and exits 0", () => {
        const cache = new DataCache({
            enabled: true,
            cacheDir,
            useCache: true,
            saveToCache: true,
        });
        cache.saveSalesChannelMetadata("music", "Music store");
        cache.clearAll(); // creates trash entry

        const result = runCacheCli(["restore"], cacheDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Please specify an item to restore");
        expect(result.stdout).toContain("bun run cache:restore -- --all");
    });

    test("restore --all restores and empties trash", () => {
        const cache = new DataCache({
            enabled: true,
            cacheDir,
            useCache: true,
            saveToCache: true,
        });
        cache.saveSalesChannelMetadata("music", "Music store");
        cache.clearSalesChannel("music"); // creates sales-channel-* trash item

        const result = runCacheCli(["restore", "--all"], cacheDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Restore-all complete");
        expect(result.stdout).toContain("restored");
    });
});

describe("cache-cli unknown commands", () => {
    test("an unknown command prints the usage and exits 1", () => {
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-cli-test-"));
        try {
            const result = runCacheCli(["lsit"], cacheDir);
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain("Unknown command: lsit");
            expect(result.stdout).toContain("cache:list");
        } finally {
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test("no command prints the usage and exits 0", () => {
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-cli-test-"));
        try {
            const result = runCacheCli([], cacheDir);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("cache:list");
        } finally {
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
    });
});
