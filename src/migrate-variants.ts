#!/usr/bin/env bun
/**
 * Migration Script: Update existing hydrated blueprints to new variantConfigs format
 *
 * This script converts the legacy single-property variant format to the new
 * multi-property format with partial option selection.
 *
 * Usage:
 *   bun run migrate:variants
 *   bun run migrate:variants -- --dry-run
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type {
    BlueprintPropertyGroup,
    HydratedBlueprint,
    VariantConfig,
} from "./types/index.js";
import { randomSamplePercent, weightedRandomPick } from "./utils/index.js";

// Default price modifiers for options (used when no legacy modifiers exist)
const DEFAULT_PRICE_MODIFIERS: Record<string, number> = {
    // Size-based
    S: 0.9,
    Small: 0.9,
    Compact: 0.9,
    M: 1.0,
    Medium: 1.0,
    Standard: 1.0,
    L: 1.1,
    Large: 1.1,
    XL: 1.2,
    "Extra Large": 1.2,
    Oversized: 1.2,
    // Material-based
    Plastic: 0.8,
    Wood: 1.0,
    Metal: 1.15,
    Premium: 1.3,
    Leather: 1.2,
    // Default
    default: 1.0,
};

interface LegacyProductMetadata {
    isVariant: boolean;
    variantProperty?: string;
    variantPriceModifiers?: Record<string, number>;
    properties?: Array<{ group: string; value: string }>;
}

function parseArgs(): { dryRun: boolean; help: boolean } {
    const args = process.argv.slice(2);
    return {
        dryRun: args.includes("--dry-run") || args.includes("-n"),
        help: args.includes("--help") || args.includes("-h"),
    };
}

function printUsage(): void {
    console.log(`
Usage: bun run migrate:variants [options]

Migrate existing hydrated blueprints from legacy variantProperty format
to the new variantConfigs format with 1-3 property groups and partial options.

Options:
  --dry-run, -n   Preview changes without modifying files
  --help, -h      Show this help message

Examples:
  bun run migrate:variants              # Migrate all blueprints
  bun run migrate:variants -- --dry-run # Preview what would change
`);
}

/**
 * Get price modifier for an option name
 */
function getPriceModifier(optionName: string): number {
    return DEFAULT_PRICE_MODIFIERS[optionName] ?? DEFAULT_PRICE_MODIFIERS.default ?? 1.0;
}

/**
 * Generate new variant configs using actual property groups from blueprint
 */
function generateVariantConfigs(
    blueprintPropertyGroups: BlueprintPropertyGroup[],
    productProperties: Array<{ group: string; value: string }> | undefined
): VariantConfig[] {
    const configs: VariantConfig[] = [];

    // Filter to only property groups that have at least 2 options (needed for variants)
    const eligibleGroups = blueprintPropertyGroups.filter((g) => g.options.length >= 2);

    if (eligibleGroups.length === 0) {
        return configs;
    }

    // Prioritize groups that the product actually uses
    const productGroupNames = new Set(productProperties?.map((p) => p.group) ?? []);
    const prioritizedGroups = eligibleGroups.filter((g) => productGroupNames.has(g.name));
    const otherGroups = eligibleGroups.filter((g) => !productGroupNames.has(g.name));

    // Combine with prioritized groups first
    const sortedGroups = [...prioritizedGroups, ...otherGroups];

    // Decide how many property groups to use (weighted: 1=50%, 2=35%, 3=15%)
    const targetCount = weightedRandomPick([1, 2, 3], [0.5, 0.35, 0.15]);
    const groupsToUse = sortedGroups.slice(0, Math.min(targetCount, sortedGroups.length));

    for (const group of groupsToUse) {
        const allOptionNames = group.options.map((o) => o.name);

        // Select 40-60% of options (at least 2 for meaningful variants)
        const selectedOptions = randomSamplePercent(allOptionNames, 0.4, 0.6);
        const finalOptions =
            selectedOptions.length >= 2 ? selectedOptions : allOptionNames.slice(0, 2);

        // Build price modifiers
        const priceModifiers: Record<string, number> = {};
        for (const opt of finalOptions) {
            priceModifiers[opt] = getPriceModifier(opt);
        }

        configs.push({
            group: group.name,
            selectedOptions: finalOptions,
            priceModifiers,
        });
    }

    return configs;
}

/**
 * Migrate a single blueprint file
 */
function migrateBlueprint(
    filePath: string,
    dryRun: boolean
): { migrated: number; skipped: number; errors: string[] } {
    const result = { migrated: 0, skipped: 0, errors: [] as string[] };

    try {
        const content = fs.readFileSync(filePath, "utf-8");
        const blueprint = JSON.parse(content) as HydratedBlueprint;

        let modified = false;

        // Get property groups from the blueprint
        const propertyGroups = blueprint.propertyGroups || [];

        for (const product of blueprint.products) {
            const metadata = product.metadata as unknown as LegacyProductMetadata;

            // Skip if not a variant product
            if (!metadata.isVariant) {
                continue;
            }

            // Skip if already migrated (has variantConfigs with actual options)
            if ("variantConfigs" in product.metadata && product.metadata.variantConfigs) {
                const existingConfigs = product.metadata.variantConfigs;
                // Check if configs have meaningful options (more than hardcoded 4)
                const hasRealOptions = existingConfigs.some(
                    (c: { selectedOptions?: string[] }) => (c.selectedOptions?.length ?? 0) > 2
                );
                if (hasRealOptions) {
                    result.skipped++;
                    continue;
                }
                // Re-migrate with actual options from blueprint
            }

            // Generate new variant configs using actual blueprint property groups
            const variantConfigs = generateVariantConfigs(propertyGroups, metadata.properties);

            if (variantConfigs.length === 0) {
                result.skipped++;
                continue;
            }

            // Update the product metadata
            (product.metadata as unknown as Record<string, unknown>).variantConfigs =
                variantConfigs;
            delete (product.metadata as unknown as Record<string, unknown>).variantProperty;
            delete (product.metadata as unknown as Record<string, unknown>).variantPriceModifiers;

            modified = true;
            result.migrated++;

            if (dryRun) {
                const configSummary = variantConfigs
                    .map((c) => `${c.group}(${c.selectedOptions.length})`)
                    .join(" + ");
                console.log(`    ${product.name}: ${configSummary}`);
            }
        }

        if (modified && !dryRun) {
            fs.writeFileSync(filePath, JSON.stringify(blueprint, null, 2));
        }
    } catch (error) {
        result.errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return result;
}

/**
 * Find all hydrated blueprint files
 */
function findBlueprintFiles(): string[] {
    const cacheDir = path.join(process.cwd(), "generated", "sales-channels");

    if (!fs.existsSync(cacheDir)) {
        return [];
    }

    const files: string[] = [];
    const salesChannels = fs.readdirSync(cacheDir);

    for (const sc of salesChannels) {
        const blueprintPath = path.join(cacheDir, sc, "hydrated-blueprint.json");
        if (fs.existsSync(blueprintPath)) {
            files.push(blueprintPath);
        }
    }

    return files;
}

async function main(): Promise<void> {
    const { dryRun, help } = parseArgs();

    if (help) {
        printUsage();
        process.exit(0);
    }

    console.log("\n=== Variant Migration ===\n");

    if (dryRun) {
        console.log("[DRY RUN] No files will be modified.\n");
    }

    const files = findBlueprintFiles();

    if (files.length === 0) {
        console.log("No hydrated blueprint files found in generated/sales-channels/");
        console.log("Run 'bun run generate' first to create blueprints.");
        process.exit(0);
    }

    console.log(`Found ${files.length} blueprint file(s) to process:\n`);

    let totalMigrated = 0;
    let totalSkipped = 0;
    const allErrors: string[] = [];

    for (const file of files) {
        const scName = path.basename(path.dirname(file));
        console.log(`  Processing: ${scName}`);

        const result = migrateBlueprint(file, dryRun);

        totalMigrated += result.migrated;
        totalSkipped += result.skipped;
        allErrors.push(...result.errors);

        if (!dryRun) {
            console.log(`    ✓ Migrated ${result.migrated} products, skipped ${result.skipped}`);
        } else {
            console.log(
                `    [DRY RUN] Would migrate ${result.migrated} products, skip ${result.skipped}`
            );
        }
    }

    console.log("\n=== Migration Complete ===\n");
    console.log(`Total migrated: ${totalMigrated}`);
    console.log(`Total skipped: ${totalSkipped}`);

    if (allErrors.length > 0) {
        console.log(`\nErrors (${allErrors.length}):`);
        for (const error of allErrors) {
            console.log(`  - ${error}`);
        }
    }

    if (dryRun) {
        console.log("\n[DRY RUN] Run without --dry-run to apply changes.");
    }
}

main().catch((error) => {
    console.error("Migration failed:", error);
    process.exit(1);
});
