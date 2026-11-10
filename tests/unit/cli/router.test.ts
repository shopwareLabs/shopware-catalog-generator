import { describe, expect, test } from "bun:test";

import type { CliArgs } from "../../../src/cli/shared.js";

import {
    blueprintCreate,
    blueprintEstimate,
    blueprintFix,
    blueprintHydrate,
    blueprintInspire,
    blueprintTranslate,
} from "../../../src/cli/blueprint.js";
import { generate, processCommand } from "../../../src/cli/generate.js";
import { imageFixCommand } from "../../../src/cli/image-fix.js";
import { templateMetadataCommand } from "../../../src/cli/template.js";
import { parseCliArgs, resolveCommand } from "../../../src/main.js";

function runOf(command: CliArgs["command"], subcommand?: CliArgs["subcommand"]): unknown {
    const route = resolveCommand({ command, subcommand });
    return route.kind === "run" ? route.run : route;
}

describe("resolveCommand", () => {
    test("routes commands without subcommand", () => {
        expect(runOf("generate")).toBe(generate);
        expect(runOf("process")).toBe(processCommand);
    });

    test("ignores a subcommand on commands that have none", () => {
        expect(runOf("generate", "create")).toBe(generate);
    });

    test("routes every blueprint subcommand", () => {
        expect(runOf("blueprint", "create")).toBe(blueprintCreate);
        expect(runOf("blueprint", "estimate")).toBe(blueprintEstimate);
        expect(runOf("blueprint", "hydrate")).toBe(blueprintHydrate);
        expect(runOf("blueprint", "fix")).toBe(blueprintFix);
        expect(runOf("blueprint", "inspire")).toBe(blueprintInspire);
        expect(runOf("blueprint", "translate")).toBe(blueprintTranslate);
    });

    test("routes image fix and template metadata", () => {
        expect(runOf("image", "fix")).toBe(imageFixCommand);
        expect(runOf("template", "metadata")).toBe(templateMetadataCommand);
    });

    test("reports a missing or unknown subcommand with the command's message", () => {
        expect(resolveCommand({ command: "blueprint" })).toEqual({
            kind: "missing-subcommand",
            message:
                "blueprint requires subcommand: create, estimate, hydrate, translate, fix, or inspire",
        });
        expect(resolveCommand({ command: "image", subcommand: "create" })).toEqual({
            kind: "missing-subcommand",
            message: "image requires subcommand: fix",
        });
        expect(resolveCommand({ command: "template", subcommand: "fix" })).toEqual({
            kind: "missing-subcommand",
            message: "template requires subcommand: metadata",
        });
    });

    test("shows the help for help and unknown commands", () => {
        expect(resolveCommand({ command: "help" })).toEqual({ kind: "help" });
        // parseCliArgs passes any first argument through as the command
        const orig = process.argv;
        process.argv = ["bun", "src/main.ts", "toString", "--name=shop"];
        try {
            expect(resolveCommand(parseCliArgs())).toEqual({ kind: "help" });
        } finally {
            process.argv = orig;
        }
    });
});
