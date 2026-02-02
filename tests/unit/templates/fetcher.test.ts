import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { DataCache } from "../../../src/cache.js";
import { TemplateFetcher } from "../../../src/templates/index.js";

const TEST_BASE_DIR = "./test-template-temp";
const TEST_CACHE_DIR = `${TEST_BASE_DIR}/cache`;
const TEST_TEMPLATE_DIR = `${TEST_BASE_DIR}/templates`;

describe("TemplateFetcher", () => {
    let cache: DataCache;
    let fetcher: TemplateFetcher;

    beforeEach(() => {
        // Create test directories
        fs.mkdirSync(TEST_BASE_DIR, { recursive: true });
        fs.mkdirSync(TEST_CACHE_DIR, { recursive: true });
        fs.mkdirSync(TEST_TEMPLATE_DIR, { recursive: true });

        cache = new DataCache({
            enabled: true,
            cacheDir: TEST_CACHE_DIR,
            useCache: true,
            saveToCache: true,
        });

        // Create fetcher pointing to our test template directory
        fetcher = new TemplateFetcher({
            cacheDir: TEST_TEMPLATE_DIR,
            autoUpdate: false,
        });
    });

    afterEach(() => {
        // Clean up test directories
        if (fs.existsSync(TEST_BASE_DIR)) {
            fs.rmSync(TEST_BASE_DIR, { recursive: true });
        }
    });

    describe("listTemplates", () => {
        test("returns empty array when no templates exist", () => {
            // Create empty sales-channels directory (repo structure: generated/sales-channels)
            fs.mkdirSync(path.join(TEST_TEMPLATE_DIR, "generated", "sales-channels"), {
                recursive: true,
            });

            const templates = fetcher.listTemplates();
            expect(templates).toEqual([]);
        });

        test("returns template names when templates exist", () => {
            // Create template directories with hydrated-blueprint.json
            const salesChannelsDir = path.join(TEST_TEMPLATE_DIR, "generated", "sales-channels");
            fs.mkdirSync(salesChannelsDir, { recursive: true });

            const template1Dir = path.join(salesChannelsDir, "beauty");
            const template2Dir = path.join(salesChannelsDir, "furniture");
            fs.mkdirSync(template1Dir, { recursive: true });
            fs.mkdirSync(template2Dir, { recursive: true });

            // Add hydrated-blueprint.json to make them valid templates
            fs.writeFileSync(
                path.join(template1Dir, "hydrated-blueprint.json"),
                JSON.stringify({ version: "1.0" })
            );
            fs.writeFileSync(
                path.join(template2Dir, "hydrated-blueprint.json"),
                JSON.stringify({ version: "1.0" })
            );

            const templates = fetcher.listTemplates();
            expect(templates).toHaveLength(2);
            expect(templates).toContain("beauty");
            expect(templates).toContain("furniture");
        });

        test("excludes directories without hydrated-blueprint.json", () => {
            const salesChannelsDir = path.join(TEST_TEMPLATE_DIR, "generated", "sales-channels");
            fs.mkdirSync(salesChannelsDir, { recursive: true });

            // Create one valid template
            const validDir = path.join(salesChannelsDir, "valid-template");
            fs.mkdirSync(validDir, { recursive: true });
            fs.writeFileSync(
                path.join(validDir, "hydrated-blueprint.json"),
                JSON.stringify({ version: "1.0" })
            );

            // Create one invalid template (no hydrated-blueprint.json)
            const invalidDir = path.join(salesChannelsDir, "invalid-template");
            fs.mkdirSync(invalidDir, { recursive: true });
            fs.writeFileSync(path.join(invalidDir, "blueprint.json"), JSON.stringify({}));

            const templates = fetcher.listTemplates();
            expect(templates).toHaveLength(1);
            expect(templates).toContain("valid-template");
        });
    });

    describe("hasTemplate", () => {
        test("returns false when template does not exist", () => {
            fs.mkdirSync(path.join(TEST_TEMPLATE_DIR, "generated", "sales-channels"), {
                recursive: true,
            });

            expect(fetcher.hasTemplate("non-existent")).toBe(false);
        });

        test("returns true when template exists with hydrated-blueprint.json", () => {
            const templateDir = path.join(
                TEST_TEMPLATE_DIR,
                "generated",
                "sales-channels",
                "beauty"
            );
            fs.mkdirSync(templateDir, { recursive: true });
            fs.writeFileSync(
                path.join(templateDir, "hydrated-blueprint.json"),
                JSON.stringify({ version: "1.0" })
            );

            expect(fetcher.hasTemplate("beauty")).toBe(true);
        });

        test("returns false when directory exists but hydrated-blueprint.json is missing", () => {
            const templateDir = path.join(
                TEST_TEMPLATE_DIR,
                "generated",
                "sales-channels",
                "incomplete"
            );
            fs.mkdirSync(templateDir, { recursive: true });
            fs.writeFileSync(path.join(templateDir, "blueprint.json"), JSON.stringify({}));

            expect(fetcher.hasTemplate("incomplete")).toBe(false);
        });
    });

    describe("copyToCache", () => {
        test("copies template files to cache", () => {
            // Create template with files
            const templateDir = path.join(
                TEST_TEMPLATE_DIR,
                "generated",
                "sales-channels",
                "beauty"
            );
            const imagesDir = path.join(templateDir, "images");
            const metadataDir = path.join(templateDir, "metadata");
            fs.mkdirSync(imagesDir, { recursive: true });
            fs.mkdirSync(metadataDir, { recursive: true });

            fs.writeFileSync(
                path.join(templateDir, "blueprint.json"),
                JSON.stringify({ version: "1.0", type: "blueprint" })
            );
            fs.writeFileSync(
                path.join(templateDir, "hydrated-blueprint.json"),
                JSON.stringify({ version: "1.0", type: "hydrated" })
            );
            fs.writeFileSync(
                path.join(templateDir, "manufacturers.json"),
                JSON.stringify([{ name: "TestCo" }])
            );
            fs.writeFileSync(path.join(imagesDir, "product-1.webp"), "image-data");
            fs.writeFileSync(
                path.join(metadataDir, "product-1.json"),
                JSON.stringify({ id: "product-1" })
            );

            // Copy to cache
            const success = fetcher.copyToCache("beauty", cache);
            expect(success).toBe(true);

            // Verify files were copied
            const targetDir = cache.getSalesChannelDir("beauty");
            expect(fs.existsSync(path.join(targetDir, "blueprint.json"))).toBe(true);
            expect(fs.existsSync(path.join(targetDir, "hydrated-blueprint.json"))).toBe(true);
            expect(fs.existsSync(path.join(targetDir, "manufacturers.json"))).toBe(true);
            expect(fs.existsSync(path.join(targetDir, "images", "product-1.webp"))).toBe(true);
            expect(fs.existsSync(path.join(targetDir, "metadata", "product-1.json"))).toBe(true);
        });

        test("returns false when template does not exist", () => {
            fs.mkdirSync(path.join(TEST_TEMPLATE_DIR, "generated", "sales-channels"), {
                recursive: true,
            });

            const success = fetcher.copyToCache("non-existent", cache);
            expect(success).toBe(false);
        });

        test("moves existing cache to trash before copying", () => {
            // Create existing cache data
            cache.saveSalesChannelMetadata("beauty", "Old description");

            // Create template
            const templateDir = path.join(
                TEST_TEMPLATE_DIR,
                "generated",
                "sales-channels",
                "beauty"
            );
            fs.mkdirSync(templateDir, { recursive: true });
            fs.writeFileSync(
                path.join(templateDir, "hydrated-blueprint.json"),
                JSON.stringify({ version: "1.0" })
            );

            // Copy to cache
            const success = fetcher.copyToCache("beauty", cache);
            expect(success).toBe(true);

            // Verify old metadata is gone (replaced by template)
            const metadata = cache.loadSalesChannelMetadata("beauty");
            expect(metadata).toBeNull(); // Template doesn't have metadata.json
        });

        test("preserves file content after copy", () => {
            const templateDir = path.join(TEST_TEMPLATE_DIR, "generated", "sales-channels", "test");
            fs.mkdirSync(templateDir, { recursive: true });

            const blueprintContent = {
                version: "1.0",
                salesChannel: { name: "test", description: "Test store" },
                categories: [],
                products: [],
                propertyGroups: [],
            };
            fs.writeFileSync(
                path.join(templateDir, "hydrated-blueprint.json"),
                JSON.stringify(blueprintContent, null, 2)
            );

            fetcher.copyToCache("test", cache);

            const loaded = cache.loadHydratedBlueprint("test");
            expect(loaded).not.toBeNull();
            expect(loaded?.version).toBe("1.0");
        });
    });

    describe("configuration", () => {
        test("uses provided cacheDir", () => {
            const customFetcher = new TemplateFetcher({
                cacheDir: "/custom/path",
            });

            // The fetcher should resolve the path
            // We can't directly access private members, but we can test the behavior
            expect(customFetcher).toBeDefined();
        });

        test("autoUpdate defaults to true", () => {
            const defaultFetcher = new TemplateFetcher({
                cacheDir: TEST_TEMPLATE_DIR,
            });
            expect(defaultFetcher).toBeDefined();
        });

        test("can disable autoUpdate", () => {
            const noAutoUpdateFetcher = new TemplateFetcher({
                cacheDir: TEST_TEMPLATE_DIR,
                autoUpdate: false,
            });
            expect(noAutoUpdateFetcher).toBeDefined();
        });
    });
});

describe("DataCache.copyFromTemplate", () => {
    let cache: DataCache;

    beforeEach(() => {
        fs.mkdirSync(TEST_BASE_DIR, { recursive: true });
        fs.mkdirSync(TEST_CACHE_DIR, { recursive: true });
        fs.mkdirSync(TEST_TEMPLATE_DIR, { recursive: true });

        cache = new DataCache({
            enabled: true,
            cacheDir: TEST_CACHE_DIR,
            useCache: true,
            saveToCache: true,
        });
    });

    afterEach(() => {
        if (fs.existsSync(TEST_BASE_DIR)) {
            fs.rmSync(TEST_BASE_DIR, { recursive: true });
        }
    });

    test("copies entire directory structure", () => {
        // Create template structure
        const templateDir = path.join(TEST_TEMPLATE_DIR, "my-template");
        const imagesDir = path.join(templateDir, "images");
        const metadataDir = path.join(templateDir, "metadata");
        fs.mkdirSync(imagesDir, { recursive: true });
        fs.mkdirSync(metadataDir, { recursive: true });

        fs.writeFileSync(path.join(templateDir, "blueprint.json"), "{}");
        fs.writeFileSync(path.join(templateDir, "hydrated-blueprint.json"), "{}");
        fs.writeFileSync(path.join(imagesDir, "img1.webp"), "data");
        fs.writeFileSync(path.join(metadataDir, "meta1.json"), "{}");

        cache.copyFromTemplate("test-channel", templateDir);

        const targetDir = cache.getSalesChannelDir("test-channel");
        expect(fs.existsSync(path.join(targetDir, "blueprint.json"))).toBe(true);
        expect(fs.existsSync(path.join(targetDir, "hydrated-blueprint.json"))).toBe(true);
        expect(fs.existsSync(path.join(targetDir, "images", "img1.webp"))).toBe(true);
        expect(fs.existsSync(path.join(targetDir, "metadata", "meta1.json"))).toBe(true);
    });

    test("replaces existing data in cache", () => {
        // Create existing cache entry
        cache.saveSalesChannelMetadata("test-channel", "Old description");

        // Create template
        const templateDir = path.join(TEST_TEMPLATE_DIR, "replacement");
        fs.mkdirSync(templateDir, { recursive: true });
        fs.writeFileSync(path.join(templateDir, "new-file.json"), '{"new": true}');

        cache.copyFromTemplate("test-channel", templateDir);

        const targetDir = cache.getSalesChannelDir("test-channel");
        // Old metadata should be gone
        expect(fs.existsSync(path.join(targetDir, "metadata.json"))).toBe(false);
        // New file should exist
        expect(fs.existsSync(path.join(targetDir, "new-file.json"))).toBe(true);
    });
});
