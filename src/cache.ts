import fs from "node:fs";
import path from "node:path";

import type {
    Blueprint,
    CacheOptions,
    CategoryNode,
    CategoryTreeCache,
    HydratedBlueprint,
    ImageCacheMetadata,
    Manufacturer,
    ProductCacheMetadata,
    ProductInput,
    ProductMetadata,
    PropertyGroup,
    PropertyOption,
    SalesChannelCacheMetadata,
} from "./types/index.js";
import { DEFAULT_CACHE_OPTIONS } from "./types/index.js";

// Re-export types for convenience
export type { CacheOptions, PropertyGroup, PropertyOption } from "./types/index.js";
export { DEFAULT_CACHE_OPTIONS } from "./types/index.js";

/**
 * Data cache for storing generated products and images locally
 */
export class DataCache {
    private readonly cacheDir: string;
    private readonly trashDir: string;
    private readonly options: CacheOptions;

    constructor(options: Partial<CacheOptions> = {}) {
        this.options = { ...DEFAULT_CACHE_OPTIONS, ...options };
        this.cacheDir = path.resolve(this.options.cacheDir);
        this.trashDir = path.resolve(this.options.cacheDir, "..", ".trash");

        if (this.options.enabled) {
            this.ensureDir(this.cacheDir);
        }
    }

    /**
     * Get the trash directory path
     */
    getTrashDir(): string {
        return this.trashDir;
    }

    /** Check if caching is enabled */
    get isEnabled(): boolean {
        return this.options.enabled;
    }

    /** Check if we should use cached data */
    get shouldUseCache(): boolean {
        return this.options.enabled && this.options.useCache;
    }

    /** Check if we should save to cache */
    get shouldSaveToCache(): boolean {
        return this.options.enabled && this.options.saveToCache;
    }

    /**
     * Clear all cached data
     */
    /**
     * Move all cached data to trash (recoverable)
     */
    clearAll(): void {
        if (fs.existsSync(this.cacheDir)) {
            this.moveToTrash(this.cacheDir, "all-cache");
            console.log("🗑️  Moved all cached data to trash");
            console.log(`   Trash location: ${this.trashDir}`);
            console.log("   To permanently delete: rm -rf .trash/");
        } else {
            console.log("No cache found");
        }
    }

    /**
     * Move a directory to trash with timestamp
     */
    private moveToTrash(sourcePath: string, name: string): void {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const trashName = `${name}-${timestamp}`;
        const trashPath = path.join(this.trashDir, trashName);

        this.ensureDir(this.trashDir);

        // Copy to trash, then remove original
        fs.cpSync(sourcePath, trashPath, { recursive: true });
        fs.rmSync(sourcePath, { recursive: true });
    }

    /**
     * List contents of trash folder
     */
    listTrash(): string[] {
        if (!fs.existsSync(this.trashDir)) {
            return [];
        }
        return fs.readdirSync(this.trashDir);
    }

    /**
     * Restore a specific item from trash
     */
    restoreFromTrash(trashItemName: string, targetPath: string): boolean {
        const trashPath = path.join(this.trashDir, trashItemName);
        if (!fs.existsSync(trashPath)) {
            console.log(`Trash item not found: ${trashItemName}`);
            return false;
        }

        if (fs.existsSync(targetPath)) {
            console.log(`Target already exists: ${targetPath}`);
            return false;
        }

        fs.cpSync(trashPath, targetPath, { recursive: true });
        console.log(`Restored ${trashItemName} to ${targetPath}`);
        return true;
    }

    /**
     * Permanently empty the trash (manual operation only)
     */
    emptyTrash(): void {
        if (fs.existsSync(this.trashDir)) {
            fs.rmSync(this.trashDir, { recursive: true });
            console.log("🗑️  Permanently deleted all trash");
        } else {
            console.log("Trash is empty");
        }
    }

    // =========================================================================
    // SalesChannel-Scoped Cache Operations (v2)
    // =========================================================================

    /**
     * Get the base directory for a SalesChannel
     */
    getSalesChannelDir(salesChannel: string): string {
        return path.join(this.cacheDir, "sales-channels", this.sanitizeName(salesChannel));
    }

    /**
     * Save SalesChannel metadata
     */
    saveSalesChannelMetadata(salesChannel: string, description: string, shopwareId?: string): void {
        if (!this.shouldSaveToCache) return;

        const scDir = this.getSalesChannelDir(salesChannel);
        this.ensureDir(scDir);

        const metadata: SalesChannelCacheMetadata = {
            name: salesChannel,
            description,
            createdAt: new Date().toISOString(),
            shopwareId,
        };

        fs.writeFileSync(path.join(scDir, "metadata.json"), JSON.stringify(metadata, null, 2));
    }

    /**
     * Load SalesChannel metadata
     */
    loadSalesChannelMetadata(salesChannel: string): SalesChannelCacheMetadata | null {
        if (!this.shouldUseCache) return null;

        const metadataFile = path.join(this.getSalesChannelDir(salesChannel), "metadata.json");

        if (!fs.existsSync(metadataFile)) {
            return null;
        }

        try {
            const data = fs.readFileSync(metadataFile, "utf-8");
            return JSON.parse(data) as SalesChannelCacheMetadata;
        } catch {
            return null;
        }
    }

    /**
     * Save category tree for a SalesChannel
     */
    saveCategoryTree(
        salesChannel: string,
        tree: CategoryNode[],
        totalProducts: number,
        textModel?: string
    ): void {
        if (!this.shouldSaveToCache) return;

        const scDir = this.getSalesChannelDir(salesChannel);
        this.ensureDir(scDir);

        const cache: CategoryTreeCache = {
            salesChannel,
            generatedAt: new Date().toISOString(),
            tree,
            totalProducts,
            textModel,
        };

        fs.writeFileSync(path.join(scDir, "categories.json"), JSON.stringify(cache, null, 2));
    }

    /**
     * Load category tree for a SalesChannel
     */
    loadCategoryTree(salesChannel: string): CategoryTreeCache | null {
        if (!this.shouldUseCache) return null;

        const categoriesFile = path.join(this.getSalesChannelDir(salesChannel), "categories.json");

        if (!fs.existsSync(categoriesFile)) {
            return null;
        }

        try {
            const data = fs.readFileSync(categoriesFile, "utf-8");
            const cache = JSON.parse(data) as CategoryTreeCache;
            return cache;
        } catch {
            return null;
        }
    }

    /**
     * Check if a category tree is cached for a SalesChannel
     */
    hasCategoryTree(salesChannel: string): boolean {
        if (!this.shouldUseCache) return false;
        const categoriesFile = path.join(this.getSalesChannelDir(salesChannel), "categories.json");
        return fs.existsSync(categoriesFile);
    }

    // =========================================================================
    // Blueprint Cache Operations (v2)
    // =========================================================================

    /**
     * Save a blueprint (pre-AI) for a SalesChannel
     */
    saveBlueprint(salesChannel: string, blueprint: Blueprint): void {
        if (!this.shouldSaveToCache) return;

        const scDir = this.getSalesChannelDir(salesChannel);
        this.ensureDir(scDir);

        fs.writeFileSync(path.join(scDir, "blueprint.json"), JSON.stringify(blueprint, null, 2));
    }

    /**
     * Load a blueprint (pre-AI) for a SalesChannel
     */
    loadBlueprint(salesChannel: string): Blueprint | null {
        if (!this.shouldUseCache) return null;

        const blueprintFile = path.join(this.getSalesChannelDir(salesChannel), "blueprint.json");

        if (!fs.existsSync(blueprintFile)) {
            return null;
        }

        try {
            const data = fs.readFileSync(blueprintFile, "utf-8");
            return JSON.parse(data) as Blueprint;
        } catch {
            return null;
        }
    }

    /**
     * Check if a blueprint exists for a SalesChannel
     */
    hasBlueprint(salesChannel: string): boolean {
        if (!this.shouldUseCache) return false;
        const blueprintFile = path.join(this.getSalesChannelDir(salesChannel), "blueprint.json");
        return fs.existsSync(blueprintFile);
    }

    /**
     * Save a hydrated blueprint (post-AI) for a SalesChannel
     */
    saveHydratedBlueprint(salesChannel: string, blueprint: HydratedBlueprint): void {
        if (!this.shouldSaveToCache) return;

        const scDir = this.getSalesChannelDir(salesChannel);
        this.ensureDir(scDir);

        fs.writeFileSync(
            path.join(scDir, "hydrated-blueprint.json"),
            JSON.stringify(blueprint, null, 2)
        );

        // Also save individual product metadata for easy access by post-processors
        this.ensureDir(path.join(scDir, "metadata"));
        for (const product of blueprint.products) {
            this.saveProductMetadata(salesChannel, product.id, product.metadata);
        }
    }

    /**
     * Load a hydrated blueprint (post-AI) for a SalesChannel
     */
    loadHydratedBlueprint(salesChannel: string): HydratedBlueprint | null {
        if (!this.shouldUseCache) return null;

        const hydratedFile = path.join(
            this.getSalesChannelDir(salesChannel),
            "hydrated-blueprint.json"
        );

        if (!fs.existsSync(hydratedFile)) {
            return null;
        }

        try {
            const data = fs.readFileSync(hydratedFile, "utf-8");
            return JSON.parse(data) as HydratedBlueprint;
        } catch {
            return null;
        }
    }

    /**
     * Check if a hydrated blueprint exists for a SalesChannel
     */
    hasHydratedBlueprint(salesChannel: string): boolean {
        if (!this.shouldUseCache) return false;
        const hydratedFile = path.join(
            this.getSalesChannelDir(salesChannel),
            "hydrated-blueprint.json"
        );
        return fs.existsSync(hydratedFile);
    }

    /**
     * Save product metadata for a specific product (keyed by UUID)
     */
    saveProductMetadata(salesChannel: string, productId: string, metadata: ProductMetadata): void {
        if (!this.shouldSaveToCache) return;

        const metadataDir = path.join(this.getSalesChannelDir(salesChannel), "metadata");
        this.ensureDir(metadataDir);

        const metadataFile = path.join(metadataDir, `${productId}.json`);
        fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));
    }

    /**
     * Load product metadata for a specific product (keyed by UUID)
     */
    loadProductMetadata(salesChannel: string, productId: string): ProductMetadata | null {
        if (!this.shouldUseCache) return null;

        const metadataFile = path.join(
            this.getSalesChannelDir(salesChannel),
            "metadata",
            `${productId}.json`
        );

        if (!fs.existsSync(metadataFile)) {
            return null;
        }

        try {
            const data = fs.readFileSync(metadataFile, "utf-8");
            return JSON.parse(data) as ProductMetadata;
        } catch {
            return null;
        }
    }

    /**
     * Load all product metadata for a SalesChannel
     */
    loadAllProductMetadata(salesChannel: string): Map<string, ProductMetadata> {
        const result = new Map<string, ProductMetadata>();
        if (!this.shouldUseCache) return result;

        const metadataDir = path.join(this.getSalesChannelDir(salesChannel), "metadata");

        if (!fs.existsSync(metadataDir)) {
            return result;
        }

        const files = fs.readdirSync(metadataDir).filter((f) => f.endsWith(".json"));

        for (const file of files) {
            try {
                const productId = file.replace(".json", "");
                const data = fs.readFileSync(path.join(metadataDir, file), "utf-8");
                result.set(productId, JSON.parse(data) as ProductMetadata);
            } catch {
                // Skip invalid files
            }
        }

        return result;
    }

    /**
     * Save manufacturers for a SalesChannel
     */
    saveManufacturers(salesChannel: string, manufacturers: Manufacturer[]): void {
        if (!this.shouldSaveToCache) return;

        const scDir = this.getSalesChannelDir(salesChannel);
        this.ensureDir(scDir);

        fs.writeFileSync(
            path.join(scDir, "manufacturers.json"),
            JSON.stringify(manufacturers, null, 2)
        );
    }

    /**
     * Load manufacturers for a SalesChannel
     */
    loadManufacturers(salesChannel: string): Manufacturer[] | null {
        if (!this.shouldUseCache) return null;

        const manufacturersFile = path.join(
            this.getSalesChannelDir(salesChannel),
            "manufacturers.json"
        );

        if (!fs.existsSync(manufacturersFile)) {
            return null;
        }

        try {
            const data = fs.readFileSync(manufacturersFile, "utf-8");
            return JSON.parse(data) as Manufacturer[];
        } catch {
            return null;
        }
    }

    /**
     * Save image for a product with view type (e.g., "front", "lifestyle")
     */
    saveImageWithView(
        salesChannel: string,
        productId: string,
        view: string,
        base64Data: string,
        prompt: string,
        imageModel?: string
    ): void {
        if (!this.shouldSaveToCache) return;

        const imagesDir = this.getSalesChannelImagesDir(salesChannel);
        this.ensureDir(imagesDir);

        const imagePath = path.join(imagesDir, `${productId}-${view}.webp`);
        const metadataPath = path.join(imagesDir, `${productId}-${view}.json`);

        try {
            const imageBuffer = Buffer.from(base64Data, "base64");
            fs.writeFileSync(imagePath, imageBuffer);

            const metadata: ImageCacheMetadata = {
                productId,
                productName: view, // Use view as identifier
                prompt,
                generatedAt: new Date().toISOString(),
                imageModel,
            };
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        } catch {
            // Silently fail
        }
    }

    /**
     * Check if an image with a specific view is cached
     */
    hasImageWithView(salesChannel: string, productId: string, view: string): boolean {
        if (!this.shouldUseCache) return false;
        const imagePath = path.join(
            this.getSalesChannelImagesDir(salesChannel),
            `${productId}-${view}.webp`
        );
        return fs.existsSync(imagePath);
    }

    /**
     * Load image with a specific view
     */
    loadImageWithView(salesChannel: string, productId: string, view: string): string | null {
        if (!this.shouldUseCache) return null;

        const imagePath = path.join(
            this.getSalesChannelImagesDir(salesChannel),
            `${productId}-${view}.webp`
        );

        if (!fs.existsSync(imagePath)) {
            return null;
        }

        try {
            const imageBuffer = fs.readFileSync(imagePath);
            return imageBuffer.toString("base64");
        } catch {
            return null;
        }
    }

    /**
     * Save products for a specific category within a SalesChannel
     */
    saveProductsForSalesChannel(
        salesChannel: string,
        category: string,
        products: ProductInput[],
        textModel?: string
    ): void {
        if (!this.shouldSaveToCache) return;

        const productsDir = path.join(
            this.getSalesChannelDir(salesChannel),
            "products",
            this.sanitizeName(category)
        );
        this.ensureDir(productsDir);

        const productsFile = path.join(productsDir, "products.json");

        // Load existing and merge
        let existingProducts: ProductInput[] = [];
        if (fs.existsSync(productsFile)) {
            try {
                existingProducts = JSON.parse(
                    fs.readFileSync(productsFile, "utf-8")
                ) as ProductInput[];
            } catch {
                // Ignore
            }
        }

        const existingNames = new Set(existingProducts.map((p) => p.name));
        const newProducts = products.filter((p) => !existingNames.has(p.name));
        const allProducts = [...existingProducts, ...newProducts];

        fs.writeFileSync(productsFile, JSON.stringify(allProducts, null, 2));

        // Save metadata
        const metadata: ProductCacheMetadata = {
            category,
            generatedAt: new Date().toISOString(),
            count: allProducts.length,
            textModel,
        };
        fs.writeFileSync(
            path.join(productsDir, "metadata.json"),
            JSON.stringify(metadata, null, 2)
        );
    }

    /**
     * Load products for a specific category within a SalesChannel
     */
    loadProductsForSalesChannel(salesChannel: string, category: string): ProductInput[] {
        if (!this.shouldUseCache) return [];

        const productsFile = path.join(
            this.getSalesChannelDir(salesChannel),
            "products",
            this.sanitizeName(category),
            "products.json"
        );

        if (!fs.existsSync(productsFile)) {
            return [];
        }

        try {
            const data = fs.readFileSync(productsFile, "utf-8");
            return JSON.parse(data) as ProductInput[];
        } catch {
            return [];
        }
    }

    // =========================================================================
    // SalesChannel-Scoped Image Cache Operations
    // =========================================================================

    /**
     * Get image directory for a SalesChannel
     */
    private getSalesChannelImagesDir(salesChannel: string): string {
        return path.join(this.getSalesChannelDir(salesChannel), "images");
    }

    /**
     * Get image path for a product within a SalesChannel
     */
    private getSalesChannelImagePath(salesChannel: string, productId: string): string {
        return path.join(this.getSalesChannelImagesDir(salesChannel), `${productId}.webp`);
    }

    /**
     * Get image metadata path for a product within a SalesChannel
     */
    private getSalesChannelImageMetadataPath(salesChannel: string, productId: string): string {
        return path.join(this.getSalesChannelImagesDir(salesChannel), `${productId}.json`);
    }

    /**
     * Check if an image is cached for a product within a SalesChannel
     */
    hasImageForSalesChannel(salesChannel: string, productId: string): boolean {
        if (!this.shouldUseCache) return false;
        const imagePath = this.getSalesChannelImagePath(salesChannel, productId);
        return fs.existsSync(imagePath);
    }

    /**
     * Load cached image for a product within a SalesChannel
     * @returns Base64-encoded image data, or null if not cached
     */
    loadImageForSalesChannel(salesChannel: string, productId: string): string | null {
        if (!this.shouldUseCache) return null;

        const imagePath = this.getSalesChannelImagePath(salesChannel, productId);

        if (!fs.existsSync(imagePath)) {
            return null;
        }

        try {
            const imageBuffer = fs.readFileSync(imagePath);
            const base64 = imageBuffer.toString("base64");
            return base64;
        } catch {
            return null;
        }
    }

    /**
     * Save image to cache within a SalesChannel
     */
    saveImageForSalesChannel(
        salesChannel: string,
        productId: string,
        productName: string,
        base64Data: string,
        prompt: string,
        imageModel?: string
    ): void {
        if (!this.shouldSaveToCache) return;

        const imagesDir = this.getSalesChannelImagesDir(salesChannel);
        this.ensureDir(imagesDir);

        const imagePath = this.getSalesChannelImagePath(salesChannel, productId);
        const metadataPath = this.getSalesChannelImageMetadataPath(salesChannel, productId);

        try {
            // Decode base64 and save as WebP
            const imageBuffer = Buffer.from(base64Data, "base64");
            fs.writeFileSync(imagePath, imageBuffer);

            // Save metadata
            const metadata: ImageCacheMetadata = {
                productId,
                productName,
                prompt,
                generatedAt: new Date().toISOString(),
                imageModel,
            };
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        } catch {
            // Silently fail - caching is not critical
        }
    }

    /**
     * Get the number of cached images for a SalesChannel
     */
    getImageCountForSalesChannel(salesChannel: string): number {
        const imagesDir = this.getSalesChannelImagesDir(salesChannel);

        if (!fs.existsSync(imagesDir)) {
            return 0;
        }

        const files = fs.readdirSync(imagesDir);
        return files.filter((f) => f.endsWith(".webp")).length;
    }

    /**
     * Save property groups for a SalesChannel
     */
    savePropertyGroupsForSalesChannel(
        salesChannel: string,
        groups: PropertyGroup[],
        textModel?: string
    ): void {
        if (!this.shouldSaveToCache) return;

        const scDir = this.getSalesChannelDir(salesChannel);
        this.ensureDir(scDir);

        const propertyGroupsFile = path.join(scDir, "property-groups.json");

        // Load existing groups and merge
        let existingGroups: PropertyGroup[] = [];
        if (fs.existsSync(propertyGroupsFile)) {
            try {
                existingGroups = JSON.parse(
                    fs.readFileSync(propertyGroupsFile, "utf-8")
                ) as PropertyGroup[];
            } catch {
                // Ignore
            }
        }

        const mergedGroups = this.mergePropertyGroups(existingGroups, groups);
        fs.writeFileSync(propertyGroupsFile, JSON.stringify(mergedGroups, null, 2));

        // Save metadata
        const metadata = {
            salesChannel,
            generatedAt: new Date().toISOString(),
            count: mergedGroups.length,
            textModel,
        };
        fs.writeFileSync(
            path.join(scDir, "property-groups-metadata.json"),
            JSON.stringify(metadata, null, 2)
        );
    }

    /**
     * Load property groups for a SalesChannel
     */
    loadPropertyGroupsForSalesChannel(salesChannel: string): PropertyGroup[] | null {
        if (!this.shouldUseCache) return null;

        const propertyGroupsFile = path.join(
            this.getSalesChannelDir(salesChannel),
            "property-groups.json"
        );

        if (!fs.existsSync(propertyGroupsFile)) {
            return null;
        }

        try {
            const data = fs.readFileSync(propertyGroupsFile, "utf-8");
            const groups = JSON.parse(data) as PropertyGroup[];
            return groups;
        } catch {
            return null;
        }
    }

    /**
     * Check if property groups are cached for a SalesChannel
     */
    hasPropertyGroupsForSalesChannel(salesChannel: string): boolean {
        if (!this.shouldUseCache) return false;
        const propertyGroupsFile = path.join(
            this.getSalesChannelDir(salesChannel),
            "property-groups.json"
        );
        return fs.existsSync(propertyGroupsFile);
    }

    /**
     * List all cached SalesChannels
     */
    listSalesChannels(): string[] {
        const salesChannelsDir = path.join(this.cacheDir, "sales-channels");

        if (!fs.existsSync(salesChannelsDir)) {
            return [];
        }

        return fs.readdirSync(salesChannelsDir).filter((f) => {
            const fullPath = path.join(salesChannelsDir, f);
            return fs.statSync(fullPath).isDirectory();
        });
    }

    /**
     * Clear cache for a specific SalesChannel
     */
    /**
     * Move SalesChannel cache to trash (recoverable)
     */
    clearSalesChannel(salesChannel: string): void {
        const scDir = this.getSalesChannelDir(salesChannel);

        if (fs.existsSync(scDir)) {
            this.moveToTrash(scDir, `sales-channel-${salesChannel}`);
            console.log(`Moved cache for SalesChannel "${salesChannel}" to trash`);
            console.log(`   Trash location: ${this.trashDir}`);
            console.log("   To permanently delete: rm -rf .trash/");
        } else {
            console.log(`No cache found for SalesChannel "${salesChannel}"`);
        }
    }

    /**
     * Save property options metadata for a category (for future remapping)
     * Stores id->name mapping alongside products
     */
    savePropertyOptionsForCategory(
        salesChannel: string,
        category: string,
        propertyGroups: PropertyGroup[]
    ): void {
        if (!this.shouldSaveToCache) return;

        const productsDir = path.join(
            this.getSalesChannelDir(salesChannel),
            "products",
            this.sanitizeName(category)
        );
        this.ensureDir(productsDir);

        // Build a flat list of all options with their group context
        const options: Array<{
            id: string;
            name: string;
            groupId: string;
            groupName: string;
        }> = [];

        for (const group of propertyGroups) {
            for (const option of group.options) {
                if (option.id && option.name) {
                    options.push({
                        id: option.id,
                        name: option.name,
                        groupId: group.id || "",
                        groupName: group.name,
                    });
                }
            }
        }

        const optionsFile = path.join(productsDir, "property-options.json");
        fs.writeFileSync(
            optionsFile,
            JSON.stringify(
                {
                    generatedAt: new Date().toISOString(),
                    options,
                },
                null,
                2
            )
        );
    }

    // =========================================================================
    // Private Helpers
    // =========================================================================

    /**
     * Merge new property groups with existing ones
     * - Groups with same name: merge options
     * - New groups: add to list
     */
    private mergePropertyGroups(
        existing: PropertyGroup[],
        newGroups: PropertyGroup[]
    ): PropertyGroup[] {
        const merged = [...existing];
        const existingByName = new Map(existing.map((g, idx) => [g.name.toLowerCase(), idx]));

        for (const newGroup of newGroups) {
            const existingIdx = existingByName.get(newGroup.name.toLowerCase());

            if (existingIdx !== undefined && merged[existingIdx]) {
                // Merge options into existing group
                const existingGroup = merged[existingIdx];
                const mergedOptions = this.mergePropertyOptions(
                    existingGroup.options,
                    newGroup.options
                );
                merged[existingIdx] = {
                    id: existingGroup.id,
                    name: existingGroup.name,
                    description: existingGroup.description,
                    displayType: existingGroup.displayType,
                    options: mergedOptions,
                };
            } else {
                // Add new group
                merged.push(newGroup);
                existingByName.set(newGroup.name.toLowerCase(), merged.length - 1);
            }
        }

        return merged;
    }

    /**
     * Merge property options, avoiding duplicates by name
     */
    private mergePropertyOptions(
        existing: PropertyOption[],
        newOptions: PropertyOption[]
    ): PropertyOption[] {
        const merged = [...existing];
        const existingNames = new Set(existing.map((o) => o.name.toLowerCase()));

        for (const option of newOptions) {
            if (!existingNames.has(option.name.toLowerCase())) {
                merged.push(option);
                existingNames.add(option.name.toLowerCase());
            }
        }

        return merged;
    }

    private sanitizeName(name: string): string {
        // Convert to lowercase, replace spaces with hyphens, remove special chars
        return name
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9-]/g, "");
    }

    private ensureDir(dir: string): void {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}

/**
 * Create a DataCache instance from environment variables
 */
export function createCacheFromEnv(): DataCache {
    const enabled = process.env.CACHE_ENABLED !== "false";
    const cacheDir = process.env.CACHE_DIR || "./generated";

    return new DataCache({
        enabled,
        cacheDir,
        useCache: true,
        saveToCache: true,
    });
}
