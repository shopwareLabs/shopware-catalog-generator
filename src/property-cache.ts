/**
 * PropertyCache - Global cache for property groups
 *
 * Stores AI-generated property groups for reuse across products and sales channels.
 * This enables consistent property options (e.g., all guitars share the same "Finish" options)
 * while allowing AI to generate new groups for domain-specific properties.
 *
 * Cache location: generated/properties/
 * - Each property group is stored as a separate JSON file (e.g., size.json, color.json)
 * - On first use, default groups from fixtures are seeded into the cache
 * - AI-generated groups are added alongside defaults
 */

import fs from "node:fs";
import path from "node:path";

import { DEFAULT_PROPERTY_GROUPS } from "./fixtures/property-groups.js";
import type { CachedPropertyGroup, PropertyCacheIndex } from "./types/index.js";
import { toKebabCase } from "./utils/index.js";

/**
 * PropertyCache manages the global property group cache
 */
export class PropertyCache {
    private readonly cacheDir: string;
    private readonly indexPath: string;
    private cache: Map<string, CachedPropertyGroup> = new Map();
    private loaded = false;

    constructor(baseDir = "./generated") {
        this.cacheDir = path.resolve(baseDir, "properties");
        this.indexPath = path.join(this.cacheDir, "index.json");
    }

    /**
     * Ensure the cache directory exists
     */
    private ensureDir(): void {
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    /**
     * Load all cached property groups from disk
     */
    private loadCache(): void {
        if (this.loaded) return;

        if (!fs.existsSync(this.cacheDir)) {
            this.loaded = true;
            return;
        }

        const files = fs.readdirSync(this.cacheDir).filter((f) => f.endsWith(".json") && f !== "index.json");

        for (const file of files) {
            try {
                const filePath = path.join(this.cacheDir, file);
                const data = fs.readFileSync(filePath, "utf-8");
                const group = JSON.parse(data) as CachedPropertyGroup;
                // Normalize the key to lowercase for case-insensitive matching
                this.cache.set(group.name.toLowerCase(), group);
            } catch {
                // Skip invalid files
            }
        }

        this.loaded = true;
    }

    /**
     * Update the index file
     */
    private updateIndex(): void {
        this.ensureDir();

        const index: PropertyCacheIndex = {
            updatedAt: new Date().toISOString(),
            count: this.cache.size,
            groups: Array.from(this.cache.values()).map((g) => g.slug),
        };

        fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
    }

    /**
     * Check if a property group exists in the cache
     *
     * @param groupName - Name of the property group (case-insensitive)
     * @returns true if the group exists
     */
    has(groupName: string): boolean {
        this.loadCache();
        return this.cache.has(groupName.toLowerCase());
    }

    /**
     * Get a property group from the cache
     *
     * @param groupName - Name of the property group (case-insensitive)
     * @returns The cached property group or null if not found
     */
    get(groupName: string): CachedPropertyGroup | null {
        this.loadCache();
        return this.cache.get(groupName.toLowerCase()) ?? null;
    }

    /**
     * Save a property group to the cache
     *
     * @param group - The property group to save
     */
    save(group: CachedPropertyGroup): void {
        this.loadCache();
        this.ensureDir();

        // Ensure slug is set
        const slug = group.slug || toKebabCase(group.name);
        const normalizedGroup: CachedPropertyGroup = {
            ...group,
            slug,
        };

        // Save to disk
        const filePath = path.join(this.cacheDir, `${slug}.json`);
        fs.writeFileSync(filePath, JSON.stringify(normalizedGroup, null, 2));

        // Update in-memory cache
        this.cache.set(normalizedGroup.name.toLowerCase(), normalizedGroup);

        // Update index
        this.updateIndex();
    }

    /**
     * List all cached property groups
     *
     * @returns Array of all cached property groups
     */
    list(): CachedPropertyGroup[] {
        this.loadCache();
        return Array.from(this.cache.values());
    }

    /**
     * Get all group names in the cache
     *
     * @returns Array of group names
     */
    listNames(): string[] {
        this.loadCache();
        return Array.from(this.cache.values()).map((g) => g.name);
    }

    /**
     * Seed the cache with custom property groups
     *
     * @param groups - Array of property groups to seed
     * @param overwrite - If true, overwrite existing groups; if false, skip existing
     */
    seedGroups(groups: CachedPropertyGroup[], overwrite = false): void {
        for (const group of groups) {
            if (overwrite || !this.has(group.name)) {
                this.save(group);
            }
        }
    }

    /**
     * Seed the cache with default property groups from fixtures
     * Creates JSON files in generated/properties/ for each default group
     * Only seeds groups that don't already exist in the cache
     */
    seedDefaults(): void {
        for (const group of DEFAULT_PROPERTY_GROUPS) {
            if (!this.has(group.name)) {
                this.save(group);
            }
        }
    }

    /**
     * Check if the cache is empty (no property groups yet)
     */
    isEmpty(): boolean {
        this.loadCache();
        return this.cache.size === 0;
    }

    /**
     * Ensure defaults are seeded if cache is empty
     * Called automatically on first use
     */
    ensureDefaults(): void {
        if (this.isEmpty()) {
            this.seedDefaults();
        }
    }

    /**
     * Clear all cached property groups
     */
    clear(): void {
        if (fs.existsSync(this.cacheDir)) {
            fs.rmSync(this.cacheDir, { recursive: true });
        }
        this.cache.clear();
        this.loaded = false;
    }

    /**
     * Get the cache directory path
     */
    getCacheDir(): string {
        return this.cacheDir;
    }

    /**
     * Create a new property group (helper for AI-generated groups)
     *
     * @param name - Display name of the property group
     * @param options - Available options for this group
     * @param displayType - Display type ("text" or "color")
     * @param priceModifiers - Optional price modifiers per option
     * @returns The created property group
     */
    createGroup(
        name: string,
        options: string[],
        displayType: "text" | "color" = "text",
        priceModifiers?: Record<string, number>
    ): CachedPropertyGroup {
        const group: CachedPropertyGroup = {
            name,
            slug: toKebabCase(name),
            displayType,
            options,
            priceModifiers,
            createdAt: new Date().toISOString(),
            source: "ai-generated",
        };

        this.save(group);
        return group;
    }

    /**
     * Infer display type from group name
     *
     * @param groupName - Name of the property group
     * @returns "color" if the name suggests a color group, "text" otherwise
     */
    static inferDisplayType(groupName: string): "text" | "color" {
        const colorKeywords = ["color", "colour", "farbe"];
        const nameLower = groupName.toLowerCase();
        return colorKeywords.some((kw) => nameLower.includes(kw)) ? "color" : "text";
    }
}
