import { describe, expect, test } from "bun:test";

import {
    PollinationsTextProvider,
    PollinationsImageProvider,
} from "../../../src/providers/pollinations-provider.js";

describe("PollinationsTextProvider", () => {
    describe("constructor", () => {
        test("uses default model with pk key", () => {
            const provider = new PollinationsTextProvider("openai", "pk_test123");
            expect(provider.name).toBe("pollinations");
        });

        test("uses custom model when specified", () => {
            const provider = new PollinationsTextProvider("gpt-4o", "pk_test123");
            expect(provider.name).toBe("pollinations");
        });

        test("is sequential with pk_* key", () => {
            const provider = new PollinationsTextProvider("openai", "pk_test123");
            expect(provider.isSequential).toBe(true);
            expect(provider.maxConcurrency).toBe(1);
        });

        test("is parallel with sk_* key", () => {
            const provider = new PollinationsTextProvider("openai", "sk_test123");
            expect(provider.isSequential).toBe(false);
            expect(provider.maxConcurrency).toBe(5);
        });

        test("has correct token limit", () => {
            const provider = new PollinationsTextProvider("openai", "pk_test123");
            expect(provider.tokenLimit).toBe(32000);
        });
    });
});

describe("PollinationsImageProvider", () => {
    describe("constructor", () => {
        test("uses default model when not specified", () => {
            const provider = new PollinationsImageProvider("pk_test123");
            expect(provider.name).toBe("pollinations");
        });

        test("uses custom model when specified", () => {
            const provider = new PollinationsImageProvider("pk_test123", "flux");
            expect(provider.name).toBe("pollinations");
        });

        test("is sequential with pk_* key", () => {
            const provider = new PollinationsImageProvider("pk_test123");
            expect(provider.isSequential).toBe(true);
            expect(provider.maxConcurrency).toBe(2);
        });

        test("is parallel with sk_* key", () => {
            const provider = new PollinationsImageProvider("sk_test123");
            expect(provider.isSequential).toBe(false);
            expect(provider.maxConcurrency).toBe(5);
        });
    });
});
