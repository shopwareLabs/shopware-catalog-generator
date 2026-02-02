/**
 * Template Fetcher - Downloads pre-generated catalog templates from GitHub
 *
 * Uses git sparse checkout to only download the specific sales channel
 * and properties folder needed, rather than the entire repository.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { DataCache } from "../cache.js";

/** Default template repository URL */
const DEFAULT_TEMPLATE_REPO_URL = "git@github.com:shopwareLabs/shopware-catalog-templates.git";

/** Default directory for cloning the template repository */
const DEFAULT_TEMPLATE_CACHE_DIR = ".template-repo";

/** Configuration options for TemplateFetcher */
export interface TemplateFetcherOptions {
    /** Repository URL (SSH or HTTPS) */
    repoUrl?: string;

    /** Local directory to clone the repository to */
    cacheDir?: string;

    /** Whether to automatically update the repository on each check */
    autoUpdate?: boolean;
}

/**
 * Fetches and manages pre-generated catalog templates from the GitHub repository
 * using sparse checkout to only download specific sales channels.
 */
export class TemplateFetcher {
    private readonly repoUrl: string;
    private readonly cacheDir: string;
    private readonly autoUpdate: boolean;
    private repoInitialized = false;

    constructor(options: TemplateFetcherOptions = {}) {
        this.repoUrl =
            options.repoUrl || process.env.TEMPLATE_REPO_URL || DEFAULT_TEMPLATE_REPO_URL;
        this.cacheDir = path.resolve(
            options.cacheDir || process.env.TEMPLATE_CACHE_DIR || DEFAULT_TEMPLATE_CACHE_DIR
        );
        this.autoUpdate = options.autoUpdate ?? true;
    }

    /**
     * Get the path to the sales-channels directory in the template repo
     */
    private getSalesChannelsDir(): string {
        return path.join(this.cacheDir, "generated", "sales-channels");
    }

    /**
     * Get the path to a specific template
     */
    private getTemplatePath(name: string): string {
        return path.join(this.getSalesChannelsDir(), name);
    }

    /**
     * Check if the repository is already initialized (sparse checkout)
     */
    private isRepoInitialized(): boolean {
        const gitDir = path.join(this.cacheDir, ".git");
        return fs.existsSync(gitDir);
    }

    /**
     * Check if a specific template is already checked out
     */
    private isTemplateCheckedOut(name: string): boolean {
        const templatePath = this.getTemplatePath(name);
        const hydratedBlueprintPath = path.join(templatePath, "hydrated-blueprint.json");
        return fs.existsSync(hydratedBlueprintPath);
    }

    /**
     * Initialize the repository with sparse checkout (downloads minimal metadata only)
     */
    private initRepo(): boolean {
        try {
            console.log(`Initializing template repository from ${this.repoUrl}...`);

            // Create directory if it doesn't exist
            if (!fs.existsSync(this.cacheDir)) {
                fs.mkdirSync(this.cacheDir, { recursive: true });
            }

            // Clone with sparse checkout - only downloads git metadata, not files
            execSync(
                `git clone --filter=blob:none --sparse --depth 1 --progress "${this.repoUrl}" "${this.cacheDir}"`,
                {
                    stdio: "inherit",
                    timeout: 120000, // 2 minutes for metadata only
                }
            );

            console.log(`Template repository initialized (sparse checkout)`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`Failed to initialize template repository: ${message}`);
            console.warn(`Repository URL: ${this.repoUrl}`);
            console.warn(`Target directory: ${this.cacheDir}`);
            return false;
        }
    }

    /**
     * Fetch a specific template using sparse checkout
     */
    private fetchTemplate(name: string): boolean {
        try {
            console.log(`Fetching template "${name}" and properties...`);

            // Add the specific sales channel and properties folder to sparse checkout
            // Repository structure: generated/sales-channels/<name> and generated/properties
            execSync(
                `git sparse-checkout add generated/sales-channels/${name} generated/properties`,
                {
                    cwd: this.cacheDir,
                    stdio: "inherit",
                    timeout: 300000, // 5 minutes for the actual files
                }
            );

            // Verify the template actually exists (sparse-checkout add doesn't fail for missing paths)
            const templatePath = this.getTemplatePath(name);
            const hydratedBlueprintPath = path.join(templatePath, "hydrated-blueprint.json");

            if (!fs.existsSync(hydratedBlueprintPath)) {
                console.log(`Template "${name}" does not exist in the repository`);
                return false;
            }

            console.log(`Template "${name}" fetched successfully`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`Failed to fetch template "${name}": ${message}`);
            return false;
        }
    }

    /**
     * Update the repository with latest changes
     */
    private updateRepo(): boolean {
        try {
            console.log(`Updating template repository...`);
            execSync("git pull --ff-only", {
                cwd: this.cacheDir,
                stdio: "inherit",
                timeout: 300000, // 5 minutes for updates
            });
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`Failed to update template repository: ${message}`);
            return false;
        }
    }

    /**
     * Ensure the template repository is initialized
     * @returns true if repository is ready, false if unavailable
     */
    private ensureRepoInitialized(): boolean {
        if (this.repoInitialized) {
            return true;
        }

        if (this.isRepoInitialized()) {
            if (this.autoUpdate) {
                this.updateRepo();
            }
            this.repoInitialized = true;
            return true;
        }

        const initialized = this.initRepo();
        if (initialized) {
            this.repoInitialized = true;
        }
        return initialized;
    }

    /**
     * Ensure a specific template is available (fetched via sparse checkout)
     * @param name - The sales channel name
     * @returns true if template is available
     */
    async ensureTemplate(name: string): Promise<boolean> {
        // First, ensure the repository is initialized
        if (!this.ensureRepoInitialized()) {
            return false;
        }

        // If template is already checked out, we're done
        if (this.isTemplateCheckedOut(name)) {
            console.log(`Template "${name}" already available`);
            return true;
        }

        // Fetch the specific template
        return this.fetchTemplate(name);
    }

    /**
     * List all available template names
     * Note: With sparse checkout, this only lists already-fetched templates
     * @returns Array of template names (sales channel names)
     */
    listTemplates(): string[] {
        const salesChannelsDir = this.getSalesChannelsDir();

        if (!fs.existsSync(salesChannelsDir)) {
            return [];
        }

        return fs.readdirSync(salesChannelsDir).filter((name) => {
            const templatePath = path.join(salesChannelsDir, name);
            const isDir = fs.statSync(templatePath).isDirectory();
            const hasBlueprint = fs.existsSync(path.join(templatePath, "hydrated-blueprint.json"));
            return isDir && hasBlueprint;
        });
    }

    /**
     * Check if a specific template exists locally (already fetched)
     * @param name - The sales channel name to check
     * @returns true if template exists locally
     */
    hasTemplate(name: string): boolean {
        return this.isTemplateCheckedOut(name);
    }

    /**
     * Copy a template to the local cache
     * @param name - The sales channel name
     * @param cache - The DataCache instance to copy to
     * @returns true if copy was successful
     */
    copyToCache(name: string, cache: DataCache): boolean {
        const templatePath = this.getTemplatePath(name);

        if (!fs.existsSync(templatePath)) {
            console.error(`Template "${name}" not found`);
            return false;
        }

        try {
            cache.copyFromTemplate(name, templatePath);
            console.log(`✓ Copied template "${name}" to local cache`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Failed to copy template "${name}": ${message}`);
            return false;
        }
    }

    /**
     * Copy the properties folder to the cache
     * @param cache - The DataCache instance to copy to
     * @returns true if copy was successful
     */
    copyPropertiesToCache(cache: DataCache): boolean {
        const propertiesPath = path.join(this.cacheDir, "generated", "properties");

        if (!fs.existsSync(propertiesPath)) {
            console.log(`No properties folder in template repository`);
            return false;
        }

        try {
            // Target: generated/properties (same level as sales-channels)
            const targetPath = path.join(cache.getCacheDir(), "properties");
            fs.cpSync(propertiesPath, targetPath, { recursive: true });
            console.log(`✓ Copied properties to local cache`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Failed to copy properties: ${message}`);
            return false;
        }
    }

    /**
     * Try to use a template for the given sales channel
     * This fetches only the specific template (sparse checkout) and copies it to cache
     *
     * @param name - The sales channel name
     * @param cache - The DataCache instance
     * @returns true if template was successfully applied, false otherwise
     */
    async tryUseTemplate(name: string, cache: DataCache): Promise<boolean> {
        // Fetch the specific template (sparse checkout)
        // This also validates the template exists in the repository
        const templateReady = await this.ensureTemplate(name);
        if (!templateReady) {
            return false;
        }

        // Copy template to cache
        const copied = this.copyToCache(name, cache);

        // Also copy properties if available
        if (copied) {
            this.copyPropertiesToCache(cache);
        }

        return copied;
    }
}

/**
 * Create a TemplateFetcher instance from environment variables
 */
export function createTemplateFetcherFromEnv(): TemplateFetcher {
    return new TemplateFetcher({
        repoUrl: process.env.TEMPLATE_REPO_URL,
        cacheDir: process.env.TEMPLATE_CACHE_DIR,
        autoUpdate: process.env.TEMPLATE_AUTO_UPDATE !== "false",
    });
}
