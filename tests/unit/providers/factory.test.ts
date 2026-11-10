import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { ImageProvider, ProviderConfig } from "../../../src/types/index.js";
import type { LogOptions } from "../../../src/utils/index.js";

import {
    createProviders,
    parseAIProvider,
    resolveModelSelection,
} from "../../../src/providers/factory.js";
import { NoOpImageProvider } from "../../../src/providers/noop-provider.js";
import { OpenAIImageProvider } from "../../../src/providers/openai-provider.js";
import { PollinationsImageProvider } from "../../../src/providers/pollinations-provider.js";
import { DEFAULT_POLLINATIONS_IMAGE_MODEL } from "../../../src/types/index.js";
import { logger } from "../../../src/utils/index.js";

interface CreatedImage {
    image: ImageProvider;
    /** Log lines other than the provider summary lines */
    infos: string[];
    warns: string[];
}

/** Record info lines; lines that are not CLI output get a "file: " prefix */
function recordInfos(infos: string[]): void {
    spyOn(logger, "info").mockImplementation((message: string, options?: LogOptions) => {
        infos.push(options?.cli === true ? message : `file: ${message}`);
    });
}

function createImage(config: ProviderConfig): CreatedImage {
    const infos: string[] = [];
    const warns: string[] = [];
    recordInfos(infos);
    spyOn(logger, "warn").mockImplementation((message: string) => {
        warns.push(message);
    });
    const { image } = createProviders(config);
    const summary = (m: string): boolean =>
        m.startsWith("Text provider: ") || m.startsWith("Image provider: ");
    return { image, infos: infos.filter((m) => !summary(m)), warns };
}

describe("createProviders image provider", () => {
    afterEach(() => {
        mock.restore();
    });

    test("OpenAI images use the image key or the main key, with model and quality", () => {
        const own = createImage({ aiProvider: "openai", apiKey: "sk-main", imageApiKey: "sk-img" });
        expect(own.image).toBeInstanceOf(OpenAIImageProvider);
        expect(own.image).toMatchObject({ model: "gpt-image-1-mini", quality: "low" });
        expect(own.warns).toEqual([]);
        expect(own.infos).toEqual([]);

        const main = createImage({
            aiProvider: "openai",
            apiKey: "sk-main",
            imageModel: "gpt-image-1.5",
            imageQuality: "high",
        });
        expect(main.image).toMatchObject({ model: "gpt-image-1.5", quality: "high" });
    });

    test("an explicit OpenAI image provider falls back to the main key", () => {
        const { image, warns } = createImage({
            aiProvider: "pollinations",
            apiKey: "pk_x",
            imageProvider: "openai",
            imageApiKey: "",
        });
        expect(image).toBeInstanceOf(OpenAIImageProvider);
        expect(warns).toEqual([]);
    });

    test("summary lines name the providers", () => {
        const infos: string[] = [];
        recordInfos(infos);
        createProviders({ aiProvider: "openai", apiKey: "sk-x", imageProvider: "none" });
        expect(infos).toEqual([
            "Text provider: openai (sequential: false)",
            "Image provider: none (sequential: false)",
        ]);
    });

    test("Pollinations uses an explicit image key without a log line", () => {
        const { image, infos } = createImage({
            aiProvider: "pollinations",
            apiKey: "pk_main",
            imageApiKey: "pk_img",
            imageModel: "klein",
        });
        expect(image).toBeInstanceOf(PollinationsImageProvider);
        expect(image).toMatchObject({ apiKey: "pk_img", model: "klein" });
        expect(infos).toEqual([]);
    });

    test("Pollinations passes sk_ keys through and uses the default model", () => {
        const { image, infos } = createImage({ aiProvider: "pollinations", apiKey: "sk_main" });
        expect(image).toMatchObject({ apiKey: "sk_main", model: DEFAULT_POLLINATIONS_IMAGE_MODEL });
        expect(infos).toEqual([]);
    });

    test("Pollinations keeps pk_ keys for text and uses the free tier", () => {
        const { image, infos } = createImage({ aiProvider: "pollinations", apiKey: "pk_main" });
        expect(image).toMatchObject({ apiKey: "" });
        expect(infos).toEqual([
            "Using Pollinations free image generation (pk_ key preserved for text)",
        ]);
    });

    test("Pollinations images with another main key use the free tier", () => {
        const { image, infos } = createImage({
            aiProvider: "openai",
            apiKey: "sk-openai",
            imageProvider: "pollinations",
        });
        expect(image).toBeInstanceOf(PollinationsImageProvider);
        expect(image).toMatchObject({ apiKey: "" });
        expect(infos).toEqual([
            "Using Pollinations free image generation (no image API key needed)",
        ]);
    });

    test("IMAGE_PROVIDER=none disables images", () => {
        const { image } = createImage({
            aiProvider: "openai",
            apiKey: "sk-x",
            imageProvider: "none",
        });
        expect(image).toBeInstanceOf(NoOpImageProvider);
    });
});

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
