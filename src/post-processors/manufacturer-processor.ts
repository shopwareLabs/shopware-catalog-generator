/**
 * Manufacturer Processor - Creates manufacturers and assigns to products
 *
 * 1. Collects unique manufacturer names from products
 * 2. Generates manufacturer descriptions via AI
 * 3. Creates manufacturers in Shopware
 * 4. Assigns manufacturers to products
 */

import type { Manufacturer } from "../types/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

import { localizedFixtureText } from "../fixtures/index.js";
import { searchAllByFilter } from "../shopware/api-helpers.js";
import { apiPost, generateUUID, logger, toKebabCase } from "../utils/index.js";

/** Default fields of a manufacturer this generator creates */
function newManufacturer(name: string): Manufacturer {
    return {
        id: "",
        name,
        description: localizedFixtureText("manufacturer.description", null, { name }),
        link: `https://www.${toKebabCase(name)}.com`,
    };
}

/** Unique, trimmed manufacturer names in blueprint order */
function collectManufacturerNames(
    products: PostProcessorContext["blueprint"]["products"]
): string[] {
    const names = products
        .map((product) => product.metadata.manufacturerName?.trim())
        .filter((name): name is string => Boolean(name));
    return [...new Set(names)];
}

function logDryRun(manufacturers: Manufacturer[]): void {
    logger.info(`    [DRY RUN] Would create ${manufacturers.length} manufacturers`, { cli: true });
    for (const { name } of manufacturers) {
        logger.info(`      - ${name}`, { cli: true });
    }
}

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/**
 * Manufacturer Processor implementation
 */
class ManufacturerProcessorImpl implements PostProcessor {
    readonly name = "manufacturers";
    readonly description = "Create manufacturers and assign to products";
    readonly dependsOn: string[] = []; // No dependencies

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { blueprint, cache, options } = context;
        const manufacturerNames = collectManufacturerNames(blueprint.products);
        const result = (
            processed: number,
            skipped: number,
            errors: string[]
        ): PostProcessorResult => ({
            name: this.name,
            processed,
            skipped,
            errors,
            durationMs: 0,
        });

        if (manufacturerNames.length === 0) {
            return result(0, 0, ["No manufacturer names found in products"]);
        }

        // Shopware is the source of truth: cached IDs can be stale (other shop, cleanup)
        const cachedByName = new Map(
            (cache.loadManufacturers(context.salesChannelName) ?? []).map((m) => [m.name, m])
        );
        const manufacturerIdMap = await this.getExistingManufacturers(
            context,
            new Set(manufacturerNames)
        );
        const skipped = manufacturerIdMap.size;
        if (skipped > 0) {
            logger.debug("Reusing existing manufacturers", { data: { count: skipped } });
        }

        const withCachedFields = (name: string, id: string): Manufacturer => ({
            ...(cachedByName.get(name) ?? newManufacturer(name)),
            id,
        });
        const manufacturersToCreate = manufacturerNames
            .filter((name) => !manufacturerIdMap.has(name))
            .map((name) => withCachedFields(name, generateUUID()));

        if (options.dryRun) {
            logDryRun(manufacturersToCreate);
            return result(manufacturersToCreate.length, skipped, []);
        }

        for (const m of manufacturersToCreate) {
            manufacturerIdMap.set(m.name, m.id);
        }
        const createError = await this.createManufacturers(context, manufacturersToCreate);
        const assignError = createError
            ? null
            : await this.assignManufacturers(context, manufacturerIdMap);

        cache.saveManufacturers(
            context.salesChannelName,
            manufacturerNames.map((name) =>
                withCachedFields(name, manufacturerIdMap.get(name) ?? generateUUID())
            )
        );

        const errors = [createError, assignError].filter((e): e is string => e !== null);
        return result(createError ? 0 : manufacturersToCreate.length, skipped, errors);
    }

    /** Create the missing manufacturers. Returns an error message on failure. */
    private async createManufacturers(
        context: PostProcessorContext,
        manufacturers: Manufacturer[]
    ): Promise<string | null> {
        if (manufacturers.length === 0) return null;
        try {
            await context.api.post("_action/sync", {
                createManufacturers: {
                    entity: "product_manufacturer",
                    action: "upsert",
                    payload: manufacturers,
                },
            });
            logger.debug("Manufacturers created successfully", {
                data: { count: manufacturers.length },
            });
            return null;
        } catch (error) {
            return `Failed to create manufacturers: ${errorMessage(error)}`;
        }
    }

    /**
     * Assign each product its manufacturer, skipping products that already have it.
     * Returns an error message on failure.
     */
    private async assignManufacturers(
        context: PostProcessorContext,
        manufacturerIdMap: Map<string, string>
    ): Promise<string | null> {
        const { products } = context.blueprint;
        const existingAssignments = await this.getExistingProductManufacturers(
            context,
            products.map((p) => p.id)
        );
        const wanted = products.flatMap((product) => {
            const name = product.metadata.manufacturerName?.trim();
            const manufacturerId = name ? manufacturerIdMap.get(name) : undefined;
            return manufacturerId ? [{ id: product.id, manufacturerId }] : [];
        });
        const productUpdates = wanted.filter(
            (u) => existingAssignments.get(u.id) !== u.manufacturerId
        );

        const alreadyAssigned = wanted.length - productUpdates.length;
        if (alreadyAssigned > 0) {
            logger.debug("Products already have correct manufacturers", {
                data: { count: alreadyAssigned },
            });
        }
        if (productUpdates.length === 0) return null;

        try {
            await context.api.post("_action/sync", {
                updateProductManufacturers: {
                    entity: "product",
                    action: "upsert",
                    payload: productUpdates,
                },
            });
            logger.debug("Product manufacturers assigned", {
                data: { count: productUpdates.length },
            });
            return null;
        } catch (error) {
            return `Failed to assign manufacturers: ${errorMessage(error)}`;
        }
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
            logger.info(
                `    [DRY RUN] Would unassign and delete manufacturers for products in SalesChannel`,
                { cli: true }
            );
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        if (!context.api) {
            errors.push("API helpers not available - cannot perform cleanup");
            return { name: this.name, deleted: 0, errors, durationMs: 0 };
        }

        try {
            // Step 1: Get all products in this SalesChannel with their manufacturerId
            const products = await this.getAllSalesChannelProductsWithManufacturer(context);

            if (products.length === 0) {
                logger.info(`    No products found in SalesChannel`, { cli: true });
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
                logger.info(`    No manufacturers assigned to products`, { cli: true });
                return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
            }

            logger.info(
                `    Found ${manufacturerIds.size} unique manufacturers assigned to ${products.length} products`,
                { cli: true }
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
                logger.info(
                    `    ✓ Unassigned manufacturers from ${productUpdates.length} products`,
                    { cli: true }
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
                logger.info(`    ✓ Deleted ${deleted} orphaned manufacturers`, { cli: true });
            } else {
                logger.info(
                    `    No orphaned manufacturers to delete (all still have products in other SalesChannels)`,
                    { cli: true }
                );
            }

            // Clear local cache so the next generate re-creates manufacturers in Shopware
            context.cache.saveManufacturers(context.salesChannelName, []);
        } catch (error) {
            errors.push(`Manufacturer cleanup failed: ${errorMessage(error)}`);
        }

        return { name: this.name, deleted, errors, durationMs: 0 };
    }

    private async getAllSalesChannelProductsWithManufacturer(
        context: PostProcessorContext
    ): Promise<Array<{ id: string; manufacturerId?: string }>> {
        return searchAllByFilter<{ id: string; manufacturerId?: string }>(
            context,
            "product",
            [
                {
                    type: "equals",
                    field: "visibilities.salesChannelId",
                    value: context.salesChannelId,
                },
            ],
            { includes: { product: ["id", "manufacturerId"] } }
        );
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

                const response = await apiPost(context, "search/product", {
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
            logger.error("Failed to fetch existing product manufacturers", { data: error });
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
            const response = await apiPost(context, "search/product-manufacturer", {
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
            logger.error("Failed to fetch existing manufacturers", { data: error });
        }

        return result;
    }
}

/** Manufacturer processor singleton */
export const ManufacturerProcessor = new ManufacturerProcessorImpl();
