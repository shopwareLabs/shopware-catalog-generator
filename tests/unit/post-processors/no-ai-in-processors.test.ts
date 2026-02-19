/**
 * Architectural test: No AI calls in post-processors
 *
 * Post-processors must NEVER call AI providers directly.
 * All AI generation (text + images) happens during blueprint hydration (Phase 2).
 * Post-processors only read from cache and upload to Shopware.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const POST_PROCESSORS_DIR = path.resolve(import.meta.dir, "../../../src/post-processors");

function collectTypeScriptFiles(dir: string): string[] {
    const files: string[] = [];

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectTypeScriptFiles(fullPath));
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
            files.push(fullPath);
        }
    }

    return files;
}

describe("no AI calls in post-processors", () => {
    const files = collectTypeScriptFiles(POST_PROCESSORS_DIR);

    test("should find post-processor files to check", () => {
        expect(files.length).toBeGreaterThan(0);
    });

    for (const filePath of files) {
        const relativePath = path.relative(POST_PROCESSORS_DIR, filePath);

        test(`${relativePath} must not call imageProvider.generateImage()`, () => {
            const content = fs.readFileSync(filePath, "utf-8");
            const matches = content.match(/\.generateImage\s*\(/g);
            expect(matches).toBeNull();
        });

        test(`${relativePath} must not call textProvider.generateCompletion()`, () => {
            const content = fs.readFileSync(filePath, "utf-8");
            const matches = content.match(/\.generateCompletion\s*\(/g);
            expect(matches).toBeNull();
        });
    }
});
