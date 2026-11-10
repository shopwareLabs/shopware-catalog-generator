/**
 * Manufacturer Processor - Creates manufacturers and assigns to products
 *
 * 1. Collects unique manufacturer names from products
 * 2. Generates manufacturer descriptions via AI
 * 3. Creates manufacturers in Shopware
 * 4. Assigns manufacturers to products
 */

import type { ShopwareApi } from "../shopware/api-helpers.js";
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

/** A manufacturer search hit: nested (Admin API JSON:API) or flat */
interface ManufacturerSearchResult {
    id?: string;
    attributes?: {
        id?: string;
        name?: string;
        translated?: { name?: string };
    };
    name?: string;
    translated?: { name?: string };
}

/** Maps manufacturer name (translated first) to ID; hits without both are skipped */
function manufacturerIdsByName(results: ManufacturerSearchResult[]): Map<string, string> {
    const byName = new Map<string, string>();
    for (const m of results) {
        const attrs = m.attributes || m;
        const name = attrs.translated?.name || attrs.name;
        const id = m.id || attrs.id;
        if (name && id) {
            byName.set(name, id);
        }
    }
    return byName;
}

/** productId -> manufacturerId for one batch; products without a manufacturer are left out */
async function fetchProductManufacturers(
    context: PostProcessorContext,
    productIds: string[]
): Promise<Array<[string, string]>> {
    const response = await apiPost(context, "search/product", {
        ids: productIds,
        includes: { product: ["id", "manufacturerId"] },
    });
    if (!response.ok) {
        return [];
    }
    const responseData = (await response.json()) as {
        data?: Array<{ id: string; manufacturerId?: string | null }>;
    };
    return (responseData.data ?? []).flatMap((p): Array<[string, string]> =>
        p.manufacturerId ? [[p.id, p.manufacturerId]] : []
    );
}

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
        if (context.options.dryRun) {
            logger.info(
                `    [DRY RUN] Would unassign and delete manufacturers for products in SalesChannel`,
                { cli: true }
            );
            return this.cleanupResult(0, []);
        }

        if (!context.api) {
            return this.cleanupResult(0, ["API helpers not available - cannot perform cleanup"]);
        }

        try {
            const deleted = await this.unassignAndDeleteManufacturers(context, context.api);
            return this.cleanupResult(deleted, []);
        } catch (error) {
            return this.cleanupResult(0, [`Manufacturer cleanup failed: ${errorMessage(error)}`]);
        }
    }

    private cleanupResult(deleted: number, errors: string[]): PostProcessorCleanupResult {
        return { name: this.name, deleted, errors, durationMs: 0 };
    }

    /** Unassigns the manufacturers of the SalesChannel products and deletes orphans; returns the count */
    private async unassignAndDeleteManufacturers(
        context: PostProcessorContext,
        api: ShopwareApi
    ): Promise<number> {
        const products = await this.getAllSalesChannelProductsWithManufacturer(context);
        if (products.length === 0) {
            logger.info(`    No products found in SalesChannel`, { cli: true });
            return 0;
        }

        const assigned = products.flatMap((p) =>
            p.manufacturerId ? [{ id: p.id, manufacturerId: p.manufacturerId }] : []
        );
        const manufacturerIds = new Set(assigned.map((p) => p.manufacturerId));
        if (manufacturerIds.size === 0) {
            logger.info(`    No manufacturers assigned to products`, { cli: true });
            return 0;
        }

        logger.info(
            `    Found ${manufacturerIds.size} unique manufacturers assigned to ${products.length} products`,
            { cli: true }
        );

        await api.syncEntities({
            unassignManufacturers: {
                entity: "product",
                action: "upsert",
                payload: assigned.map((p) => ({ id: p.id, manufacturerId: null })),
            },
        });
        logger.info(`    ✓ Unassigned manufacturers from ${assigned.length} products`, {
            cli: true,
        });

        const deleted = await this.deleteOrphanedManufacturers(api, [...manufacturerIds]);
        // Clear local cache so the next generate re-creates manufacturers in Shopware
        context.cache.saveManufacturers(context.salesChannelName, []);
        return deleted;
    }

    /** Deletes the manufacturers that no product references any more; returns the count */
    private async deleteOrphanedManufacturers(
        api: ShopwareApi,
        manufacturerIds: string[]
    ): Promise<number> {
        const orphaned: string[] = [];
        for (const manufacturerId of manufacturerIds) {
            const stillUsed = await api.searchEntities<{ id: string }>(
                "product",
                [{ type: "equals", field: "manufacturerId", value: manufacturerId }],
                { limit: 1 }
            );
            if (stillUsed.length === 0) {
                orphaned.push(manufacturerId);
            }
        }

        if (orphaned.length === 0) {
            logger.info(
                `    No orphaned manufacturers to delete (all still have products in other SalesChannels)`,
                { cli: true }
            );
            return 0;
        }

        await api.deleteEntities("product_manufacturer", orphaned);
        logger.info(`    ✓ Deleted ${orphaned.length} orphaned manufacturers`, { cli: true });
        return orphaned.length;
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

        try {
            // Batch the query to avoid too large requests
            const batchSize = 100;
            for (let i = 0; i < productIds.length; i += batchSize) {
                const batch = productIds.slice(i, i + batchSize);
                for (const [id, manufacturerId] of await fetchProductManufacturers(
                    context,
                    batch
                )) {
                    result.set(id, manufacturerId);
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
        try {
            const response = await apiPost(context, "search/product-manufacturer", {
                limit: 500,
                filter: [{ type: "equalsAny", field: "name", value: Array.from(names) }],
            });
            if (!response.ok) {
                return new Map();
            }
            const responseData = (await response.json()) as { data?: ManufacturerSearchResult[] };
            return manufacturerIdsByName(responseData.data ?? []);
        } catch (error) {
            logger.error("Failed to fetch existing manufacturers", { data: error });
            return new Map();
        }
    }
}

/** Manufacturer processor singleton */
export const ManufacturerProcessor = new ManufacturerProcessorImpl();
