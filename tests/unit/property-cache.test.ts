import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    DEFAULT_PROPERTY_GROUPS,
    getAllPropertyGroups,
    getCommonPropertyGroups,
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

describe("Property Group Fixtures", () => {
    test("DEFAULT_PROPERTY_GROUPS contains all default groups", () => {
        expect(DEFAULT_PROPERTY_GROUPS.length).toBeGreaterThan(0);

        const names = DEFAULT_PROPERTY_GROUPS.map((g) => g.name);
        expect(names).toContain("Size");
        expect(names).toContain("Color");
        expect(names).toContain("Material");
        expect(names).toContain("Body Wood");
        expect(names).toContain("Shoe Size");
    });

    test("getCommonPropertyGroups() returns common groups only", () => {
        const commonGroups = getCommonPropertyGroups();

        const names = commonGroups.map((g) => g.name);
        expect(names).toContain("Size");
        expect(names).toContain("Color");
        expect(names).toContain("Material");
        // Should not include domain-specific groups
        expect(names).not.toContain("Body Wood");
        expect(names).not.toContain("Shoe Size");
    });

    test("getAllPropertyGroups() returns all fixture groups", () => {
        const allGroups = getAllPropertyGroups();
        const commonGroups = getCommonPropertyGroups();

        // Should have common + music + fashion groups
        expect(allGroups.length).toBeGreaterThan(commonGroups.length);

        const names = allGroups.map((g) => g.name);
        expect(names).toContain("Size");
        expect(names).toContain("Body Wood");
        expect(names).toContain("Shoe Size");
    });

    test("fixture groups have required fields", () => {
        const allGroups = getAllPropertyGroups();

        for (const group of allGroups) {
            expect(group.name).toBeDefined();
            expect(group.slug).toBeDefined();
            expect(group.displayType).toMatch(/^(text|color)$/);
            expect(group.options.length).toBeGreaterThanOrEqual(2);
            expect(group.source).toBe("fixture");
        }
    });

    test("Color fixture has color displayType", () => {
        const allGroups = getAllPropertyGroups();
        const colorGroup = allGroups.find((g) => g.name === "Color");
        expect(colorGroup?.displayType).toBe("color");
    });

    test("Size fixture has price modifiers", () => {
        const allGroups = getAllPropertyGroups();
        const sizeGroup = allGroups.find((g) => g.name === "Size");
        expect(sizeGroup?.priceModifiers).toBeDefined();
        expect(sizeGroup?.priceModifiers?.XS).toBeLessThan(1);
        expect(sizeGroup?.priceModifiers?.XL).toBeGreaterThan(1);
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

    test("seedDefaults() creates JSON files in cache directory", () => {
        const cache = new PropertyCache(tempDir);
        cache.seedDefaults();

        expect(cache.has("Size")).toBe(true);
        expect(cache.has("Color")).toBe(true);
        expect(cache.has("Guitar Finish")).toBe(true);

        // Check that JSON files were created
        const cacheDir = cache.getCacheDir();
        expect(fs.existsSync(path.join(cacheDir, "size.json"))).toBe(true);
        expect(fs.existsSync(path.join(cacheDir, "color.json"))).toBe(true);
    });

    test("ensureDefaults() seeds only if cache is empty", () => {
        const cache = new PropertyCache(tempDir);

        // First call should seed
        cache.ensureDefaults();
        expect(cache.has("Size")).toBe(true);

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
        expect(cache.has("Size")).toBe(false); // Not seeded because cache wasn't empty
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
