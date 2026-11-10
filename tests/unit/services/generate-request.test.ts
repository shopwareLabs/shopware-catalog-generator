import { describe, expect, test } from "bun:test";

import { buildGenerateRequest } from "../../../src/services/generate-request.js";
import { shopwareConnectionFromEnv } from "../../../src/services/shopware-context.js";

describe("buildGenerateRequest", () => {
    test("applies the defaults", () => {
        const result = buildGenerateRequest({ name: "garden" }, {});

        expect(result).toEqual({
            request: {
                salesChannelName: "garden",
                description: undefined,
                options: {
                    products: 90,
                    dryRun: false,
                    noTemplate: false,
                    languages: undefined,
                    variants: {},
                },
            },
        });
    });

    test("requires a name", () => {
        expect(buildGenerateRequest({}, {})).toEqual({ error: "Error: name is required" });
    });

    test("rejects an invalid name", () => {
        const result = buildGenerateRequest({ name: "!!!" }, {});
        expect("error" in result && result.error.startsWith("Error: Invalid name")).toBe(true);
    });

    test("rejects products that are not a positive whole number", () => {
        expect(buildGenerateRequest({ name: "garden", products: 0 }, {})).toEqual({
            error: "Error: products must be a positive whole number (got: 0)",
        });
        expect("error" in buildGenerateRequest({ name: "garden", products: 1.5 }, {})).toBe(true);
    });

    test("an empty description falls back to the service default", () => {
        const result = buildGenerateRequest({ name: "garden", description: "" }, {});
        expect("request" in result && result.request.description).toBeUndefined();
    });

    test("explicit languages win over TRANSLATION_LANGUAGES", () => {
        const result = buildGenerateRequest(
            { name: "garden", languages: "none" },
            { TRANSLATION_LANGUAGES: "de-DE" }
        );
        const explicit = buildGenerateRequest({ name: "garden", languages: "none" }, {});
        expect("request" in result && result.request.options.languages).toEqual(
            "request" in explicit && explicit.request.options.languages
        );
    });

    test("uses TRANSLATION_LANGUAGES without an explicit value", () => {
        const fromEnv = buildGenerateRequest(
            { name: "garden" },
            { TRANSLATION_LANGUAGES: "de-DE" }
        );
        const explicit = buildGenerateRequest({ name: "garden", languages: "de-DE" }, {});
        expect("request" in fromEnv && fromEnv.request.options.languages).toEqual(
            "request" in explicit && explicit.request.options.languages
        );
    });

    test("names TRANSLATION_LANGUAGES in its error", () => {
        const result = buildGenerateRequest(
            { name: "garden" },
            { TRANSLATION_LANGUAGES: "xx_invalid" }
        );
        expect("error" in result && result.error.startsWith("Error: TRANSLATION_LANGUAGES:")).toBe(
            true
        );
    });

    test("drops unset variant overrides", () => {
        const result = buildGenerateRequest(
            { name: "garden", variants: { colors: 6, options: undefined } },
            {}
        );
        expect("request" in result && result.request.options.variants).toEqual({ colors: 6 });
    });
});

describe("shopwareConnectionFromEnv", () => {
    test("is undefined without SW_ENV_URL", () => {
        expect(shopwareConnectionFromEnv({ SW_CLIENT_ID: "id" })).toBeUndefined();
    });

    test("uses the integration credentials", () => {
        expect(
            shopwareConnectionFromEnv({
                SW_ENV_URL: "http://shop.test",
                SW_CLIENT_ID: "id",
                SW_CLIENT_SECRET: "secret",
            })
        ).toEqual({
            url: "http://shop.test",
            credentials: { kind: "integration", clientId: "id", clientSecret: "secret" },
        });
    });
});
