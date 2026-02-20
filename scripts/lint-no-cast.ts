#!/usr/bin/env bun
export {};

/**
 * Lint check: disallow `as unknown` type casts.
 *
 * `as unknown` is almost always an intermediate step in a double assertion
 * (`x as unknown as T`) that bypasses TypeScript's type checker. Use proper
 * type guards, Object.assign, or a single-level cast instead.
 *
 * Run: bun run scripts/lint-no-cast.ts
 * Or via: bun run lint
 */
const pattern = /\bas unknown\b/;
const violations: string[] = [];

const globber = new Bun.Glob("src/**/*.ts");
for await (const file of globber.scan(".")) {
    const lines = (await Bun.file(file).text()).split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
            violations.push(`  ${file}:${i + 1}  ${lines[i].trim()}`);
        }
    }
}

if (violations.length > 0) {
    console.error("\x1b[31mERROR: Disallowed `as unknown` casts found:\x1b[0m");
    for (const v of violations) {
        console.error(v);
    }
    console.error(
        "\nUse type guards, Object.assign, or a single-level cast instead.\n" +
            "See: typescript/no-unsafe-type-assertion"
    );
    process.exit(1);
}

console.log("✓ No `as unknown` casts found.");
