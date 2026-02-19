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
 */

import type { CliArgs } from "./cli/shared.js";

import { blueprintCreate, blueprintFix, blueprintHydrate } from "./cli/blueprint.js";
import { generate, processCommand } from "./cli/generate.js";
import { imageFixCommand } from "./cli/image-fix.js";
import { CLIError } from "./cli/shared.js";

export { CLIError };

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
            const value = parts[1];
            if (key) {
                flags[key] = value ?? true;
            }
        } else if (arg.startsWith("-")) {
            const key = arg.slice(1);
            if (key) {
                flags[key] = true;
            }
        } else if ((command === "blueprint" || command === "image") && !flags.subcommand) {
            flags.subcommand = arg;
        }
    }

    return {
        command,
        subcommand: flags.subcommand as CliArgs["subcommand"],
        name: flags.name as string | undefined,
        description: flags.description as string | undefined,
        products: flags.products ? parseInt(flags.products as string, 10) : undefined,
        product: flags.product as string | undefined,
        interactive: flags.i === true || flags.interactive === true,
        only: flags.only ? (flags.only as string).split(",") : undefined,
        dryRun: flags["dry-run"] === true,
        noTemplate: flags["no-template"] === true,
        force: flags.force === true,
        type: flags.type as string | undefined,
    };
}

function showHelp(): void {
    console.log(`
Shopware Data Generator v2

Usage:
  bun run src/main.ts <command> [options]

Commands:
  blueprint create   Generate blueprint.json (no AI calls)
  blueprint hydrate  Hydrate blueprint with AI -> hydrated-blueprint.json
  blueprint fix      Fix placeholder names in hydrated blueprint
  generate           Full flow: create + hydrate + upload to Shopware
  process            Run post-processors on existing SalesChannel
  image fix          Regenerate images for a specific product

Options:
  --name=<name>         SalesChannel name (required for most commands)
  --description=<text>  Store description for AI generation
  --products=<n>        Number of products (default: 90)
  --product=<name>      Product name or ID (for image fix)
  --only=<list>         Comma-separated list:
                        - For 'process': processor names (images, manufacturers, etc.)
                        - For 'blueprint hydrate': categories or properties
  --force               Force full re-hydration (overwrites existing, changes product names)
  --dry-run             Log actions without executing
  --no-template         Skip checking for pre-generated templates
  -i, --interactive     Run interactive wizard

Examples:
  bun run src/main.ts blueprint create --name=furniture --description="Wood furniture store"
  bun run src/main.ts blueprint hydrate --name=furniture
  bun run src/main.ts blueprint hydrate --name=furniture --only=categories  # Categories only
  bun run src/main.ts blueprint hydrate --name=furniture --only=properties  # Properties only
  bun run src/main.ts blueprint hydrate --name=furniture --force            # Full re-hydration
  bun run src/main.ts blueprint fix --name=furniture
  bun run src/main.ts generate --name=furniture --description="Wood furniture store"
  bun run src/main.ts process --name=furniture --only=images,manufacturers
  bun run src/main.ts image fix --name=beauty --product="Eyelash Curler - Silver"
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
                } else if (args.subcommand === "hydrate") {
                    await blueprintHydrate(args);
                } else if (args.subcommand === "fix") {
                    await blueprintFix(args);
                } else {
                    showHelp();
                    throw new CLIError(
                        "blueprint requires subcommand: create, hydrate, or fix",
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

main();
