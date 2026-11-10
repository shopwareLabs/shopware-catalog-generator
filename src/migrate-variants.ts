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
    BlueprintProduct,
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

type ProductProperties = Array<{ group: string; value: string }>;

interface LegacyProductMetadata {
    isVariant: boolean;
    variantProperty?: string;
    variantPriceModifiers?: Record<string, number>;
    properties?: ProductProperties;
}

interface MigrationResult {
    migrated: number;
    skipped: number;
    errors: string[];
}

/** What happened to one product: not a variant, left as is, or given new configs. */
type ProductOutcome = "ignored" | "skipped" | "migrated";

export function parseArgs(args: string[] = process.argv.slice(2)): {
    dryRun: boolean;
    help: boolean;
} {
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

/** Groups the product already uses come first, the rest keep their blueprint order. */
function orderGroupsByProductUsage(
    groups: BlueprintPropertyGroup[],
    productProperties: ProductProperties | undefined
): BlueprintPropertyGroup[] {
    const productGroupNames = new Set(productProperties?.map((p) => p.group) ?? []);
    const usedGroups = groups.filter((g) => productGroupNames.has(g.name));
    const otherGroups = groups.filter((g) => !productGroupNames.has(g.name));
    return [...usedGroups, ...otherGroups];
}

/** 40-60% of the group's options, at least 2 for meaningful variants. */
function pickVariantOptions(group: BlueprintPropertyGroup): string[] {
    const allOptionNames = group.options.map((o) => o.name);
    const selectedOptions = randomSamplePercent(allOptionNames, 0.4, 0.6);
    return selectedOptions.length >= 2 ? selectedOptions : allOptionNames.slice(0, 2);
}

function buildVariantConfig(group: BlueprintPropertyGroup): VariantConfig {
    const selectedOptions = pickVariantOptions(group);
    return {
        group: group.name,
        selectedOptions,
        priceModifiers: Object.fromEntries(
            selectedOptions.map((option) => [option, getPriceModifier(option)])
        ),
    };
}

/**
 * Generate new variant configs using actual property groups from blueprint
 */
export function generateVariantConfigs(
    blueprintPropertyGroups: BlueprintPropertyGroup[],
    productProperties: ProductProperties | undefined
): VariantConfig[] {
    // Only groups with at least 2 options can form variants
    const eligibleGroups = blueprintPropertyGroups.filter((g) => g.options.length >= 2);
    if (eligibleGroups.length === 0) {
        return [];
    }

    const sortedGroups = orderGroupsByProductUsage(eligibleGroups, productProperties);

    // Decide how many property groups to use (weighted: 1=50%, 2=35%, 3=15%)
    const targetCount = weightedRandomPick([1, 2, 3], [0.5, 0.35, 0.15]);
    return sortedGroups.slice(0, targetCount).map(buildVariantConfig);
}

/** Configs from an earlier migration with more than 2 options are kept as they are. */
function hasMigratedVariantConfigs(metadata: { variantConfigs?: VariantConfig[] }): boolean {
    const configs = metadata.variantConfigs ?? [];
    return configs.some((c) => (c.selectedOptions?.length ?? 0) > 2);
}

function logDryRunProduct(productName: string, variantConfigs: VariantConfig[]): void {
    const configSummary = variantConfigs
        .map((c) => `${c.group}(${c.selectedOptions.length})`)
        .join(" + ");
    console.log(`    ${productName}: ${configSummary}`);
}

/** Replace the legacy variant fields of one product with new variant configs (in place). */
function migrateProduct(
    product: BlueprintProduct,
    propertyGroups: BlueprintPropertyGroup[],
    dryRun: boolean
): ProductOutcome {
    const metadata = product.metadata as LegacyProductMetadata;
    if (!metadata.isVariant) {
        return "ignored";
    }
    if (hasMigratedVariantConfigs(product.metadata)) {
        return "skipped";
    }

    const variantConfigs = generateVariantConfigs(propertyGroups, metadata.properties);
    if (variantConfigs.length === 0) {
        return "skipped";
    }

    Object.assign(product.metadata, { variantConfigs });
    delete metadata.variantProperty;
    delete metadata.variantPriceModifiers;

    if (dryRun) {
        logDryRunProduct(product.name, variantConfigs);
    }
    return "migrated";
}

/** Counts are written into `result` while products are processed, so a late error keeps them. */
function migrateBlueprintInto(result: MigrationResult, filePath: string, dryRun: boolean): void {
    const blueprint = JSON.parse(fs.readFileSync(filePath, "utf-8")) as HydratedBlueprint;
    const propertyGroups = blueprint.propertyGroups || [];

    for (const product of blueprint.products) {
        const outcome = migrateProduct(product, propertyGroups, dryRun);
        if (outcome !== "ignored") {
            result[outcome]++;
        }
    }

    if (result.migrated > 0 && !dryRun) {
        fs.writeFileSync(filePath, JSON.stringify(blueprint, null, 2));
    }
}

/**
 * Migrate a single blueprint file
 */
export function migrateBlueprint(filePath: string, dryRun: boolean): MigrationResult {
    const result: MigrationResult = { migrated: 0, skipped: 0, errors: [] };
    try {
        migrateBlueprintInto(result, filePath, dryRun);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${filePath}: ${message}`);
    }
    return result;
}

/**
 * Find all hydrated blueprint files
 */
export function findBlueprintFiles(
    cacheDir: string = path.join(process.cwd(), "generated", "sales-channels")
): string[] {
    if (!fs.existsSync(cacheDir)) {
        return [];
    }

    return fs
        .readdirSync(cacheDir)
        .map((sc) => path.join(cacheDir, sc, "hydrated-blueprint.json"))
        .filter((blueprintPath) => fs.existsSync(blueprintPath));
}

function fileSummaryLine(result: MigrationResult, dryRun: boolean): string {
    if (dryRun) {
        return `    [DRY RUN] Would migrate ${result.migrated} products, skip ${result.skipped}`;
    }
    return `    ✓ Migrated ${result.migrated} products, skipped ${result.skipped}`;
}

function migrateAndReportFile(file: string, dryRun: boolean): MigrationResult {
    console.log(`  Processing: ${path.basename(path.dirname(file))}`);
    const result = migrateBlueprint(file, dryRun);
    console.log(fileSummaryLine(result, dryRun));
    return result;
}

/** Migrate every file, log one line per file and return the totals. */
export function migrateBlueprintFiles(files: string[], dryRun: boolean): MigrationResult {
    return files
        .map((file) => migrateAndReportFile(file, dryRun))
        .reduce<MigrationResult>(
            (totals, result) => ({
                migrated: totals.migrated + result.migrated,
                skipped: totals.skipped + result.skipped,
                errors: [...totals.errors, ...result.errors],
            }),
            { migrated: 0, skipped: 0, errors: [] }
        );
}

function printTotals(totals: MigrationResult, dryRun: boolean): void {
    console.log("\n=== Migration Complete ===\n");
    console.log(`Total migrated: ${totals.migrated}`);
    console.log(`Total skipped: ${totals.skipped}`);

    if (totals.errors.length > 0) {
        console.log(`\nErrors (${totals.errors.length}):`);
        totals.errors.forEach((error) => console.log(`  - ${error}`));
    }

    if (dryRun) {
        console.log("\n[DRY RUN] Run without --dry-run to apply changes.");
    }
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
    printTotals(migrateBlueprintFiles(files, dryRun), dryRun);
}

if (import.meta.main) {
    main().catch((error) => {
        console.error("Migration failed:", error);
        process.exit(1);
    });
}
