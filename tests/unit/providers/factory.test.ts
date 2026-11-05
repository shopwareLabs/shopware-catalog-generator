import { describe, expect, test } from "bun:test";

import { parseAIProvider, resolveModelSelection } from "../../../src/providers/factory.js";
import { PollinationsImageProvider } from "../../../src/providers/pollinations-provider.js";
import { DEFAULT_POLLINATIONS_IMAGE_MODEL } from "../../../src/types/index.js";

describe("resolveModelSelection", () => {
    test("OpenAI defaults to gpt-6-luna text and gpt-image-1-mini low quality images", () => {
        const selection = resolveModelSelection({ aiProvider: "openai", apiKey: "sk-test" });

        expect(selection).toEqual({
            textProvider: "openai",
            textModel: "gpt-6-luna",
            imageProvider: "openai",
            imageModel: "gpt-image-1-mini",
            imageQuality: "low",
            imageFreeTier: false,
        });
    });

    test("respects model and quality overrides", () => {
        const selection = resolveModelSelection({
            aiProvider: "openai",
            apiKey: "sk-test",
            textModel: "gpt-5.4-nano",
            imageModel: "gpt-image-1.5",
            imageQuality: "medium",
        });

        expect(selection.textModel).toBe("gpt-5.4-nano");
        expect(selection.imageModel).toBe("gpt-image-1.5");
        expect(selection.imageQuality).toBe("medium");
    });

    test("OpenAI images without any API key are disabled", () => {
        const selection = resolveModelSelection({ aiProvider: "openai" });

        expect(selection.imageProvider).toBe("none");
    });

    test("explicit IMAGE_PROVIDER=none disables images", () => {
        const selection = resolveModelSelection({
            aiProvider: "openai",
            apiKey: "sk-test",
            imageProvider: "none",
        });

        expect(selection.imageProvider).toBe("none");
        expect(selection.imageModel).toBeUndefined();
    });

    test("Pollinations sk_ keys use paid images, pk_ keys use the free tier", () => {
        const secret = resolveModelSelection({ aiProvider: "pollinations", apiKey: "sk_abc" });
        const publishable = resolveModelSelection({ aiProvider: "pollinations", apiKey: "pk_abc" });

        expect(secret.imageFreeTier).toBe(false);
        expect(publishable.imageFreeTier).toBe(true);
        expect(publishable.imageModel).toBe("flux");
    });

    test("an explicit image API key makes Pollinations images keyed", () => {
        const selection = resolveModelSelection({
            aiProvider: "pollinations",
            apiKey: "pk_abc",
            imageApiKey: "sk_img",
        });

        expect(selection.imageFreeTier).toBe(false);
    });

    test("Pollinations images default to the shared default model", () => {
        const selection = resolveModelSelection({ aiProvider: "pollinations" });

        expect(selection.imageModel).toBe(DEFAULT_POLLINATIONS_IMAGE_MODEL);
    });
});

describe("parseAIProvider", () => {
    test("defaults to Pollinations when AI_PROVIDER is unset", () => {
        expect(parseAIProvider(undefined)).toBe("pollinations");
        expect(parseAIProvider("")).toBe("pollinations");
    });

    test("accepts supported providers", () => {
        expect(parseAIProvider("openai")).toBe("openai");
        expect(parseAIProvider("pollinations")).toBe("pollinations");
    });

    test("explains that GitHub Models is retired", () => {
        expect(() => parseAIProvider("github-models")).toThrow(/retired/);
    });

    test("rejects unknown providers", () => {
        expect(() => parseAIProvider("foo")).toThrow(/Unknown AI_PROVIDER "foo"/);
    });
});

describe("PollinationsImageProvider", () => {
    test("uses the same default model as the factory", () => {
        expect(new PollinationsImageProvider()).toMatchObject({
            model: DEFAULT_POLLINATIONS_IMAGE_MODEL,
        });
    });
});
