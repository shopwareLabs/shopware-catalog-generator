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

function parseCliArgs(): CliArgs {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
        return { command: "help" };
    }

    const command = args[0] as CliArgs["command"];

    const flags: Record<string, string | boolean> = {};
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (!arg) continue;

        if (arg.startsWith("--")) {
            const parts = arg.slice(2).split("=");
            const key = parts[0] || "";
            let value: string | true = parts.length > 1 ? parts.slice(1).join("=") || "" : true;
            if (value === true) {
                const next = args[i + 1];
                if (next && !next.startsWith("-")) {
                    value = next;
                    i++;
                }
            }
            if (key) {
                flags[key] = value;
            }
        } else if (arg.startsWith("-")) {
            const key = arg.slice(1);
            if (key) {
                flags[key] = true;
            }
        } else if (
            (command === "blueprint" || command === "image" || command === "template") &&
            !flags.subcommand
        ) {
            flags.subcommand = arg;
        }
    }

    return {
        command,
        subcommand: flags.subcommand as CliArgs["subcommand"],
        name: flags.name as string | undefined,
        description: flags.description as string | undefined,
        url: flags.url as string | undefined,
        products: flags.products ? parseInt(flags.products as string, 10) : undefined,
        target: flags.target as string | undefined,
        interactive: flags.i === true || flags.interactive === true,
        only: flags.only ? (flags.only as string).split(",") : undefined,
        dryRun: flags["dry-run"] === true,
        noTemplate: flags["no-template"] === true,
        rehydrate: flags.rehydrate === true,
        type: flags.type as string | undefined,
        languages: typeof flags.languages === "string" ? flags.languages : undefined,
        formality: typeof flags.formality === "string" ? flags.formality : undefined,
        force: flags.force === true,
        e2e: typeof flags.e2e === "string" ? flags.e2e : undefined,
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

async function main(): Promise<void> {
    const args = parseCliArgs();

    try {
        switch (args.command) {
            case "blueprint":
                if (args.subcommand === "create") {
                    await blueprintCreate(args);
                } else if (args.subcommand === "estimate") {
                    await blueprintEstimate(args);
                } else if (args.subcommand === "hydrate") {
                    await blueprintHydrate(args);
                } else if (args.subcommand === "fix") {
                    await blueprintFix(args);
                } else if (args.subcommand === "inspire") {
                    await blueprintInspire(args);
                } else if (args.subcommand === "translate") {
                    await blueprintTranslate(args);
                } else {
                    showHelp();
                    throw new CLIError(
                        "blueprint requires subcommand: create, estimate, hydrate, translate, fix, or inspire",
                        "MISSING_SUBCOMMAND"
                    );
                }
                break;

            case "generate":
                await generate(args);
                break;

            case "process":
                await processCommand(args);
                break;

            case "image":
                if (args.subcommand === "fix") {
                    await imageFixCommand(args);
                } else {
                    showHelp();
                    throw new CLIError("image requires subcommand: fix", "MISSING_SUBCOMMAND");
                }
                break;

            case "template":
                if (args.subcommand === "metadata") {
                    await templateMetadataCommand(args);
                } else {
                    showHelp();
                    throw new CLIError(
                        "template requires subcommand: metadata",
                        "MISSING_SUBCOMMAND"
                    );
                }
                break;

            default:
                showHelp();
                break;
        }
    } catch (error) {
        if (error instanceof CLIError) {
            console.error(`\nError [${error.code}]: ${error.message}`);
            process.exit(error.exitCode);
        }
        console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

if (import.meta.main) main();
