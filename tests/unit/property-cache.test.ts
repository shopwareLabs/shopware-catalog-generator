import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    getUniversalPropertyGroups,
    UNIVERSAL_PROPERTY_GROUPS,
    getColorHexCode,
    COLOR_HEX_MAP,
} from "../../src/fixtures/property-groups.js";
import { PropertyCache } from "../../src/property-cache.js";
import type { CachedPropertyGroup } from "../../src/types/index.js";

describe("PropertyCache", () => {
    let tempDir: string;
    let cache: PropertyCache;

    beforeEach(() => {
        // Create a temp directory for tests
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "property-cache-test-"));
        cache = new PropertyCache(tempDir);
    });

    afterEach(() => {
        // Clean up temp directory
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true });
        }
    });

    describe("basic operations", () => {
        test("has() returns false for non-existent groups", () => {
            expect(cache.has("NonExistent")).toBe(false);
        });

        test("get() returns null for non-existent groups", () => {
            expect(cache.get("NonExistent")).toBeNull();
        });

        test("save() and get() work correctly", () => {
            const group: CachedPropertyGroup = {
                name: "Test Group",
                slug: "test-group",
                displayType: "text",
                options: ["Option A", "Option B", "Option C"],
                createdAt: new Date().toISOString(),
                source: "ai-generated",
            };

            cache.save(group);

            expect(cache.has("Test Group")).toBe(true);
            expect(cache.has("test group")).toBe(true); // Case insensitive
            expect(cache.has("TEST GROUP")).toBe(true); // Case insensitive

            const retrieved = cache.get("Test Group");
            expect(retrieved).not.toBeNull();
            expect(retrieved?.name).toBe("Test Group");
            expect(retrieved?.options).toEqual(["Option A", "Option B", "Option C"]);
            expect(retrieved?.displayType).toBe("text");
        });

        test("save() creates the cache directory if needed", () => {
            const newDir = path.join(tempDir, "nested", "cache");
            const newCache = new PropertyCache(newDir);

            newCache.save({
                name: "Test",
                slug: "test",
                displayType: "text",
                options: ["A", "B"],
                createdAt: new Date().toISOString(),
                source: "fixture",
            });

            expect(fs.existsSync(path.join(newDir, "properties"))).toBe(true);
        });

        test("save() writes files to disk", () => {
            cache.save({
                name: "Finish",
                slug: "finish",
                displayType: "text",
                options: ["Matte", "Glossy"],
                createdAt: new Date().toISOString(),
                source: "ai-generated",
            });

            const cacheDir = cache.getCacheDir();
            expect(fs.existsSync(path.join(cacheDir, "finish.json"))).toBe(true);
            expect(fs.existsSync(path.join(cacheDir, "index.json"))).toBe(true);
        });
    });

    describe("list operations", () => {
        test("list() returns empty array when cache is empty", () => {
            expect(cache.list()).toEqual([]);
        });

        test("list() returns all cached groups", () => {
            cache.save({
                name: "Size",
                slug: "size",
                displayType: "text",
                options: ["S", "M", "L"],
                createdAt: new Date().toISOString(),
                source: "fixture",
            });

            cache.save({
                name: "Color",
                slug: "color",
                displayType: "color",
                options: ["Red", "Blue"],
                createdAt: new Date().toISOString(),
                source: "fixture",
            });

            const groups = cache.list();
            expect(groups.length).toBe(2);
            expect(groups.map((g) => g.name)).toContain("Size");
            expect(groups.map((g) => g.name)).toContain("Color");
        });

        test("listNames() returns group names", () => {
            cache.save({
                name: "Size",
                slug: "size",
                displayType: "text",
                options: ["S", "M", "L"],
                createdAt: new Date().toISOString(),
                source: "fixture",
            });

            const names = cache.listNames();
            expect(names).toContain("Size");
        });
    });

    describe("seedGroups", () => {
        test("seedGroups() populates cache with given groups", () => {
            const groups: CachedPropertyGroup[] = [
                {
                    name: "Size",
                    slug: "size",
                    displayType: "text",
                    options: ["S", "M", "L"],
                    createdAt: new Date().toISOString(),
                    source: "fixture",
                },
            ];

            cache.seedGroups(groups);

            expect(cache.has("Size")).toBe(true);
        });

        test("seedGroups() does not overwrite existing groups by default", () => {
            // First add a group
            cache.save({
                name: "Size",
                slug: "size",
                displayType: "text",
                options: ["Original"],
                createdAt: new Date().toISOString(),
                source: "fixture",
            });

            // Try to seed with different options
            cache.seedGroups([
                {
                    name: "Size",
                    slug: "size",
                    displayType: "text",
                    options: ["New"],
                    createdAt: new Date().toISOString(),
                    source: "fixture",
                },
            ]);

            const retrieved = cache.get("Size");
            expect(retrieved?.options).toEqual(["Original"]);
        });

        test("seedGroups() with overwrite=true replaces existing groups", () => {
            // First add a group
            cache.save({
                name: "Size",
                slug: "size",
                displayType: "text",
                options: ["Original"],
                createdAt: new Date().toISOString(),
                source: "fixture",
            });

            // Seed with overwrite
            cache.seedGroups(
                [
                    {
                        name: "Size",
                        slug: "size",
                        displayType: "text",
                        options: ["New"],
                        createdAt: new Date().toISOString(),
                        source: "fixture",
                    },
                ],
                true
            );

            const retrieved = cache.get("Size");
            expect(retrieved?.options).toEqual(["New"]);
        });
    });

    describe("createGroup", () => {
        test("createGroup() creates and saves a new group", () => {
            const group = cache.createGroup("Pickup Type", ["Single Coil", "Humbucker", "P90"]);

            expect(group.name).toBe("Pickup Type");
            expect(group.slug).toBe("pickup-type");
            expect(group.displayType).toBe("text");
            expect(group.options).toEqual(["Single Coil", "Humbucker", "P90"]);
            expect(group.source).toBe("ai-generated");

            // Should also be in cache
            expect(cache.has("Pickup Type")).toBe(true);
        });

        test("createGroup() sets displayType based on parameter", () => {
            const colorGroup = cache.createGroup("Paint Color", ["Red", "Blue"], "color");
            expect(colorGroup.displayType).toBe("color");
        });

        test("createGroup() accepts price modifiers", () => {
            const group = cache.createGroup("Wood Type", ["Pine", "Oak", "Mahogany"], "text", {
                Pine: 0.9,
                Oak: 1.0,
                Mahogany: 1.2,
            });

            expect(group.priceModifiers).toEqual({
                Pine: 0.9,
                Oak: 1.0,
                Mahogany: 1.2,
            });
        });
    });

    describe("inferDisplayType", () => {
        test("returns 'color' for color-related names", () => {
            expect(PropertyCache.inferDisplayType("Color")).toBe("color");
            expect(PropertyCache.inferDisplayType("Colour")).toBe("color");
            expect(PropertyCache.inferDisplayType("Paint Color")).toBe("color");
            expect(PropertyCache.inferDisplayType("Farbe")).toBe("color");
        });

        test("returns 'text' for non-color names", () => {
            expect(PropertyCache.inferDisplayType("Size")).toBe("text");
            expect(PropertyCache.inferDisplayType("Material")).toBe("text");
            expect(PropertyCache.inferDisplayType("Finish")).toBe("text");
        });
    });

    describe("clear", () => {
        test("clear() removes all cached data", () => {
            cache.save({
                name: "Test",
                slug: "test",
                displayType: "text",
                options: ["A", "B"],
                createdAt: new Date().toISOString(),
                source: "fixture",
            });

            expect(cache.has("Test")).toBe(true);

            cache.clear();

            expect(cache.has("Test")).toBe(false);
            expect(cache.list()).toEqual([]);
        });
    });

    describe("persistence", () => {
        test("cache persists across instances", () => {
            // Save with first instance
            cache.save({
                name: "Persistent Group",
                slug: "persistent-group",
                displayType: "text",
                options: ["A", "B"],
                createdAt: new Date().toISOString(),
                source: "ai-generated",
            });

            // Create new instance with same directory
            const cache2 = new PropertyCache(tempDir);

            // Should load from disk
            expect(cache2.has("Persistent Group")).toBe(true);
            const retrieved = cache2.get("Persistent Group");
            expect(retrieved?.options).toEqual(["A", "B"]);
        });
    });
});

describe("Store-scoped PropertyCache", () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-cache-test-"));
    });

    afterEach(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true });
        }
    });

    test("forStore() creates store-scoped cache", () => {
        const storeCache = PropertyCache.forStore(tempDir, "beauty-store");

        expect(storeCache.isStoreScoped()).toBe(true);
        expect(storeCache.getStoreSlug()).toBe("beauty-store");
    });

    test("global() creates global cache", () => {
        const globalCache = PropertyCache.global(tempDir);

        expect(globalCache.isStoreScoped()).toBe(false);
        expect(globalCache.getStoreSlug()).toBeNull();
    });

    test("store-scoped cache uses store-specific directory", () => {
        const storeCache = PropertyCache.forStore(tempDir, "my-store");

        storeCache.save({
            name: "Volume",
            slug: "volume",
            displayType: "text",
            options: ["50ml", "100ml", "200ml"],
            createdAt: new Date().toISOString(),
            source: "ai-generated",
        });

        const expectedPath = path.join(tempDir, "sales-channels", "my-store", "properties", "volume.json");
        expect(fs.existsSync(expectedPath)).toBe(true);
    });

    test("universal properties (Color) are saved to global cache", () => {
        const storeCache = PropertyCache.forStore(tempDir, "my-store");

        // Color is a universal property and should go to global cache
        storeCache.save({
            name: "Color",
            slug: "color",
            displayType: "color",
            options: ["Red", "Blue"],
            createdAt: new Date().toISOString(),
            source: "fixture",
        });

        // Should be in global cache, not store-specific
        const globalPath = path.join(tempDir, "properties", "color.json");
        const storePath = path.join(tempDir, "sales-channels", "my-store", "properties", "color.json");

        expect(fs.existsSync(globalPath)).toBe(true);
        expect(fs.existsSync(storePath)).toBe(false);
    });

    test("store-scoped cache loads global properties", () => {
        // First, save a global property
        const globalCache = PropertyCache.global(tempDir);
        globalCache.save({
            name: "Color",
            slug: "color",
            displayType: "color",
            options: ["Red", "Blue", "Green"],
            createdAt: new Date().toISOString(),
            source: "fixture",
        });

        // Then create a store-scoped cache
        const storeCache = PropertyCache.forStore(tempDir, "my-store");

        // Should be able to access the global Color property
        expect(storeCache.has("Color")).toBe(true);
        const colorGroup = storeCache.get("Color");
        expect(colorGroup?.options).toContain("Red");
    });

    test("store-scoped cache combines global and store properties", () => {
        // Save global property
        const globalCache = PropertyCache.global(tempDir);
        globalCache.save({
            name: "Color",
            slug: "color",
            displayType: "color",
            options: ["Red", "Blue"],
            createdAt: new Date().toISOString(),
            source: "fixture",
        });

        // Save store-specific property
        const storeCache = PropertyCache.forStore(tempDir, "beauty-store");
        storeCache.save({
            name: "Volume",
            slug: "volume",
            displayType: "text",
            options: ["50ml", "100ml"],
            createdAt: new Date().toISOString(),
            source: "ai-generated",
        });

        // Store cache should see both
        expect(storeCache.has("Color")).toBe(true);
        expect(storeCache.has("Volume")).toBe(true);

        const allGroups = storeCache.list();
        expect(allGroups.map((g) => g.name)).toContain("Color");
        expect(allGroups.map((g) => g.name)).toContain("Volume");
    });

    test("different stores have isolated properties", () => {
        // Create two store caches
        const beautyCache = PropertyCache.forStore(tempDir, "beauty");
        const fashionCache = PropertyCache.forStore(tempDir, "fashion");

        // Save store-specific properties
        beautyCache.save({
            name: "Volume",
            slug: "volume",
            displayType: "text",
            options: ["50ml", "100ml"],
            createdAt: new Date().toISOString(),
            source: "ai-generated",
        });

        fashionCache.save({
            name: "Size",
            slug: "size",
            displayType: "text",
            options: ["S", "M", "L"],
            createdAt: new Date().toISOString(),
            source: "ai-generated",
        });

        // Each store should only see its own properties
        expect(beautyCache.has("Volume")).toBe(true);
        expect(beautyCache.has("Size")).toBe(false);

        expect(fashionCache.has("Size")).toBe(true);
        expect(fashionCache.has("Volume")).toBe(false);
    });
});

describe("Universal Property Group Fixtures", () => {
    test("UNIVERSAL_PROPERTY_GROUPS contains only Color", () => {
        expect(UNIVERSAL_PROPERTY_GROUPS.length).toBe(1);

        const names = UNIVERSAL_PROPERTY_GROUPS.map((g) => g.name);
        expect(names).toContain("Color");
        // Should NOT contain domain-specific groups
        expect(names).not.toContain("Size");
        expect(names).not.toContain("Material");
        expect(names).not.toContain("Body Wood");
        expect(names).not.toContain("Shoe Size");
    });

    test("getUniversalPropertyGroups() returns universal groups only", () => {
        const universalGroups = getUniversalPropertyGroups();

        expect(universalGroups.length).toBe(1);
        expect(universalGroups[0]?.name).toBe("Color");
    });

    test("Color fixture has color displayType", () => {
        const colorGroup = UNIVERSAL_PROPERTY_GROUPS.find((g) => g.name === "Color");
        expect(colorGroup?.displayType).toBe("color");
    });

    test("Color fixture has comprehensive color options", () => {
        const colorGroup = UNIVERSAL_PROPERTY_GROUPS.find((g) => g.name === "Color");
        expect(colorGroup?.options.length).toBeGreaterThanOrEqual(50);

        // Check for common colors
        expect(colorGroup?.options).toContain("Black");
        expect(colorGroup?.options).toContain("White");
        expect(colorGroup?.options).toContain("Red");
        expect(colorGroup?.options).toContain("Blue");
        expect(colorGroup?.options).toContain("Green");
    });

    test("COLOR_HEX_MAP provides hex codes for colors", () => {
        expect(COLOR_HEX_MAP["black"]).toBe("#1a1a1a");
        expect(COLOR_HEX_MAP["white"]).toBe("#ffffff");
        expect(COLOR_HEX_MAP["red"]).toBe("#dc2626");
    });

    test("getColorHexCode() returns hex code for color name", () => {
        expect(getColorHexCode("Black")).toBe("#1a1a1a");
        expect(getColorHexCode("RED")).toBe("#dc2626"); // Case insensitive
        expect(getColorHexCode("UnknownColor")).toBeUndefined();
    });

    test("fixture groups have required fields", () => {
        for (const group of UNIVERSAL_PROPERTY_GROUPS) {
            expect(group.name).toBeDefined();
            expect(group.slug).toBeDefined();
            expect(group.displayType).toMatch(/^(text|color)$/);
            expect(group.options.length).toBeGreaterThanOrEqual(2);
            expect(group.source).toBe("fixture");
        }
    });
});

describe("PropertyCache seeding", () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-test-"));
    });

    afterEach(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true });
        }
    });

    test("seedDefaults() creates Color in cache", () => {
        const cache = new PropertyCache(tempDir);
        cache.seedDefaults();

        expect(cache.has("Color")).toBe(true);

        // Check that JSON file was created
        const cacheDir = cache.getCacheDir();
        expect(fs.existsSync(path.join(cacheDir, "color.json"))).toBe(true);
    });

    test("seedDefaults() only seeds universal properties", () => {
        const cache = new PropertyCache(tempDir);
        cache.seedDefaults();

        // Should have Color
        expect(cache.has("Color")).toBe(true);

        // Should NOT have domain-specific properties
        expect(cache.has("Size")).toBe(false);
        expect(cache.has("Material")).toBe(false);
        expect(cache.has("Body Wood")).toBe(false);
    });

    test("ensureDefaults() seeds only if cache is empty", () => {
        const cache = new PropertyCache(tempDir);

        // First call should seed
        cache.ensureDefaults();
        expect(cache.has("Color")).toBe(true);

        // Clear and add a custom group
        cache.clear();
        cache.save({
            name: "Custom",
            slug: "custom",
            displayType: "text",
            options: ["A", "B"],
            createdAt: new Date().toISOString(),
            source: "ai-generated",
        });

        // Second call should NOT seed (cache not empty)
        cache.ensureDefaults();
        expect(cache.has("Custom")).toBe(true);
        expect(cache.has("Color")).toBe(false); // Not seeded because cache wasn't empty
    });

    test("seedGroups() allows seeding custom groups", () => {
        const cache = new PropertyCache(tempDir);

        const customGroups: CachedPropertyGroup[] = [
            {
                name: "Custom Group",
                slug: "custom-group",
                displayType: "text",
                options: ["X", "Y", "Z"],
                createdAt: new Date().toISOString(),
                source: "fixture",
            },
        ];

        cache.seedGroups(customGroups);

        expect(cache.has("Custom Group")).toBe(true);
        expect(cache.get("Custom Group")?.options).toEqual(["X", "Y", "Z"]);
    });

    test("isEmpty() returns true for empty cache", () => {
        const cache = new PropertyCache(tempDir);
        expect(cache.isEmpty()).toBe(true);
    });

    test("isEmpty() returns false after seeding", () => {
        const cache = new PropertyCache(tempDir);
        cache.seedDefaults();
        expect(cache.isEmpty()).toBe(false);
    });
});
