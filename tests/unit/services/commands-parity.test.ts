/**
 * Parity: the CLI and the MCP server must call the services the same way for every command
 * built from a shared spec (src/services/commands.ts).
 *
 * Each case is written once per surface (CLI argv, MCP arguments) and run through the real
 * entry point of that surface with recording services. A new parameter only needs a case
 * here: if one surface does not pass it on, this test fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CliArgs } from "../../../src/cli/shared.js";
import type { CommandServices } from "../../../src/services/commands.js";

import {
    blueprintCreate,
    blueprintEstimate,
    blueprintFix,
    blueprintHydrate,
    blueprintInspire,
    blueprintTranslate,
} from "../../../src/cli/blueprint.js";
import { processCommand } from "../../../src/cli/generate.js";
import { imageFixCommand } from "../../../src/cli/image-fix.js";
import { templateMetadataCommand } from "../../../src/cli/template.js";
import { parseCliArgs } from "../../../src/main.js";
import { executeCommandTool } from "../../../src/mcp/tools/command-tool.js";
import {
    BLUEPRINT_CREATE,
    BLUEPRINT_ESTIMATE,
    BLUEPRINT_FIX,
    BLUEPRINT_HYDRATE,
    BLUEPRINT_INSPIRE,
    BLUEPRINT_TRANSLATE,
    IMAGE_FIX,
    PROCESS,
    TEMPLATE_METADATA,
} from "../../../src/services/commands.js";
import { recordingServices, type ServiceCall } from "../../helpers/recording-services.js";

type CliCommand = (args: CliArgs, services: Partial<CommandServices>) => Promise<void>;
type McpCommand = (args: unknown, services: Partial<CommandServices>) => Promise<string>;

interface Surface {
    cli: CliCommand;
    mcp: McpCommand;
}

const SURFACES = {
    "blueprint create": {
        cli: blueprintCreate,
        mcp: (a, services) => executeCommandTool(BLUEPRINT_CREATE, a, { services }),
    },
    "blueprint estimate": {
        cli: blueprintEstimate,
        mcp: (a, services) => executeCommandTool(BLUEPRINT_ESTIMATE, a, { services }),
    },
    "blueprint translate": {
        cli: blueprintTranslate,
        mcp: (a, services) => executeCommandTool(BLUEPRINT_TRANSLATE, a, { services }),
    },
    "blueprint hydrate": {
        cli: blueprintHydrate,
        mcp: (a, services) => executeCommandTool(BLUEPRINT_HYDRATE, a, { services }),
    },
    "blueprint inspire": {
        cli: blueprintInspire,
        mcp: (a, services) => executeCommandTool(BLUEPRINT_INSPIRE, a, { services }),
    },
    "blueprint fix": {
        cli: blueprintFix,
        mcp: (a, services) => executeCommandTool(BLUEPRINT_FIX, a, { services }),
    },
    "image fix": {
        cli: imageFixCommand,
        mcp: (a, services) => executeCommandTool(IMAGE_FIX, a, { services }),
    },
    "template metadata": {
        cli: templateMetadataCommand,
        mcp: (a, services) => executeCommandTool(TEMPLATE_METADATA, a, { services }),
    },
    process: {
        cli: (args, services) =>
            processCommand(args, { services, verifyConnection: async () => undefined }),
        mcp: (a, services) => executeCommandTool(PROCESS, a, { services }),
    },
} satisfies Record<string, Surface>;

type CommandName = keyof typeof SURFACES;

interface ParityCase {
    command: CommandName;
    label: string;
    cli: string[];
    mcp: Record<string, unknown>;
}

function parseArgv(command: CommandName, argv: string[]): CliArgs {
    const orig = process.argv;
    process.argv = ["bun", "src/main.ts", ...command.split(" "), ...argv];
    try {
        return parseCliArgs();
    } finally {
        process.argv = orig;
    }
}

async function viaCli(
    command: CommandName,
    argv: string[]
): Promise<{ calls: ServiceCall[]; error?: string }> {
    const calls: ServiceCall[] = [];
    const log = console.log;
    console.log = () => {};
    try {
        await SURFACES[command].cli(parseArgv(command, argv), recordingServices(calls));
        return { calls };
    } catch (error) {
        return { calls, error: error instanceof Error ? error.message : String(error) };
    } finally {
        console.log = log;
    }
}

async function viaMcp(
    command: CommandName,
    args: Record<string, unknown>
): Promise<{ calls: ServiceCall[]; output: string }> {
    const calls: ServiceCall[] = [];
    const output = await SURFACES[command].mcp(args, recordingServices(calls));
    return { calls, output };
}

const CASES: ParityCase[] = [
    {
        command: "blueprint create",
        label: "defaults (description, 90 products)",
        cli: ["--name=garden"],
        mcp: { name: "garden" },
    },
    {
        command: "blueprint create",
        label: "every option",
        cli: [
            "--name=Garden-Shop",
            "--description=Plants and tools",
            "--products=12",
            "--variant-colors=6",
            "--variant-options=2",
            "--max-variants=30",
            "--variant-share=0.5",
        ],
        mcp: {
            name: "Garden-Shop",
            description: "Plants and tools",
            products: 12,
            variantColors: 6,
            variantOptions: 2,
            maxVariants: 30,
            variantShare: 0.5,
        },
    },
    {
        command: "blueprint estimate",
        label: "selective with languages and variant settings",
        cli: ["--name=garden", "--only=variants", "--languages=de-DE,fr-FR", "--variant-colors=8"],
        mcp: { name: "garden", only: "variants", languages: "de-DE,fr-FR", variantColors: 8 },
    },
    {
        command: "blueprint estimate",
        label: "without languages",
        cli: ["--name=garden"],
        mcp: { name: "garden" },
    },
    {
        command: "blueprint translate",
        label: "defaults (all languages)",
        cli: ["--name=garden"],
        mcp: { name: "garden" },
    },
    {
        command: "blueprint translate",
        label: "every option",
        cli: ["--name=garden", "--languages=fr-FR", "--formality=informal", "--force"],
        mcp: { name: "garden", languages: "fr-FR", formality: "informal", force: true },
    },
    {
        command: "blueprint hydrate",
        label: "defaults",
        cli: ["--name=garden"],
        mcp: { name: "garden" },
    },
    {
        command: "blueprint hydrate",
        label: "only, rehydrate and variant settings",
        cli: ["--name=garden", "--only=variants", "--rehydrate", "--max-variants=12"],
        mcp: { name: "garden", only: "variants", rehydrate: true, maxVariants: 12 },
    },
    {
        command: "blueprint inspire",
        label: "url",
        cli: ["--name=garden", "--url=https://www.example.com/"],
        mcp: { name: "garden", url: "https://www.example.com/" },
    },
    {
        command: "blueprint fix",
        label: "name",
        cli: ["--name=garden"],
        mcp: { name: "garden" },
    },
    {
        command: "image fix",
        label: "defaults (product)",
        cli: ["--name=garden", "--target=Rose Pot"],
        mcp: { name: "garden", target: "Rose Pot" },
    },
    {
        command: "image fix",
        label: "theme dry run",
        cli: ["--name=garden", "--type=theme", "--target=logo", "--dry-run"],
        mcp: { name: "garden", type: "theme", target: "logo", dryRun: true },
    },
    {
        command: "template metadata",
        label: "e2e directory",
        cli: ["--name=garden", "--e2e=e2e-results/2026-11-10"],
        mcp: { name: "garden", e2e: "e2e-results/2026-11-10" },
    },
    {
        command: "process",
        label: "all processors",
        cli: ["--name=garden"],
        mcp: { name: "garden" },
    },
    {
        command: "process",
        label: "selected processors, dry run",
        cli: ["--name=garden", "--only=images,reviews", "--dry-run"],
        mcp: { name: "garden", processors: ["images", "reviews"], dryRun: true },
    },
];

const INVALID_CASES: ParityCase[] = [
    {
        command: "blueprint create",
        label: "products not positive",
        cli: ["--name=garden", "--products=0"],
        mcp: { name: "garden", products: 0 },
    },
    {
        command: "blueprint create",
        label: "variant colours out of range",
        cli: ["--name=garden", "--variant-colors=99"],
        mcp: { name: "garden", variantColors: 99 },
    },
    {
        command: "blueprint create",
        label: "variant flag without a value",
        cli: ["--name=garden", "--variant-share"],
        mcp: { name: "garden", variantShare: Number.NaN },
    },
    {
        command: "blueprint estimate",
        label: "unknown --only mode",
        cli: ["--name=garden", "--only=everything"],
        mcp: { name: "garden", only: "everything" },
    },
    {
        command: "blueprint translate",
        label: "invalid languages",
        cli: ["--name=garden", "--languages=xx_invalid"],
        mcp: { name: "garden", languages: "xx_invalid" },
    },
    {
        command: "blueprint translate",
        label: "unknown formality",
        cli: ["--name=garden", "--formality=casual"],
        mcp: { name: "garden", formality: "casual" },
    },
    {
        command: "blueprint inspire",
        label: "missing url",
        cli: ["--name=garden"],
        mcp: { name: "garden" },
    },
    {
        command: "blueprint fix",
        label: "missing name",
        cli: [],
        mcp: {},
    },
    {
        command: "blueprint hydrate",
        label: "invalid name",
        cli: ["--name=!!!"],
        mcp: { name: "!!!" },
    },
    {
        command: "image fix",
        label: "unknown type",
        cli: ["--name=garden", "--type=video", "--target=x"],
        mcp: { name: "garden", type: "video", target: "x" },
    },
    {
        command: "process",
        label: "unknown processor",
        cli: ["--name=garden", "--only=images,unicorns"],
        mcp: { name: "garden", processors: ["images", "unicorns"] },
    },
];

describe("command parity: CLI and MCP", () => {
    let savedLanguages: string | undefined;

    beforeEach(() => {
        savedLanguages = process.env.TRANSLATION_LANGUAGES;
        delete process.env.TRANSLATION_LANGUAGES;
    });

    afterEach(() => {
        if (savedLanguages === undefined) delete process.env.TRANSLATION_LANGUAGES;
        else process.env.TRANSLATION_LANGUAGES = savedLanguages;
    });

    for (const c of CASES) {
        test(`${c.command}: ${c.label}`, async () => {
            const cli = await viaCli(c.command, c.cli);
            const mcp = await viaMcp(c.command, c.mcp);

            expect(cli.error).toBeUndefined();
            expect(cli.calls.length).toBeGreaterThan(0);
            expect(mcp.calls).toEqual(cli.calls);
        });
    }

    for (const c of INVALID_CASES) {
        test(`${c.command} rejects ${c.label} on both surfaces`, async () => {
            const cli = await viaCli(c.command, c.cli);
            const mcp = await viaMcp(c.command, c.mcp);

            expect(cli.error).toBeDefined();
            expect(mcp.output.startsWith("Error:")).toBe(true);
            expect(cli.calls).toHaveLength(0);
            expect(mcp.calls).toHaveLength(0);
        });
    }

    test("TRANSLATION_LANGUAGES is the default for estimate and translate", async () => {
        process.env.TRANSLATION_LANGUAGES = "de-DE";

        for (const command of ["blueprint estimate", "blueprint translate"] as const) {
            const cli = await viaCli(command, ["--name=garden"]);
            const mcp = await viaMcp(command, { name: "garden" });
            const explicit = await viaMcp(command, { name: "garden", languages: "de-DE" });

            expect(mcp.calls).toEqual(cli.calls);
            expect(mcp.calls).toEqual(explicit.calls);
        }
    });

    test("the CLI names flags in errors, MCP names parameters", async () => {
        const cli = await viaCli("blueprint create", ["--name=garden", "--variant-colors=99"]);
        const mcp = await viaMcp("blueprint create", { name: "garden", variantColors: 99 });

        expect(cli.error).toStartWith("--variant-colors:");
        expect(mcp.output).toStartWith("Error: variantColors:");
    });

    test("the same invalid name message on both surfaces", async () => {
        const cli = await viaCli("blueprint fix", ["--name=!!!"]);
        const mcp = await viaMcp("blueprint fix", { name: "!!!" });

        expect(mcp.output).toBe(`Error: ${cli.error}`);
    });

    test("process checks the Shopware connection only for valid arguments", async () => {
        let checks = 0;
        const verifyConnection = async (): Promise<void> => {
            checks++;
        };
        const log = console.log;
        console.log = () => {};
        try {
            await processCommand(parseArgv("process", ["--name=garden", "--only=unicorns"]), {
                services: recordingServices([]),
                verifyConnection,
            }).catch(() => undefined);
            await processCommand(parseArgv("process", ["--name=garden"]), {
                services: recordingServices([]),
                verifyConnection,
            });
        } finally {
            console.log = log;
        }

        expect(checks).toBe(1);
    });
});
