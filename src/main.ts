/**
 * Shopware Data Generator v2 - Main Entry Point
 *
 * Thin router: parses CLI args and delegates to focused CLI modules.
 *
 * Subcommand-based CLI:
 * - blueprint create   - Generate blueprint.json (no AI)
 * - blueprint hydrate  - AI fills blueprint -> hydrated-blueprint.json
 * - blueprint fix      - Fix placeholder names in hydrated blueprint
 * - generate           - Full flow: create + hydrate + upload to Shopware
 * - process            - Run post-processors on existing SalesChannel
 * - image fix          - Regenerate images for a specific product
 * - template metadata  - Write template.json (generator, models, languages, tested lanes)
 */

import type { CliArgs } from "./cli/shared.js";

import {
    blueprintCreate,
    blueprintFix,
    blueprintEstimate,
    blueprintHydrate,
    blueprintInspire,
    blueprintTranslate,
} from "./cli/blueprint.js";
import { generate, processCommand } from "./cli/generate.js";
import { imageFixCommand } from "./cli/image-fix.js";
import { CLIError, variantOverridesFromFlags } from "./cli/shared.js";
import { templateMetadataCommand } from "./cli/template.js";

export { CLIError, parseCliArgs };

// =============================================================================
// CLI Argument Parsing
// =============================================================================

type CliFlags = Record<string, string | boolean>;

/** Commands with a subcommand as first positional argument */
const COMMANDS_WITH_SUBCOMMAND = new Set(["blueprint", "image", "template"]);

/**
 * `--key=value`, `--key value` or `--key` (true). Returns how many arguments it used:
 * 2 when the value was the next argument, else 1.
 */
function applyLongFlag(flags: CliFlags, arg: string, next: string | undefined): number {
    const [key = "", ...rest] = arg.slice(2).split("=");
    const takesNext = rest.length === 0 && next !== undefined && !next.startsWith("-");
    const value = takesNext ? next : rest.length > 0 ? rest.join("=") : true;
    if (key) flags[key] = value;
    return takesNext ? 2 : 1;
}

/** `-k` is always a boolean flag; a lone `-` is ignored. */
function applyShortFlag(flags: CliFlags, arg: string): void {
    if (arg.length > 1) flags[arg.slice(1)] = true;
}

/** The first positional argument is the subcommand, for commands that have one. */
function applyPositional(flags: CliFlags, command: string, arg: string): void {
    if (arg && COMMANDS_WITH_SUBCOMMAND.has(command) && !flags.subcommand) {
        flags.subcommand = arg;
    }
}

/** Apply one argument to `flags` and return how many arguments it used. */
function applyArg(flags: CliFlags, command: string, arg: string, next: string | undefined): number {
    if (arg.startsWith("--")) return applyLongFlag(flags, arg, next);
    if (arg.startsWith("-")) {
        applyShortFlag(flags, arg);
        return 1;
    }
    applyPositional(flags, command, arg);
    return 1;
}

/**
 * Flags after the command: `--key=value`, `--key value`, `--key` (true) and `-k` (true).
 * The first positional argument becomes `subcommand` for commands that have one.
 */
function parseFlags(command: string, args: string[]): CliFlags {
    const flags: CliFlags = {};
    let i = 0;
    while (i < args.length) {
        i += applyArg(flags, command, args[i] ?? "", args[i + 1]);
    }
    return flags;
}

/** String value of a flag; a flag given without value is undefined */
const stringFlag = (flags: CliFlags, key: string): string | undefined => {
    const value = flags[key];
    return typeof value === "string" ? value : undefined;
};

function parseCliArgs(): CliArgs {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
        return { command: "help" };
    }

    const command = args[0] as CliArgs["command"];
    const flags = parseFlags(command, args.slice(1));
    const products = flags.products;
    const only = stringFlag(flags, "only");

    return {
        command,
        subcommand: stringFlag(flags, "subcommand") as CliArgs["subcommand"],
        name: stringFlag(flags, "name"),
        description: stringFlag(flags, "description"),
        url: stringFlag(flags, "url"),
        // A bare --products stays NaN, so validation rejects it instead of using the default
        products: products ? parseInt(String(products), 10) : undefined,
        target: stringFlag(flags, "target"),
        interactive: flags.i === true || flags.interactive === true,
        only: only ? only.split(",") : undefined,
        dryRun: flags["dry-run"] === true,
        noTemplate: flags["no-template"] === true,
        rehydrate: flags.rehydrate === true,
        type: stringFlag(flags, "type"),
        languages: stringFlag(flags, "languages"),
        formality: stringFlag(flags, "formality"),
        force: flags.force === true,
        e2e: stringFlag(flags, "e2e"),
        variants: variantOverridesFromFlags(flags),
    };
}

function showHelp(): void {
    console.log(`
Shopware Data Generator v2

Usage:
  bun run src/main.ts <command> [options]

Commands:
  blueprint create   Generate blueprint.json (no AI calls)
  blueprint estimate Forecast tokens, images and cost of 'blueprint hydrate' (no AI calls)
  blueprint hydrate  Hydrate blueprint with AI -> hydrated-blueprint.json
  blueprint translate Translate the hydrated catalog into other languages (AI)
  blueprint fix      Fix placeholder names in hydrated blueprint
  blueprint inspire  Crawl a website and save inspiration.json to guide AI generation
  generate           Full flow: create + hydrate + upload to Shopware
  process            Run post-processors on existing SalesChannel
  image fix          Regenerate images (product, category, cms, or theme)
  template metadata  Write template.json (generator, models, languages, tested Shopware versions)

Options:
  --name=<name>         SalesChannel name (required for most commands)
  --description=<text>  Store description for AI generation
  --url=<url>           Website URL to crawl (for blueprint inspire)
  --products=<n>        Number of products (default: 90)
  --target=<name>       Target name or ID (for image fix)
  --type=<type>         Image fix type: product, category, cms, or theme
  --only=<list>         Comma-separated list:
                        - For 'process': processor names (images, manufacturers, etc.)
                        - For 'blueprint hydrate' / 'blueprint estimate': categories, properties, cms, or variants
  --rehydrate           [blueprint hydrate only] Force full re-hydration (overwrites existing, changes product names)
  --languages=<list>    Languages to translate into (blueprint translate, estimate, generate):
                        all (SalesChannel languages, de-DE for a new one), none, or de-DE,fr-FR
                        Default: TRANSLATION_LANGUAGES env, else asks in a terminal, else none
  --variant-colors=<n>  Colours per colour variant product, 2-12 (default: 4, env VARIANT_COLORS)
  --variant-options=<n> Options per other variant group, 2-8 (default: 3, env VARIANT_OPTIONS)
  --max-variants=<n>    Max variants per product, 4-100 (default: 24, env MAX_VARIANTS)
  --variant-share=<x>   Share of products with variants, 0-1 (default: 0.3, env VARIANT_SHARE)
                        Set at blueprint create / generate; change colours, options and max later
                        with 'blueprint hydrate --only=variants' (the share is fixed per blueprint)
  --formality=<value>   [blueprint translate] formal or informal (default: AI decides per language)
  --force               [blueprint translate] Translate everything again (ignore cached translations)
  --dry-run             Log actions without executing
  --no-template         [generate only] Skip checking for pre-generated templates
  --e2e=<dir>           [template metadata] e2e-results/<timestamp> of a test-e2e-lanes.sh run
  -i, --interactive     Run interactive wizard

Examples:
  bun run src/main.ts blueprint inspire --name=furniture --url=https://example-furniture.com
  bun run src/main.ts blueprint create --name=furniture --description="Wood furniture store"
  bun run src/main.ts blueprint estimate --name=furniture                   # Cost forecast
  bun run src/main.ts blueprint hydrate --name=furniture
  bun run src/main.ts blueprint hydrate --name=furniture --only=categories  # Categories only
  bun run src/main.ts blueprint hydrate --name=furniture --only=properties  # Properties only
  bun run src/main.ts blueprint hydrate --name=furniture --rehydrate        # Full re-hydration
  bun run src/main.ts blueprint hydrate --name=furniture --only=variants --variant-colors=6
  bun run src/main.ts blueprint translate --name=furniture --languages=de-DE,fr-FR
  bun run src/main.ts blueprint fix --name=furniture
  bun run src/main.ts generate --name=furniture --description="Wood furniture store"
  bun run src/main.ts process --name=furniture --only=images,manufacturers
  bun run src/main.ts image fix --name=beauty --target="Eyelash Curler - Silver"
  bun run src/main.ts image fix --name=beauty --type=theme --target=logo
  bun run src/main.ts template metadata --name=beauty --e2e=e2e-results/20261109-123512
`);
}

// =============================================================================
// Main Router
// =============================================================================

type CommandRun = (args: CliArgs) => Promise<void>;

/** What the router does for a parsed command line. */
type CommandRoute =
    | { kind: "run"; run: CommandRun }
    | { kind: "help" }
    | { kind: "missing-subcommand"; message: string };

interface SubcommandGroup {
    subcommands: Map<string, CommandRun>;
    missingMessage: string;
}

const COMMANDS = new Map<string, CommandRun>([
    ["generate", generate],
    ["process", processCommand],
]);

const SUBCOMMAND_GROUPS = new Map<string, SubcommandGroup>([
    [
        "blueprint",
        {
            subcommands: new Map<string, CommandRun>([
                ["create", blueprintCreate],
                ["estimate", blueprintEstimate],
                ["hydrate", blueprintHydrate],
                ["fix", blueprintFix],
                ["inspire", blueprintInspire],
                ["translate", blueprintTranslate],
            ]),
            missingMessage:
                "blueprint requires subcommand: create, estimate, hydrate, translate, fix, or inspire",
        },
    ],
    [
        "image",
        {
            subcommands: new Map<string, CommandRun>([["fix", imageFixCommand]]),
            missingMessage: "image requires subcommand: fix",
        },
    ],
    [
        "template",
        {
            subcommands: new Map<string, CommandRun>([["metadata", templateMetadataCommand]]),
            missingMessage: "template requires subcommand: metadata",
        },
    ],
]);

/** Find the CLI module for a command (and subcommand). Unknown commands show the help. */
export function resolveCommand(args: Pick<CliArgs, "command" | "subcommand">): CommandRoute {
    const run = COMMANDS.get(args.command);
    if (run) return { kind: "run", run };

    const group = SUBCOMMAND_GROUPS.get(args.command);
    if (!group) return { kind: "help" };

    const subcommand = group.subcommands.get(args.subcommand ?? "");
    if (!subcommand) return { kind: "missing-subcommand", message: group.missingMessage };
    return { kind: "run", run: subcommand };
}

async function runCommand(args: CliArgs): Promise<void> {
    const route = resolveCommand(args);
    if (route.kind === "run") {
        await route.run(args);
        return;
    }
    showHelp();
    if (route.kind === "missing-subcommand") {
        throw new CLIError(route.message, "MISSING_SUBCOMMAND");
    }
}

function exitWithError(error: unknown): never {
    if (error instanceof CLIError) {
        console.error(`\nError [${error.code}]: ${error.message}`);
        process.exit(error.exitCode);
    }
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}

async function main(): Promise<void> {
    const args = parseCliArgs();
    try {
        await runCommand(args);
    } catch (error) {
        exitWithError(error);
    }
}

if (import.meta.main) main();
