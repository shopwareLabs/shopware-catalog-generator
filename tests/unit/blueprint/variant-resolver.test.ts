import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ChatMessage, TextProvider } from "../../../src/types/index.js";

import { PropertyCache } from "../../../src/property-cache.js";
import { VariantResolver } from "../../../src/blueprint/variant-resolver.js";

class MockTextProvider implements TextProvider {
    readonly name = "mock";
    readonly isSequential = false;
    readonly maxConcurrency = 5;
    readonly tokenLimit = 100000;

    response = JSON.stringify({
        groupName: "Size",
        options: ["S", "M", "L", "XL", "XXL"],
        priceModifiers: [
            { option: "S", modifier: 0.9 },
            { option: "M", modifier: 1.0 },
            { option: "L", modifier: 1.05 },
            { option: "XL", modifier: 1.1 },
            { option: "XXL", modifier: 1.15 },
        ],
    });
    shouldThrow = false;
    calls = 0;

    async generateCompletion(_messages: ChatMessage[]): Promise<string> {
        this.calls++;
        if (this.shouldThrow) {
            throw new Error("mock provider failure");
        }
        return this.response;
    }
}

describe("VariantResolver", () => {
    let tempDir: string;
    let cache: PropertyCache;
    let provider: MockTextProvider;
    let resolver: VariantResolver;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "variant-resolver-test-"));
        cache = new PropertyCache(tempDir);
        provider = new MockTextProvider();
        resolver = new VariantResolver(provider, cache);
    });

    afterEach(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true });
        }
    });

    test("returns empty array when suggested groups are missing", async () => {
        const result = await resolver.resolveVariantConfigs(undefined, {
            name: "Product",
            category: "Category",
        });
        expect(result).toEqual([]);
    });

    test("resolves from cache without AI call", async () => {
        cache.createGroup("Material", ["Wood", "Steel", "Glass"], "text", {
            Wood: 1.0,
            Steel: 1.2,
            Glass: 1.1,
        });

        const result = await resolver.resolveVariantConfigs(["Material"], {
            name: "Table",
            category: "Furniture",
        });

        expect(provider.calls).toBe(0);
        expect(result).toHaveLength(1);
        expect(result[0]?.group).toBe("Material");
        expect(result[0]?.selectedOptions.length).toBeGreaterThanOrEqual(2);
        expect(Object.keys(result[0]?.priceModifiers ?? {})).toHaveLength(
            result[0]?.selectedOptions.length ?? 0
        );
    });

    test("uses color fallback from universal cache", async () => {
        cache.seedDefaults();

        const result = await resolver.resolveSingleVariantConfig("Color", {
            name: "Sofa",
            category: "Living Room",
        });

        expect(result).not.toBeNull();
        expect(result?.group).toBe("Color");
        expect(result?.selectedOptions.length).toBeGreaterThanOrEqual(2);
        expect(provider.calls).toBe(0);
    });

    test("generates missing property group via AI and stores it", async () => {
        const result = await resolver.resolveSingleVariantConfig("Size", {
            name: "T-Shirt",
            category: "Fashion",
        });

        expect(result).not.toBeNull();
        expect(result?.group).toBe("Size");
        expect(result?.selectedOptions.length).toBeGreaterThanOrEqual(2);
        expect(provider.calls).toBe(1);
        expect(cache.has("Size")).toBe(true);
    });

    test("returns null when AI generation fails", async () => {
        provider.shouldThrow = true;

        const result = await resolver.resolveSingleVariantConfig("Length", {
            name: "Curtain",
            category: "Home Decor",
        });

        expect(result).toBeNull();
        expect(provider.calls).toBe(1);
    });
});

