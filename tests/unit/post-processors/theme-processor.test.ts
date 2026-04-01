import { describe, expect, test } from "bun:test";

import type { BrandColors } from "../../../src/types/index.js";

import { ThemeProcessor, buildThemeConfig } from "../../../src/post-processors/theme-processor.js";
import { createTestBlueprint } from "../../helpers/blueprint-factory.js";
import { createTestContext } from "../../helpers/post-processor-context.js";

describe("ThemeProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(ThemeProcessor.name).toBe("theme");
        });

        test("has description", () => {
            expect(ThemeProcessor.description).toBeDefined();
            expect(ThemeProcessor.description.length).toBeGreaterThan(0);
        });

        test("has no dependencies", () => {
            expect(ThemeProcessor.dependsOn).toEqual([]);
        });
    });

    describe("process", () => {
        test("dry run skips processing", async () => {
            const { context } = createTestContext({ dryRun: true });
            const result = await ThemeProcessor.process(context);

            expect(result.name).toBe("theme");
            expect(result.processed).toBe(0);
            expect(result.skipped).toBe(1);
            expect(result.errors).toEqual([]);
        });

        test("returns error when no Storefront theme found", async () => {
            const blueprint = createTestBlueprint({
                brandColors: { primary: "#FF0000", secondary: "#0000FF" },
            });
            const { context } = createTestContext({ blueprint });
            const result = await ThemeProcessor.process(context);

            expect(result.processed).toBe(0);
            expect(result.skipped).toBe(1);
            expect(result.errors).toContain("No Storefront theme found");
        });
    });

    describe("cleanup", () => {
        test("dry run skips cleanup", async () => {
            const { context } = createTestContext({ dryRun: true });
            const result = await ThemeProcessor.cleanup!(context);

            expect(result.name).toBe("theme");
            expect(result.deleted).toBe(0);
            expect(result.errors).toEqual([]);
        });
    });

    describe("stale cache across invocations", () => {
        test("process does not reuse media IDs cached by a prior cleanup", async () => {
            const blueprint = createTestBlueprint({
                brandColors: { primary: "#FF0000", secondary: "#0000FF" },
            });

            const storefrontThemeId = "storefront-theme-id";
            const childThemeId = "child-theme-id";
            const staleMediaId = "stale-media-id";

            const { context: cleanupCtx, mockApi: cleanupApi } = createTestContext({ blueprint });
            cleanupApi.mockPostResponse("search/theme", {
                data: [{ id: storefrontThemeId, technicalName: "Storefront", name: "Storefront" }],
                total: 1,
            });
            cleanupApi.mockPostResponse("search/theme", { data: [], total: 0 });
            cleanupApi.mockPostResponse("search/media", {
                data: [{ id: staleMediaId }],
                total: 1,
            });

            await ThemeProcessor.cleanup!(cleanupCtx);

            const { context: processCtx, mockApi: processApi } = createTestContext({ blueprint });
            processApi.mockPostResponse("search/theme", {
                data: [{ id: storefrontThemeId, technicalName: "Storefront", name: "Storefront" }],
                total: 1,
            });
            processApi.mockPostResponse("search/theme", {
                data: [{ id: childThemeId, name: "Test-store Theme" }],
                total: 1,
            });
            processApi.mockPostResponse("search/media", { data: [], total: 0 });

            const result = await ThemeProcessor.process(processCtx);

            expect(result.errors).not.toContain("Failed to update theme config");
        });
    });
});

describe("buildThemeConfig", () => {
    test("derives all 5 color keys from primary + secondary", () => {
        const colors: BrandColors = {
            primary: "#E91E63",
            secondary: "#F8BBD0",
        };

        const config = buildThemeConfig(colors);

        expect(config["sw-color-brand-primary"]).toEqual({ value: "#E91E63" });
        expect(config["sw-color-brand-secondary"]).toEqual({ value: "#F8BBD0" });
        expect(config["sw-color-buy-button"]).toEqual({ value: "#E91E63" });
        expect(config["sw-color-price"]).toEqual({ value: "#E91E63" });
    });

    test("buy-button-text is white for dark primary (Material Design 'On' color)", () => {
        const config = buildThemeConfig({ primary: "#1a237e", secondary: "#C5CAE9" });

        expect(config["sw-color-buy-button-text"]).toEqual({ value: "#ffffff" });
    });

    test("buy-button-text is black for light primary (Material Design 'On' color)", () => {
        const config = buildThemeConfig({ primary: "#FFEB3B", secondary: "#FFF9C4" });

        expect(config["sw-color-buy-button-text"]).toEqual({ value: "#000000" });
    });

    test("always produces exactly 5 color keys", () => {
        const config = buildThemeConfig({ primary: "#4CAF50", secondary: "#81C784" });

        const colorKeys = Object.keys(config).filter((k) => k.startsWith("sw-color"));
        expect(colorKeys).toHaveLength(5);
    });

    test("maps logo mediaId to all three viewport fields", () => {
        const mediaIds = { logo: "media-logo-id" };

        const config = buildThemeConfig(undefined, mediaIds);

        expect(config["sw-logo-desktop"]).toEqual({ value: "media-logo-id" });
        expect(config["sw-logo-tablet"]).toEqual({ value: "media-logo-id" });
        expect(config["sw-logo-mobile"]).toEqual({ value: "media-logo-id" });
    });

    test("maps favicon and share mediaIds", () => {
        const mediaIds = {
            favicon: "media-favicon-id",
            share: "media-share-id",
        };

        const config = buildThemeConfig(undefined, mediaIds);

        expect(config["sw-logo-favicon"]).toEqual({ value: "media-favicon-id" });
        expect(config["sw-logo-share"]).toEqual({ value: "media-share-id" });
    });

    test("combines colors and media in one config", () => {
        const colors: BrandColors = {
            primary: "#FF6B9D",
            secondary: "#FFB6C1",
        };
        const mediaIds = {
            logo: "media-logo-id",
            favicon: "media-favicon-id",
            share: "media-share-id",
        };

        const config = buildThemeConfig(colors, mediaIds);

        expect(Object.keys(config)).toHaveLength(10);
        expect(config["sw-color-brand-primary"]).toEqual({ value: "#FF6B9D" });
        expect(config["sw-color-buy-button"]).toEqual({ value: "#FF6B9D" });
        expect(config["sw-logo-desktop"]).toEqual({ value: "media-logo-id" });
        expect(config["sw-logo-favicon"]).toEqual({ value: "media-favicon-id" });
        expect(config["sw-logo-share"]).toEqual({ value: "media-share-id" });
    });

    test("returns empty config when no colors or media", () => {
        const config = buildThemeConfig();
        expect(Object.keys(config)).toHaveLength(0);
    });

    test("returns empty config with empty media", () => {
        const config = buildThemeConfig(undefined, {});
        expect(Object.keys(config)).toHaveLength(0);
    });
});
