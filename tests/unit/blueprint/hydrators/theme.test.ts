import { describe, expect, test } from "bun:test";

import type { ChatMessage, TextProvider } from "../../../../src/types/index.js";

import { hydrateBrandColors } from "../../../../src/blueprint/hydrators/theme.js";

class MockBrandColorProvider implements TextProvider {
    readonly name = "mock-brand-colors";
    readonly isSequential = false;
    readonly maxConcurrency = 10;
    readonly tokenLimit = 100000;
    lastMessages: ChatMessage[] = [];

    async generateCompletion(messages: ChatMessage[]): Promise<string> {
        this.lastMessages = messages;
        return JSON.stringify({
            primary: "#E91E63",
            secondary: "#F8BBD0",
        });
    }
}

describe("hydrateBrandColors", () => {
    test("returns only primary and secondary", async () => {
        const provider = new MockBrandColorProvider();
        const result = await hydrateBrandColors(
            provider,
            "beauty",
            "Beauty and cosmetics products"
        );

        expect(result.primary).toBe("#E91E63");
        expect(result.secondary).toBe("#F8BBD0");
        expect(Object.keys(result)).toHaveLength(2);
    });

    test("prompt includes store name and description", async () => {
        const provider = new MockBrandColorProvider();
        await hydrateBrandColors(provider, "garden", "Plants and garden tools");

        const userMessage = provider.lastMessages.find((m) => m.role === "user")?.content ?? "";
        expect(userMessage).toContain("garden");
        expect(userMessage).toContain("Plants and garden tools");
    });

    test("prompt includes system role for brand designer", async () => {
        const provider = new MockBrandColorProvider();
        await hydrateBrandColors(provider, "tech", "Electronics and gadgets");

        const systemMessage = provider.lastMessages.find((m) => m.role === "system")?.content ?? "";
        expect(systemMessage).toContain("brand designer");
    });

    test("prompt mentions Material Design", async () => {
        const provider = new MockBrandColorProvider();
        await hydrateBrandColors(provider, "tech", "Electronics");

        const systemMessage = provider.lastMessages.find((m) => m.role === "system")?.content ?? "";
        expect(systemMessage).toContain("Material Design");
    });

    test("returns fallback colors on invalid hex format", async () => {
        const badProvider: TextProvider = {
            name: "bad",
            isSequential: false,
            maxConcurrency: 10,
            tokenLimit: 100000,
            async generateCompletion(): Promise<string> {
                return JSON.stringify({
                    primary: "not-a-color",
                    secondary: "#FF0000",
                });
            },
        };

        const result = await hydrateBrandColors(badProvider, "test", "Test store");
        expect(result.primary).toMatch(/^#[0-9a-fA-F]{6}$/);
        expect(result.secondary).toMatch(/^#[0-9a-fA-F]{6}$/);
    });

    test("rejects extra fields beyond primary and secondary", async () => {
        const extraProvider: TextProvider = {
            name: "extra",
            isSequential: false,
            maxConcurrency: 10,
            tokenLimit: 100000,
            async generateCompletion(): Promise<string> {
                return JSON.stringify({
                    primary: "#4CAF50",
                    secondary: "#81C784",
                    buyButton: "#388E3C",
                });
            },
        };

        const result = await hydrateBrandColors(extraProvider, "eco", "Eco-friendly products");
        expect(result.primary).toBe("#4CAF50");
        expect(result.secondary).toBe("#81C784");
        expect(Object.keys(result)).toHaveLength(2);
    });
});
