import { describe, expect, test } from "bun:test";

import { resolveModelSelection } from "../../../src/providers/factory.js";

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

    test("GitHub Models falls back to free Pollinations images", () => {
        const selection = resolveModelSelection({ aiProvider: "github-models", apiKey: "ghp_x" });

        expect(selection.imageProvider).toBe("pollinations");
        expect(selection.imageFreeTier).toBe(true);
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
});
