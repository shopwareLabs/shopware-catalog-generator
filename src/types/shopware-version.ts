/**
 * Shopware version detection types
 *
 * Used to gate upload fields and post-processor behaviour on the version of the
 * connected shop. Blueprints and templates always store every field; fields are
 * only left out at upload time.
 */

/** Parsed Shopware version, e.g. "6.7.16.0" or "6.7.9999999.9999999-dev" */
export interface ShopwareVersion {
    /** Raw version string as reported by /api/_info/version */
    raw: string;
    /** Numeric parts [major, minor, patch, build], padded to four entries */
    parts: [number, number, number, number];
    /**
     * Unreleased development build (e.g. a trunk or branch checkout).
     * Shopware reports these as "<major>.<minor>.9999999.9999999-dev", which sorts
     * after every release of that minor.
     */
    isDevBuild: boolean;
}

/** Requirement for a Shopware feature the generator can use */
export interface ShopwareFeatureRequirement {
    /** Human-readable description of what the feature unlocks */
    description: string;
    /** First Shopware release that supports the feature (four-part version) */
    since: string;
    /**
     * Feature flag that enables the feature before `since` is released,
     * e.g. "v6.8.0.0" on a dev build running with the next major's flag on.
     */
    flag?: string;
}
