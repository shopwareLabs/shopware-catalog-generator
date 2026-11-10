import type {
    FeatureCheck,
    FeatureCheckContext,
    FeatureCheckOutcome,
    FeatureCheckResult,
} from "./types.js";

import { SHOPWARE_FEATURES } from "../../../src/fixtures/index.js";
import { fail, skip } from "./types.js";

/** Why a check does not apply to the connected shop, or null when it does */
export function unsupportedReason(
    check: FeatureCheck,
    context: Pick<FeatureCheckContext, "shopware">
): string | null {
    if (!check.requires || context.shopware.supports(check.requires)) return null;
    const requirement = SHOPWARE_FEATURES[check.requires];
    return `needs Shopware ${requirement.since}+ (${requirement.description})`;
}

async function runOne(
    check: FeatureCheck,
    context: FeatureCheckContext
): Promise<FeatureCheckOutcome> {
    const reason = unsupportedReason(check, context);
    if (reason) return skip(reason);
    try {
        return await check.run(context);
    } catch (error) {
        return fail(`query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

const ICONS = { pass: "✓", fail: "✗", skip: "⊘" } as const;

export function formatFeatureCheck(result: FeatureCheckResult): string {
    return `  ${ICONS[result.status]} ${result.name}: ${result.detail}`;
}

/** Run every check in order (they only read). A failing query fails its own check only. */
export async function runFeatureChecks(
    checks: readonly FeatureCheck[],
    context: FeatureCheckContext
): Promise<FeatureCheckResult[]> {
    const results: FeatureCheckResult[] = [];
    for (const check of checks) {
        results.push({ name: check.name, ...(await runOne(check, context)) });
    }
    return results;
}
