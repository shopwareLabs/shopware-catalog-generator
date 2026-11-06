import { describe, expect, test } from "bun:test";

import type { ShopwareFeature } from "../../../src/fixtures/index.js";

import { SHOPWARE_FEATURES } from "../../../src/fixtures/index.js";
import {
    compareShopwareVersions,
    detectShopwareCapabilities,
    parseShopwareVersion,
    ShopwareCapabilities,
} from "../../../src/shopware/version.js";
import { createMockApiHelpers } from "../../mocks/index.js";

const allFeatures = Object.keys(SHOPWARE_FEATURES).filter(
    (key): key is ShopwareFeature => key in SHOPWARE_FEATURES
);

function version(raw: string) {
    const parsed = parseShopwareVersion(raw);
    if (!parsed) throw new Error(`test setup: invalid version ${raw}`);
    return parsed;
}

describe("parseShopwareVersion", () => {
    test("parses a release version", () => {
        expect(parseShopwareVersion("6.7.16.0")).toEqual({
            raw: "6.7.16.0",
            parts: [6, 7, 16, 0],
            isDevBuild: false,
        });
    });

    test("marks dev builds reported by branch checkouts", () => {
        const parsed = version("6.7.9999999.9999999-dev");
        expect(parsed.parts).toEqual([6, 7, 9999999, 9999999]);
        expect(parsed.isDevBuild).toBe(true);
    });

    test("accepts a leading v, short versions and pre-release suffixes", () => {
        expect(version("v6.6.10.4").parts).toEqual([6, 6, 10, 4]);
        expect(version("6.7").parts).toEqual([6, 7, 0, 0]);
        expect(version("6.7.0.0-rc2").isDevBuild).toBe(false);
    });

    test("returns null for non-versions", () => {
        expect(parseShopwareVersion("")).toBeNull();
        expect(parseShopwareVersion("trunk")).toBeNull();
        expect(parseShopwareVersion("6")).toBeNull();
    });
});

describe("compareShopwareVersions", () => {
    test("compares numerically, not as strings", () => {
        expect(compareShopwareVersions(version("6.7.16.0"), version("6.7.7.0"))).toBeGreaterThan(0);
        expect(compareShopwareVersions(version("6.6.10.0"), version("6.7.0.0"))).toBeLessThan(0);
        expect(compareShopwareVersions(version("6.7.1.0"), version("6.7.1.0"))).toBe(0);
    });

    test("sorts a dev build after every release of its minor and before the next minor", () => {
        const dev = version("6.7.9999999.9999999-dev");
        expect(compareShopwareVersions(dev, version("6.7.16.0"))).toBeGreaterThan(0);
        expect(compareShopwareVersions(dev, version("6.8.0.0"))).toBeLessThan(0);
    });
});

describe("ShopwareCapabilities.supports", () => {
    test("enables a feature from its first release on", () => {
        expect(ShopwareCapabilities.fromVersion("6.7.6.2").supports("productType")).toBe(false);
        expect(ShopwareCapabilities.fromVersion("6.7.7.0").supports("productType")).toBe(true);
        expect(ShopwareCapabilities.fromVersion("6.7.16.0").supports("productType")).toBe(true);
    });

    test("gates the catalog field features on their first release", () => {
        const at = (v: string): ShopwareCapabilities => ShopwareCapabilities.fromVersion(v);
        expect(at("6.7.6.0").supports("customFieldSearchable")).toBe(false);
        expect(at("6.7.7.0").supports("customFieldSearchable")).toBe(true);
        expect(at("6.7.9.0").supports("productOpenGraph")).toBe(false);
        expect(at("6.7.10.0").supports("productOpenGraph")).toBe(true);
        expect(at("6.7.0.0").supports("measurementUnits")).toBe(false);
        expect(at("6.7.1.0").supports("measurementUnits")).toBe(true);
    });

    test("6.5 and 6.6 support none of the listed features", () => {
        for (const raw of ["6.5.9999999.9999999-dev", "6.6.9999999.9999999-dev"]) {
            const capabilities = ShopwareCapabilities.fromVersion(raw);
            expect(allFeatures.filter((feature) => capabilities.supports(feature))).toEqual([]);
        }
    });

    test("a 6.7 dev build supports all 6.7 features but not 6.8 ones without the flag", () => {
        const trunk = ShopwareCapabilities.fromVersion("6.7.9999999.9999999-dev");
        expect(trunk.supports("productType")).toBe(true);
        expect(trunk.supports("measurementUnits")).toBe(true);
        expect(trunk.supports("productTypeRequired")).toBe(false);
    });

    test("the major feature flag enables 6.8 features on a 6.7 dev build", () => {
        const sw68 = ShopwareCapabilities.fromVersion("6.7.9999999.9999999-dev", ["v6.8.0.0"]);
        expect(sw68.supports("productTypeRequired")).toBe(true);
    });

    test("a 6.8 release supports 6.8 features without the flag", () => {
        expect(ShopwareCapabilities.fromVersion("6.8.0.0").supports("productTypeRequired")).toBe(
            true
        );
    });

    test("an unknown version enables every version-gated feature", () => {
        const unknown = new ShopwareCapabilities(null);
        expect(unknown.supports("productType")).toBe(true);
        expect(unknown.supports("productTypeRequired")).toBe(true);
        expect(unknown.isSupportedVersion()).toBe(true);
    });
});

describe("ShopwareCapabilities", () => {
    test("treats 6.6 as the supported floor", () => {
        expect(ShopwareCapabilities.fromVersion("6.5.8.0").isSupportedVersion()).toBe(false);
        expect(ShopwareCapabilities.fromVersion("6.6.0.0").isSupportedVersion()).toBe(true);
    });

    test("describe() names dev builds and active major flags", () => {
        expect(ShopwareCapabilities.fromVersion("6.7.16.0").describe()).toBe("6.7.16.0");
        expect(
            ShopwareCapabilities.fromVersion("6.7.9999999.9999999-dev", [
                "v6.8.0.0",
                "ACCESSIBILITY_TWEAKS",
            ]).describe()
        ).toBe("6.7 dev build (6.7.9999999.9999999-dev), flags: v6.8.0.0");
        expect(new ShopwareCapabilities(null).describe()).toBe("unknown version");
    });

    test("fromVersion rejects an invalid version", () => {
        expect(() => ShopwareCapabilities.fromVersion("latest")).toThrow(
            "Invalid Shopware version"
        );
    });
});

describe("detectShopwareCapabilities", () => {
    test("reads the version and only the active flags", async () => {
        const api = createMockApiHelpers()
            .mockGetResponse("_info/version", { version: "6.7.9999999.9999999-dev" })
            .mockGetResponse("_action/feature-flag", {
                "v6.8.0.0": { default: false, major: true, active: true },
                V6_7_0_0: { default: false, active: false },
            });

        const capabilities = await detectShopwareCapabilities(api);

        expect(capabilities.version?.raw).toBe("6.7.9999999.9999999-dev");
        expect(capabilities.isFlagActive("v6.8.0.0")).toBe(true);
        expect(capabilities.isFlagActive("V6_7_0_0")).toBe(false);
    });

    test("works without the feature flag endpoint (Shopware 6.5)", async () => {
        const api = createMockApiHelpers()
            .mockGetResponse("_info/version", { version: "6.5.9999999.9999999-dev" })
            .mockGetFailure("_action/feature-flag", new Error("404"));

        const capabilities = await detectShopwareCapabilities(api);

        expect(capabilities.version?.parts).toEqual([6, 5, 9999999, 9999999]);
        expect(capabilities.supports("productType")).toBe(false);
    });

    test("falls back to an unknown version when the version request fails", async () => {
        const api = createMockApiHelpers().mockGetFailure("_info/version", new Error("500"));

        const capabilities = await detectShopwareCapabilities(api);

        expect(capabilities.version).toBeNull();
        expect(capabilities.supports("productType")).toBe(true);
    });

    test("treats an unparseable version as unknown", async () => {
        const api = createMockApiHelpers().mockGetResponse("_info/version", { version: 67 });

        const capabilities = await detectShopwareCapabilities(api);

        expect(capabilities.version).toBeNull();
    });
});
