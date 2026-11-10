import { describe, expect, test } from "bun:test";

import {
    buildShopwareConnectionErrorMessage,
    classifyShopwareConnectionFailure,
    variantOverridesFromFlags,
} from "../../../src/cli/shared.js";

describe("classifyShopwareConnectionFailure", () => {
    test("detects authentication failures", () => {
        const result = classifyShopwareConnectionFailure("Client authentication failed");
        expect(result).toBe("auth");
    });

    test("detects unreachable instance failures", () => {
        const result = classifyShopwareConnectionFailure("fetch failed ECONNREFUSED");
        expect(result).toBe("unreachable");
    });

    test("returns unknown for unrelated errors", () => {
        const result = classifyShopwareConnectionFailure("unexpected parse problem");
        expect(result).toBe("unknown");
    });
});

describe("buildShopwareConnectionErrorMessage", () => {
    test("includes integration guidance for auth failures", () => {
        const message = buildShopwareConnectionErrorMessage(
            "http://localhost:8000",
            "auth",
            "/tmp/generator-test.log"
        );

        expect(message).toContain("Cannot authenticate with Shopware");
        expect(message).toContain("Create a new integration");
        expect(message).toContain("SW_CLIENT_ID");
        expect(message).toContain("See log file for full error details");
    });

    test("includes reachability guidance for network failures", () => {
        const message = buildShopwareConnectionErrorMessage(
            "http://localhost:8000",
            "unreachable",
            "/tmp/generator-test.log"
        );

        expect(message).toContain("Cannot reach Shopware instance");
        expect(message).toContain("Make sure the Shopware instance is running");
        expect(message).toContain("SW_ENV_URL");
    });
});

describe("variantOverridesFromFlags", () => {
    test("reads the four variant flags and leaves unset ones out", () => {
        const overrides = variantOverridesFromFlags({
            name: "music",
            "variant-colors": "6",
            "max-variants": "12",
        });

        expect(overrides).toEqual({ colors: "6", maxVariants: "12" });
    });

    test("a flag without a value becomes an empty string so validation rejects it", () => {
        expect(variantOverridesFromFlags({ "variant-share": true })).toEqual({ share: "" });
    });

    test("returns an empty object without variant flags", () => {
        expect(variantOverridesFromFlags({ name: "music" })).toEqual({});
    });
});
