/**
 * Parity for the cache and cleanup commands: the cache CLI, the cleanup CLI and the MCP tools
 * must call the services the same way (shared specs in src/services/commands.ts).
 *
 * Each case is written once per surface (CLI argv, MCP arguments) and run through the real
 * entry point with recording services. A new parameter only needs a case here.
 */

import type { z } from "zod";

import { describe, expect, test } from "bun:test";

import type { CommandServices, CommandSpec } from "../../../src/services/commands.js";

import { runCacheCli } from "../../../src/cache-cli.js";
import { parseCleanupArgs, runCleanupCli } from "../../../src/cleanup-cli.js";
import { executeCommandTool } from "../../../src/mcp/tools/command-tool.js";
import {
    CACHE_CLEAR,
    CACHE_EMPTY_TRASH,
    CACHE_LIST,
    CACHE_RESTORE,
    CACHE_TRASH,
    CLEANUP,
    CLEANUP_MEDIA,
    CLEANUP_UNUSED_OPTIONS,
    CLEANUP_UNUSED_PROPS,
} from "../../../src/services/commands.js";
import { recordingServices, type ServiceCall } from "../../helpers/recording-services.js";

type Cli = (argv: string[], services: Partial<CommandServices>) => Promise<void>;

/** One MCP tool call, bound to its spec (specs differ in their parameter shape) */
type McpCall = (services: CommandServices) => Promise<string>;

function tool<Shape extends z.ZodRawShape>(
    spec: CommandSpec<Shape>,
    args: Record<string, unknown>
): McpCall {
    return (services) => executeCommandTool(spec, args, { services });
}

interface ParityCase {
    label: string;
    cli: { run: Cli; argv: string[] };
    /** One or more tool calls (the cleanup CLI can run several global cleanups at once) */
    mcp: McpCall[];
}

const cache = (argv: string[]): ParityCase["cli"] => ({ run: runCacheCli, argv });
const cleanup = (argv: string[]): ParityCase["cli"] => ({ run: runCleanupCli, argv });

const CASES: ParityCase[] = [
    { label: "cache list", cli: cache(["list"]), mcp: [tool(CACHE_LIST, {})] },
    { label: "cache clear all", cli: cache(["clear"]), mcp: [tool(CACHE_CLEAR, {})] },
    {
        label: "cache clear one SalesChannel",
        cli: cache(["clear", "garden"]),
        mcp: [tool(CACHE_CLEAR, { salesChannel: "garden" })],
    },
    { label: "cache trash", cli: cache(["trash"]), mcp: [tool(CACHE_TRASH, {})] },
    {
        label: "cache restore item",
        cli: cache(["restore", "sales-channel-garden-2026-11-10T10-00-00-000Z"]),
        mcp: [tool(CACHE_RESTORE, { item: "sales-channel-garden-2026-11-10T10-00-00-000Z" })],
    },
    {
        label: "cache restore all",
        cli: cache(["restore", "--all"]),
        mcp: [tool(CACHE_RESTORE, { all: true })],
    },
    {
        label: "cache empty-trash without confirm",
        cli: cache(["empty-trash"]),
        mcp: [tool(CACHE_EMPTY_TRASH, {})],
    },
    {
        label: "cache empty-trash confirmed",
        cli: cache(["empty-trash", "--confirm"]),
        mcp: [tool(CACHE_EMPTY_TRASH, { confirm: true })],
    },
    {
        label: "cleanup core",
        cli: cleanup(["--salesChannel=garden"]),
        mcp: [tool(CLEANUP, { salesChannel: "garden" })],
    },
    {
        label: "cleanup core with SalesChannel and properties, dry run",
        cli: cleanup(['--salesChannel="garden"', "--delete", "--props", "--dry-run"]),
        mcp: [
            tool(CLEANUP, {
                salesChannel: "garden",
                deleteSalesChannel: true,
                deleteProps: true,
                dryRun: true,
            }),
        ],
    },
    {
        label: "cleanup processors",
        cli: cleanup(["--salesChannel=garden", "--processors=cms-home, reviews"]),
        mcp: [tool(CLEANUP, { salesChannel: "garden", processors: ["cms-home", "reviews"] })],
    },
    {
        label: "cleanup all processors (--only alias)",
        cli: cleanup(["--salesChannel=garden", "--only=all"]),
        mcp: [tool(CLEANUP, { salesChannel: "garden", processors: ["all"] })],
    },
    {
        label: "cleanup --manufacturers is the manufacturers processor",
        cli: cleanup(["--salesChannel=garden", "--manufacturers"]),
        mcp: [tool(CLEANUP, { salesChannel: "garden", processors: ["manufacturers"] })],
    },
    {
        label: "cleanup full with SalesChannel",
        cli: cleanup(["--salesChannel=garden", "--full", "--delete-salesChannel"]),
        mcp: [tool(CLEANUP, { salesChannel: "garden", full: true, deleteSalesChannel: true })],
    },
    {
        label: "cleanup orphaned media",
        cli: cleanup(["--orphaned-media"]),
        mcp: [tool(CLEANUP_MEDIA, {})],
    },
    {
        label: "cleanup unused properties, dry run",
        cli: cleanup(["--unused-props", "--dry-run"]),
        mcp: [tool(CLEANUP_UNUSED_PROPS, { dryRun: true })],
    },
    {
        label: "cleanup unused options",
        cli: cleanup(["--unused-options"]),
        mcp: [tool(CLEANUP_UNUSED_OPTIONS, {})],
    },
    {
        label: "several global cleanups in one CLI call",
        cli: cleanup(["--media", "--unused-properties", "--unused-options"]),
        mcp: [
            tool(CLEANUP_UNUSED_PROPS, {}),
            tool(CLEANUP_UNUSED_OPTIONS, {}),
            tool(CLEANUP_MEDIA, {}),
        ],
    },
];

const INVALID_CASES: ParityCase[] = [
    {
        label: "an unknown processor",
        cli: cleanup(["--salesChannel=garden", "--processors=unicorns"]),
        mcp: [tool(CLEANUP, { salesChannel: "garden", processors: ["unicorns"] })],
    },
];

async function viaCli(c: ParityCase): Promise<{ calls: ServiceCall[]; error?: string }> {
    const calls: ServiceCall[] = [];
    const log = console.log;
    console.log = () => {};
    try {
        await c.cli.run(c.cli.argv, recordingServices(calls));
        return { calls };
    } catch (error) {
        return { calls, error: error instanceof Error ? error.message : String(error) };
    } finally {
        console.log = log;
    }
}

async function viaMcp(c: ParityCase): Promise<{ calls: ServiceCall[]; outputs: string[] }> {
    const calls: ServiceCall[] = [];
    const services = recordingServices(calls);
    const outputs: string[] = [];
    for (const call of c.mcp) {
        outputs.push(await call(services));
    }
    return { calls, outputs };
}

describe("cache and cleanup: CLI ↔ MCP parity", () => {
    for (const c of CASES) {
        test(c.label, async () => {
            const cli = await viaCli(c);
            const mcp = await viaMcp(c);

            expect(cli.error).toBeUndefined();
            expect(cli.calls.length).toBeGreaterThan(0);
            expect(mcp.calls).toEqual(cli.calls);
        });
    }

    for (const c of INVALID_CASES) {
        test(`rejects ${c.label} on both surfaces`, async () => {
            const cli = await viaCli(c);
            const mcp = await viaMcp(c);

            expect(cli.error).toBeDefined();
            expect(mcp.outputs.every((o) => o.startsWith("Error:"))).toBe(true);
            expect(cli.calls).toHaveLength(0);
            expect(mcp.calls).toHaveLength(0);
        });
    }

    test("the cleanup CLI names --processors in errors, MCP names processors", async () => {
        const [invalid] = INVALID_CASES;
        if (!invalid) throw new Error("missing invalid case");
        const cli = await viaCli(invalid);
        const mcp = await viaMcp(invalid);

        expect(cli.error).toStartWith("--processors:");
        expect(mcp.outputs[0]).toStartWith("Error: processors:");
    });

    test("cleanup without SalesChannel or global flag runs nothing", async () => {
        const cli = await viaCli({ label: "help", cli: cleanup([]), mcp: [] });
        const help = await viaCli({ label: "help", cli: cleanup(["--help"]), mcp: [] });
        const cacheHelp = await viaCli({ label: "help", cli: cache(["unknown"]), mcp: [] });

        expect(cli.calls).toHaveLength(0);
        expect(help.calls).toHaveLength(0);
        expect(cacheHelp.calls).toHaveLength(0);
    });

    test("parseCleanupArgs keeps all flag aliases", () => {
        expect(parseCleanupArgs(["--delete-props", "--delete-manufacturers", "-h"])).toMatchObject({
            deleteProps: true,
            processors: ["manufacturers"],
            help: true,
        });
    });
});
