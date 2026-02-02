/**
 * PropertyCache - Store-scoped cache for property groups
 *
 * Property groups are stored in two locations:
 * 1. Global: generated/properties/ - Universal properties (Color only)
 * 2. Store-scoped: generated/sales-channels/{storeSlug}/properties/ - Store-specific properties
 *
 * The store-scoped approach ensures:
 * - Beauty stores get properties like "Volume", "Scent", "Skin Type"
 * - Fashion stores get properties like "Size", "Fabric", "Fit"
 * - Furniture stores get properties like "Material", "Dimensions", "Style"
 *
 * Universal properties (Color) are always available from the global cache.
 */

import fs from "node:fs";
import path from "node:path";

import { UNIVERSAL_PROPERTY_GROUPS } from "./fixtures/property-groups.js";
import type { CachedPropertyGroup, PropertyCacheIndex } from "./types/index.js";
import { toKebabCase } from "./utils/index.js";

/**
 * PropertyCache manages property groups with optional store-scoping
 */
export class PropertyCache {
    private readonly cacheDir: string;
    private readonly globalCacheDir: string;
    private readonly indexPath: string;
    private readonly storeSlug: string | null;
    private cache: Map<string, CachedPropertyGroup> = new Map();
    private loaded = false;

    /**
     * Create a PropertyCache instance
     *
     * @param baseDir - Base directory for generated files (default: "./generated")
     * @param storeSlug - Optional store slug for store-scoped properties
     *                    If provided, properties are stored in generated/sales-channels/{storeSlug}/properties/
     *                    If omitted, uses global cache at generated/properties/
     */
    constructor(baseDir = "./generated", storeSlug?: string) {
        this.storeSlug = storeSlug ?? null;
        this.globalCacheDir = path.resolve(baseDir, "properties");

        if (storeSlug) {
            // Store-scoped: generated/sales-channels/{storeSlug}/properties/
            this.cacheDir = path.resolve(baseDir, "sales-channels", storeSlug, "properties");
        } else {
            // Global: generated/properties/
            this.cacheDir = this.globalCacheDir;
        }

        this.indexPath = path.join(this.cacheDir, "index.json");
    }

    /**
     * Check if this cache is store-scoped
     */
    isStoreScoped(): boolean {
        return this.storeSlug !== null;
    }

    /**
     * Get the store slug if store-scoped, null otherwise
     */
    getStoreSlug(): string | null {
        return this.storeSlug;
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
     * Load property groups from a directory
     */
    private loadFromDir(dir: string): void {
        if (!fs.existsSync(dir)) {
            return;
        }

        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");

        for (const file of files) {
            try {
                const filePath = path.join(dir, file);
                const data = fs.readFileSync(filePath, "utf-8");
                const group = JSON.parse(data) as CachedPropertyGroup;
                // Normalize the key to lowercase for case-insensitive matching
                this.cache.set(group.name.toLowerCase(), group);
            } catch {
                // Skip invalid files
            }
        }
    }

    /**
     * Load all cached property groups from disk
     *
     * For store-scoped caches, loads both:
     * 1. Global properties (Color) from generated/properties/
     * 2. Store-specific properties from generated/sales-channels/{store}/properties/
     */
    private loadCache(): void {
        if (this.loaded) return;

        // Always load global properties first (for universal groups like Color)
        if (this.isStoreScoped()) {
            this.loadFromDir(this.globalCacheDir);
        }

        // Load from primary cache directory
        this.loadFromDir(this.cacheDir);

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
     * For store-scoped caches:
     * - Universal groups (Color) are saved to global cache
     * - Store-specific groups are saved to store cache
     *
     * @param group - The property group to save
     */
    save(group: CachedPropertyGroup): void {
        this.loadCache();

        // Ensure slug is set
        const slug = group.slug || toKebabCase(group.name);
        const normalizedGroup: CachedPropertyGroup = {
            ...group,
            slug,
        };

        // Determine where to save
        const isUniversal = this.isUniversalGroup(group.name);
        const targetDir = isUniversal ? this.globalCacheDir : this.cacheDir;

        // Ensure directory exists
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        // Save to disk
        const filePath = path.join(targetDir, `${slug}.json`);
        fs.writeFileSync(filePath, JSON.stringify(normalizedGroup, null, 2));

        // Update in-memory cache
        this.cache.set(normalizedGroup.name.toLowerCase(), normalizedGroup);

        // Update index
        this.updateIndex();
    }

    /**
     * Check if a group name is a universal property (should be stored globally)
     */
    private isUniversalGroup(groupName: string): boolean {
        const universalNames = UNIVERSAL_PROPERTY_GROUPS.map((g) => g.name.toLowerCase());
        return universalNames.includes(groupName.toLowerCase());
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
     * Seed the cache with universal property groups from fixtures
     * Creates JSON files in generated/properties/ for universal groups (Color)
     * Only seeds groups that don't already exist in the cache
     */
    seedDefaults(): void {
        for (const group of UNIVERSAL_PROPERTY_GROUPS) {
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
     *
     * For store-scoped caches, only clears store-specific properties (not global)
     */
    clear(): void {
        if (fs.existsSync(this.cacheDir)) {
            fs.rmSync(this.cacheDir, { recursive: true });
        }
        this.cache.clear();
        this.loaded = false;
    }

    /**
     * Clear all cached property groups including global
     */
    clearAll(): void {
        if (fs.existsSync(this.cacheDir)) {
            fs.rmSync(this.cacheDir, { recursive: true });
        }
        if (this.isStoreScoped() && fs.existsSync(this.globalCacheDir)) {
            fs.rmSync(this.globalCacheDir, { recursive: true });
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
     * Get the global cache directory path
     */
    getGlobalCacheDir(): string {
        return this.globalCacheDir;
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

    /**
     * Create a store-scoped PropertyCache from an existing global cache
     *
     * @param baseDir - Base directory for generated files
     * @param storeSlug - Store slug for the new cache
     * @returns A new store-scoped PropertyCache instance
     */
    static forStore(baseDir: string, storeSlug: string): PropertyCache {
        return new PropertyCache(baseDir, storeSlug);
    }

    /**
     * Create a global PropertyCache (for universal properties only)
     *
     * @param baseDir - Base directory for generated files
     * @returns A new global PropertyCache instance
     */
    static global(baseDir = "./generated"): PropertyCache {
        return new PropertyCache(baseDir);
    }
}
