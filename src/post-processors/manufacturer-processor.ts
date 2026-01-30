/**
 * Manufacturer Processor - Creates manufacturers and assigns to products
 *
 * 1. Collects unique manufacturer names from products
 * 2. Generates manufacturer descriptions via AI
 * 3. Creates manufacturers in Shopware
 * 4. Assigns manufacturers to products
 */

import { logger } from "../utils/index.js";

import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

/**
 * Manufacturer Processor implementation
 */
class ManufacturerProcessorImpl implements PostProcessor {
    readonly name = "manufacturers";
    readonly description = "Create manufacturers and assign to products";
    readonly dependsOn: string[] = []; // No dependencies

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { blueprint, cache, options } = context;

        // Collect unique manufacturer names
        const manufacturerNames = new Set<string>();
        for (const product of blueprint.products) {
            const name = product.metadata.manufacturerName?.trim();
            if (name) {
                manufacturerNames.add(name);
            }
        }

        if (manufacturerNames.size === 0) {
            return {
                name: this.name,
                processed: 0,
                skipped: 0,
                errors: ["No manufacturer names found in products"],
                durationMs: 0,
            };
        }

        // Check if manufacturers already cached
        const cachedManufacturers = cache.loadManufacturers(context.salesChannelName);
        const cachedNames = new Set(cachedManufacturers?.map((m) => m.name) || []);

        const newManufacturers = Array.from(manufacturerNames).filter(
            (name) => !cachedNames.has(name)
        );

        let processed = 0;
        const skipped = manufacturerNames.size - newManufacturers.length;
        const errors: string[] = [];

        if (options.dryRun) {
            console.log(`    [DRY RUN] Would create ${newManufacturers.length} manufacturers`);
            for (const name of newManufacturers) {
                console.log(`      - ${name}`);
            }
            return {
                name: this.name,
                processed: newManufacturers.length,
                skipped,
                errors: [],
                durationMs: 0,
            };
        }

        // Create manufacturers in Shopware
        const manufacturers = cachedManufacturers || [];
        const manufacturerIdMap = new Map<string, string>();

        // First, check which manufacturers already exist in Shopware (reuse them)
        const existingManufacturers = await this.getExistingManufacturers(
            context,
            manufacturerNames
        );
        for (const [name, id] of existingManufacturers) {
            manufacturerIdMap.set(name, id);
        }
        if (existingManufacturers.size > 0) {
            logger.debug("Reusing existing manufacturers", { count: existingManufacturers.size });
        }

        // Create only NEW manufacturers (ones that don't exist in Shopware)
        const manufacturersToCreate: Array<{
            id: string;
            name: string;
            description: string;
            link: string;
        }> = [];

        for (const name of newManufacturers) {
            if (manufacturerIdMap.has(name)) {
                // Already exists in Shopware - skip (reuse existing)
                continue;
            }

            const id = this.generateUUID();
            const description = `${name} is a trusted manufacturer of quality products.`;
            const link = `https://www.${this.slugify(name)}.com`;

            manufacturersToCreate.push({ id, name, description, link });
            manufacturerIdMap.set(name, id);

            manufacturers.push({ id, name, description, link });
        }

        // Create in Shopware
        if (manufacturersToCreate.length > 0) {
            try {
                const response = await this.apiPost(context, "_action/sync", {
                    createManufacturers: {
                        entity: "product_manufacturer",
                        action: "upsert",
                        payload: manufacturersToCreate,
                    },
                });

                if (!response.ok) {
                    logger.apiError("_action/sync (manufacturers)", response.status, {
                        request: manufacturersToCreate,
                        response: await response.text(),
                    });
                    errors.push(`Failed to create manufacturers: API returned ${response.status}`);
                } else {
                    processed = manufacturersToCreate.length;
                    logger.debug("Manufacturers created successfully", {
                        count: manufacturersToCreate.length,
                    });
                }
            } catch (error) {
                errors.push(
                    `Failed to create manufacturers: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }

        // Now assign manufacturers to products (only those that need updating)
        if (manufacturerIdMap.size > 0 && errors.length === 0) {
            // Get products that already have manufacturer assignments
            const existingAssignments = await this.getExistingProductManufacturers(
                context,
                blueprint.products.map((p) => p.id)
            );

            const productUpdates: Array<{ id: string; manufacturerId: string }> = [];
            let alreadyAssigned = 0;

            for (const product of blueprint.products) {
                const manufacturerName = product.metadata.manufacturerName?.trim();
                if (manufacturerName) {
                    const manufacturerId = manufacturerIdMap.get(manufacturerName);
                    if (manufacturerId) {
                        // Skip if product already has this manufacturer assigned
                        const currentManufacturerId = existingAssignments.get(product.id);
                        if (currentManufacturerId === manufacturerId) {
                            alreadyAssigned++;
                            continue;
                        }
                        productUpdates.push({ id: product.id, manufacturerId });
                    }
                }
            }

            if (alreadyAssigned > 0) {
                logger.debug("Products already have correct manufacturers", {
                    count: alreadyAssigned,
                });
            }

            if (productUpdates.length > 0) {
                try {
                    const response = await this.apiPost(context, "_action/sync", {
                        updateProductManufacturers: {
                            entity: "product",
                            action: "upsert",
                            payload: productUpdates,
                        },
                    });

                    if (!response.ok) {
                        logger.apiError("_action/sync (product manufacturers)", response.status, {
                            request: productUpdates.slice(0, 5),
                            response: await response.text(),
                        });
                        errors.push(
                            `Failed to assign manufacturers to products: API returned ${response.status}`
                        );
                    } else {
                        logger.debug("Product manufacturers assigned", {
                            count: productUpdates.length,
                        });
                    }
                } catch (error) {
                    errors.push(
                        `Failed to assign manufacturers: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }
        }

        // Save to cache
        cache.saveManufacturers(context.salesChannelName, manufacturers);

        return {
            name: this.name,
            processed,
            skipped,
            errors,
            durationMs: 0,
        };
    }

    /**
     * Cleanup manufacturers for products in the SalesChannel
     *
     * 1. Get all products in the SalesChannel
     * 2. Collect their manufacturerIds
     * 3. Unassign manufacturers from products
     * 4. Delete manufacturers that have no other product associations
     */
    async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        const errors: string[] = [];
        let deleted = 0;

        if (context.options.dryRun) {
            console.log(
                `    [DRY RUN] Would unassign and delete manufacturers for products in SalesChannel`
            );
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        if (!context.api) {
            errors.push("API helpers not available - cannot perform cleanup");
            return { name: this.name, deleted: 0, errors, durationMs: 0 };
        }

        try {
            // Step 1: Get all products in this SalesChannel with their manufacturerId
            const products = await context.api.searchEntities<{
                id: string;
                manufacturerId?: string;
            }>(
                "product",
                [
                    {
                        type: "equals",
                        field: "visibilities.salesChannelId",
                        value: context.salesChannelId,
                    },
                ],
                { limit: 500 }
            );

            if (products.length === 0) {
                console.log(`    No products found in SalesChannel`);
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            // Step 2: Collect unique manufacturer IDs from these products
            const manufacturerIds = new Set<string>();
            for (const product of products) {
                if (product.manufacturerId) {
                    manufacturerIds.add(product.manufacturerId);
                }
            }

            if (manufacturerIds.size === 0) {
                console.log(`    No manufacturers assigned to products`);
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            console.log(
                `    Found ${manufacturerIds.size} unique manufacturers assigned to ${products.length} products`
            );

            // Step 3: Unassign manufacturers from products (set manufacturerId to null)
            const productUpdates = products
                .filter((p) => p.manufacturerId)
                .map((p) => ({ id: p.id, manufacturerId: null }));

            if (productUpdates.length > 0) {
                await context.api.syncEntities({
                    unassignManufacturers: {
                        entity: "product",
                        action: "upsert",
                        payload: productUpdates,
                    },
                });
                console.log(
                    `    ✓ Unassigned manufacturers from ${productUpdates.length} products`
                );
            }

            // Step 4: Check which manufacturers are now orphaned (no product associations)
            // For each manufacturer, check if it still has products
            const manufacturersToDelete: string[] = [];

            for (const manufacturerId of manufacturerIds) {
                const productsWithManufacturer = await context.api.searchEntities<{ id: string }>(
                    "product",
                    [{ type: "equals", field: "manufacturerId", value: manufacturerId }],
                    { limit: 1 }
                );

                if (productsWithManufacturer.length === 0) {
                    manufacturersToDelete.push(manufacturerId);
                }
            }

            // Step 5: Delete orphaned manufacturers
            if (manufacturersToDelete.length > 0) {
                await context.api.deleteEntities("product_manufacturer", manufacturersToDelete);
                deleted = manufacturersToDelete.length;
                console.log(`    ✓ Deleted ${deleted} orphaned manufacturers`);
            } else {
                console.log(
                    `    No orphaned manufacturers to delete (all still have products in other SalesChannels)`
                );
            }
        } catch (error) {
            errors.push(
                `Manufacturer cleanup failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        return { name: this.name, deleted, errors, durationMs: 0 };
    }

    /**
     * Get existing product manufacturer assignments
     * Returns a map of productId -> manufacturerId for products that have manufacturers assigned
     */
    private async getExistingProductManufacturers(
        context: PostProcessorContext,
        productIds: string[]
    ): Promise<Map<string, string>> {
        const result = new Map<string, string>();

        if (productIds.length === 0) {
            return result;
        }

        try {
            // Batch the query to avoid too large requests
            const batchSize = 100;
            for (let i = 0; i < productIds.length; i += batchSize) {
                const batch = productIds.slice(i, i + batchSize);

                const response = await this.apiPost(context, "search/product", {
                    ids: batch,
                    includes: { product: ["id", "manufacturerId"] },
                });

                if (response.ok) {
                    interface ProductResult {
                        id: string;
                        manufacturerId?: string | null;
                    }
                    const responseData = (await response.json()) as { data?: ProductResult[] };
                    if (responseData.data) {
                        for (const product of responseData.data) {
                            if (product.manufacturerId) {
                                result.set(product.id, product.manufacturerId);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            logger.error("Failed to fetch existing product manufacturers", error);
        }

        return result;
    }

    /**
     * Get existing manufacturers from Shopware by name
     */
    private async getExistingManufacturers(
        context: PostProcessorContext,
        names: Set<string>
    ): Promise<Map<string, string>> {
        const result = new Map<string, string>();

        try {
            const response = await this.apiPost(context, "search/product-manufacturer", {
                limit: 500,
                filter: [{ type: "equalsAny", field: "name", value: Array.from(names) }],
            });

            if (response.ok) {
                interface ManufacturerResult {
                    id?: string;
                    attributes?: {
                        id?: string;
                        name?: string;
                        translated?: { name?: string };
                    };
                    // Also support flat structure
                    name?: string;
                    translated?: { name?: string };
                }
                const responseData = (await response.json()) as {
                    data?: ManufacturerResult[];
                    total?: number;
                };
                if (responseData.data) {
                    for (const m of responseData.data) {
                        // Handle both nested (Admin API) and flat structures
                        const attrs = m.attributes || m;
                        const name = attrs.translated?.name || attrs.name;
                        const id = m.id || attrs.id;
                        if (name && id) {
                            result.set(name, id);
                        }
                    }
                }
            }
        } catch (error) {
            logger.error("Failed to fetch existing manufacturers", error);
        }

        return result;
    }

    /**
     * Make a POST request to Shopware API
     * Uses context.api if available, falls back to raw fetch for backwards compatibility
     */
    private async apiPost(
        context: PostProcessorContext,
        endpoint: string,
        body: unknown
    ): Promise<Response> {
        // Use context.api if available
        if (context.api) {
            const result = await context.api.post(endpoint, body);
            // Create a Response-like object for compatibility
            return new Response(JSON.stringify(result), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        // Fallback to raw fetch
        const accessToken = await context.getAccessToken();
        const url = `${context.shopwareUrl}/api/${endpoint}`;
        return fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify(body),
        });
    }

    private generateUUID(): string {
        const hex = "0123456789abcdef";
        let uuid = "";
        for (let i = 0; i < 32; i++) {
            uuid += hex[Math.floor(Math.random() * 16)];
        }
        return uuid;
    }

    private slugify(name: string): string {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
    }
}

/** Manufacturer processor singleton */
export const ManufacturerProcessor = new ManufacturerProcessorImpl();
