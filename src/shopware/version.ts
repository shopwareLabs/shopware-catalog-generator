/**
 * Shopware version detection and feature gating.
 *
 * The version is read once per run from /api/_info/version. Feature flags come from
 * /api/_action/feature-flag (Shopware 6.6+), because dev builds of the next major
 * report the same version as trunk and only differ in the active major flag.
 */

import type { ShopwareFeature } from "../fixtures/index.js";
import type { ShopwareFeatureRequirement, ShopwareVersion } from "../types/index.js";
import type { ShopwareApi } from "./api-helpers.js";

import { MIN_SUPPORTED_SHOPWARE_VERSION, SHOPWARE_FEATURES } from "../fixtures/index.js";
import { logger } from "../utils/index.js";

/** Marker Shopware uses for the patch/build parts of unreleased dev builds */
const DEV_BUILD_PART = 9999999;

/** Parse a Shopware version string. Returns null when it is not a version. */
export function parseShopwareVersion(raw: string): ShopwareVersion | null {
    const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(.+))?$/.exec(raw.trim());
    if (!match) return null;

    const parts: ShopwareVersion["parts"] = [
        Number(match[1]),
        Number(match[2]),
        Number(match[3] ?? 0),
        Number(match[4] ?? 0),
    ];
    const isDevBuild = match[5]?.toLowerCase() === "dev" || parts[2] === DEV_BUILD_PART;
    return { raw, parts, isDevBuild };
}

/** Compare two versions: negative if a < b, 0 if equal, positive if a > b */
export function compareShopwareVersions(a: ShopwareVersion, b: ShopwareVersion): number {
    const differences = a.parts.map((part, i) => part - (b.parts[i] ?? 0));
    return differences.find((difference) => difference !== 0) ?? 0;
}

function requireVersion(raw: string): ShopwareVersion {
    const version = parseShopwareVersion(raw);
    if (!version) {
        throw new Error(`Invalid Shopware version "${raw}"`);
    }
    return version;
}

/**
 * What the connected shop supports.
 *
 * When the version could not be read, every version check passes. That keeps the
 * previous behaviour (send everything) instead of silently dropping data.
 */
export class ShopwareCapabilities {
    readonly version: ShopwareVersion | null;
    private readonly activeFlags: ReadonlySet<string>;

    constructor(version: ShopwareVersion | null, activeFlags: Iterable<string> = []) {
        this.version = version;
        this.activeFlags = new Set(activeFlags);
    }

    /** Build capabilities from a raw version string (mainly for tests and fixtures) */
    static fromVersion(raw: string, activeFlags: Iterable<string> = []): ShopwareCapabilities {
        return new ShopwareCapabilities(requireVersion(raw), activeFlags);
    }

    /** True if the shop runs at least the given four-part version */
    isAtLeast(minVersion: string): boolean {
        if (!this.version) return true;
        return compareShopwareVersions(this.version, requireVersion(minVersion)) >= 0;
    }

    /** True if the given Shopware feature flag is active */
    isFlagActive(flag: string): boolean {
        return this.activeFlags.has(flag);
    }

    /** True if the shop supports the feature (released in its version or enabled by flag) */
    supports(feature: ShopwareFeature): boolean {
        const requirement: ShopwareFeatureRequirement = SHOPWARE_FEATURES[feature];
        if (requirement.flag && this.isFlagActive(requirement.flag)) return true;
        return this.isAtLeast(requirement.since);
    }

    /** True if the shop is at or above MIN_SUPPORTED_SHOPWARE_VERSION */
    isSupportedVersion(): boolean {
        return this.isAtLeast(MIN_SUPPORTED_SHOPWARE_VERSION);
    }

    /** Short description for logs, e.g. "6.7 dev build (6.7.9999999.9999999-dev, flags: v6.8.0.0)" */
    describe(): string {
        if (!this.version) return "unknown version";
        const [major, minor] = this.version.parts;
        const label = this.version.isDevBuild
            ? `${major}.${minor} dev build (${this.version.raw})`
            : this.version.raw;
        const majorFlags = [...this.activeFlags].filter((flag) =>
            /^v\d+\.\d+\.\d+\.\d+$/.test(flag)
        );
        return majorFlags.length > 0 ? `${label}, flags: ${majorFlags.join(", ")}` : label;
    }
}

interface FeatureFlagState {
    active?: boolean;
}

async function fetchVersion(api: Pick<ShopwareApi, "get">): Promise<ShopwareVersion | null> {
    try {
        const { version } = await api.get<{ version?: unknown }>("_info/version");
        return typeof version === "string" ? parseShopwareVersion(version) : null;
    } catch (error) {
        logger.warn("Could not read the Shopware version", { data: error });
        return null;
    }
}

/** Active feature flags. Shopware 6.5 has no endpoint, which means no flags. */
async function fetchActiveFlags(api: Pick<ShopwareApi, "get">): Promise<string[]> {
    try {
        const flags = await api.get<Record<string, FeatureFlagState>>("_action/feature-flag");
        return Object.entries(flags)
            .filter(([, state]) => state?.active === true)
            .map(([name]) => name);
    } catch (error) {
        logger.debug("No feature flag endpoint, assuming no active flags", { data: error });
        return [];
    }
}

/**
 * Detect the connected shop's version and active feature flags.
 * Never throws: an unreadable version yields capabilities that allow everything.
 */
export async function detectShopwareCapabilities(
    api: Pick<ShopwareApi, "get">
): Promise<ShopwareCapabilities> {
    const [version, flags] = await Promise.all([fetchVersion(api), fetchActiveFlags(api)]);
    const capabilities = new ShopwareCapabilities(version, flags);

    if (!version) {
        logger.warn("⚠ Shopware version unknown, all features enabled", { cli: true });
        return capabilities;
    }
    logger.info(`Shopware ${capabilities.describe()}`, { cli: true });
    if (!capabilities.isSupportedVersion()) {
        logger.warn(
            `⚠ Shopware ${version.raw} is older than ${MIN_SUPPORTED_SHOPWARE_VERSION}, support is best-effort`,
            { cli: true }
        );
    }
    return capabilities;
}
