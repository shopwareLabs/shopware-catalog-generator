import type { FeatureCheck } from "./types.js";

import { CATALOG_CHECKS } from "./catalog-checks.js";
import { FIXTURE_CHECKS } from "./fixture-checks.js";
import { VERSION_CHECKS } from "./version-checks.js";

export { formatFeatureCheck, runFeatureChecks, unsupportedReason } from "./runner.js";
export type { FeatureCheck, FeatureCheckContext, FeatureCheckResult } from "./types.js";

/** Every feature check verify.ts runs, in output order */
export const FEATURE_CHECKS: readonly FeatureCheck[] = [
    ...CATALOG_CHECKS,
    ...FIXTURE_CHECKS,
    ...VERSION_CHECKS,
];
