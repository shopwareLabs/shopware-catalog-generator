/**
 * Version of this generator, recorded in template metadata.
 */

import fs from "node:fs";
import path from "node:path";

import type { GeneratorInfo } from "../types/index.js";

const PACKAGE_NAME = "shopware-data-generator";

let cached: GeneratorInfo | undefined;

/** Walk up from a directory to the generator's package.json */
export function findPackageRoot(startDir: string): string | undefined {
    let dir = startDir;
    for (let depth = 0; depth < 6; depth++) {
        const candidate = path.join(dir, "package.json");
        if (fs.existsSync(candidate) && readPackageName(candidate) === PACKAGE_NAME) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
    return undefined;
}

function readPackageName(file: string): string | undefined {
    return readPackageField(file, "name");
}

function readPackageField(file: string, field: string): string | undefined {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (typeof parsed !== "object" || parsed === null) return undefined;
        const value: unknown = Reflect.get(parsed, field);
        return typeof value === "string" ? value : undefined;
    } catch {
        return undefined;
    }
}

function readGitCommit(root: string): string | undefined {
    try {
        const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
            cwd: root,
            stdout: "pipe",
            stderr: "ignore",
        });
        if (result.exitCode !== 0) return undefined;
        const commit = result.stdout.toString().trim();
        return commit || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Generator version from package.json plus the short git commit when available.
 * Read once per process.
 */
export function getGeneratorInfo(): GeneratorInfo {
    if (cached) return cached;
    const root = findPackageRoot(import.meta.dir);
    if (!root) {
        cached = { version: "unknown" };
        return cached;
    }
    const version = readPackageField(path.join(root, "package.json"), "version") ?? "unknown";
    const commit = readGitCommit(root);
    cached = commit ? { version, commit } : { version };
    return cached;
}
