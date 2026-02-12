/**
 * Shopware module - API client, hydrator, cleanup, and export operations
 */

import type {
    ExportResult,
    ExportValidation,
    ProductInput,
    PropertyGroup,
    SalesChannelFull,
} from "../types/index.js";
import type { ExistingProperty } from "../utils/index.js";
import type { AdminApiClient } from "./admin-client.js";

import { ShopwareCleanup } from "./cleanup.js";
import { ShopwareExporter } from "./export.js";
import { ShopwareHydrator } from "./hydrator.js";

// Re-export types for convenience
export type {
    ExportResult,
    ExportValidation,
    ProductInput,
    PropertyGroup,
    PropertyOption,
    SalesChannel,
} from "../types/index.js";
// Export new official client wrapper and helpers
export {
    type AdminApiClient,
    type AdminClientConfig,
    createShopwareAdminClient,
} from "./admin-client.js";
export {
    createApiHelpers,
    ShopwareApiHelpers,
    type ShopwareFilter,
    type SyncOperation,
    type TokenGetter,
} from "./api-helpers.js";
export { ShopwareCleanup } from "./cleanup.js";
// Export individual classes
export { ShopwareClient } from "./client.js";
export { ShopwareExporter } from "./export.js";
export { ShopwareHydrator } from "./hydrator.js";
// Export sync utilities
export type { PropertyMaps } from "./sync.js";
export {
    buildPropertyMaps,
    syncCategories,
    syncProducts,
    syncPropertyGroups,
    syncPropertyIdsToBlueprint,
} from "./sync.js";

/**
 * Combined DataHydrator class for backwards compatibility
 * Provides hydration, cleanup, and export methods in a single class
 */
export class DataHydrator extends ShopwareHydrator {
    private cleanup: ShopwareCleanup;
    private exporter: ShopwareExporter;

    constructor(client?: AdminApiClient) {
        super(client);
        this.cleanup = new ShopwareCleanup(client);
        this.exporter = new ShopwareExporter(client);
    }

    // Override authentication to also authenticate cleanup and exporter instances
    override async authenticateWithClientCredentials(
        envPath: string,
        clientId: string | undefined,
        clientSecret: string | undefined
    ): Promise<boolean> {
        const result = await super.authenticateWithClientCredentials(
            envPath,
            clientId,
            clientSecret
        );
        await this.cleanup.authenticateWithClientCredentials(envPath, clientId, clientSecret);
        await this.exporter.authenticateWithClientCredentials(envPath, clientId, clientSecret);
        return result;
    }

    override async authenticateWithUserCredentials(
        envPath: string,
        userName: string,
        password: string
    ): Promise<boolean> {
        const result = await super.authenticateWithUserCredentials(envPath, userName, password);
        await this.cleanup.authenticateWithUserCredentials(envPath, userName, password);
        await this.exporter.authenticateWithUserCredentials(envPath, userName, password);
        return result;
    }

    // Delegate export methods
    async exportSalesChannel(salesChannel: SalesChannelFull): Promise<ExportResult> {
        return this.exporter.exportSalesChannel(salesChannel);
    }

    async exportCategories(
        rootCategoryId: string,
        validation: ExportValidation
    ): Promise<import("../types/index.js").CategoryNode[]> {
        return this.exporter.exportCategories(rootCategoryId, validation);
    }

    async exportProductsInCategory(
        categoryId: string,
        categoryName: string,
        validation: ExportValidation
    ): Promise<ProductInput[]> {
        return this.exporter.exportProductsInCategory(categoryId, categoryName, validation);
    }

    async exportPropertyGroups(validation: ExportValidation): Promise<PropertyGroup[]> {
        return this.exporter.exportPropertyGroups(validation);
    }

    async getExistingPropertyGroups(): Promise<ExistingProperty[]> {
        return this.exporter.getExistingPropertyGroups();
    }

    // Delegate cleanup methods
    async deleteProductsByCategory(categoryName: string): Promise<number> {
        return this.cleanup.deleteProductsByCategory(categoryName);
    }

    async deleteCategory(categoryName: string): Promise<boolean> {
        return this.cleanup.deleteCategory(categoryName);
    }

    async deletePropertyGroups(groupNames: string[]): Promise<number> {
        return this.cleanup.deletePropertyGroups(groupNames);
    }

    async deleteAllPropertyGroups(): Promise<number> {
        return this.cleanup.deleteAllPropertyGroups();
    }

    async cleanupCategory(
        categoryName: string,
        options: { deletePropertyGroups?: boolean } = {}
    ): Promise<{
        products: number;
        category: boolean;
        propertyGroups: number;
    }> {
        return this.cleanup.cleanupCategory(categoryName, options);
    }

    async deleteOrphanedProductMedia(dryRun = false): Promise<number> {
        return this.cleanup.deleteOrphanedProductMedia(dryRun);
    }

    async deleteUnusedPropertyGroups(dryRun = false): Promise<number> {
        return this.cleanup.deleteUnusedPropertyGroups(dryRun);
    }

    async deleteUnusedPropertyOptions(dryRun = false): Promise<number> {
        return this.cleanup.deleteUnusedPropertyOptions(dryRun);
    }

    async cleanupSalesChannel(
        salesChannelName: string,
        options: {
            deletePropertyGroups?: boolean;
            deleteManufacturers?: boolean;
            deleteSalesChannel?: boolean;
        } = {}
    ): Promise<{
        products: number;
        categories: number;
        propertyGroups: number;
        manufacturers: number;
        salesChannelDeleted: boolean;
        rootCategoryDeleted: boolean;
        errors: string[];
    }> {
        return this.cleanup.cleanupSalesChannel(salesChannelName, options);
    }

    override async hydrateEnvWithPropertyGroups(
        propertyGroups: PropertyGroup[]
    ): Promise<PropertyGroup[]> {
        return super.hydrateEnvWithPropertyGroups(propertyGroups);
    }

    override async hydrateEnvWithProducts(
        products: ProductInput[],
        category: string,
        salesChannelName: string = "Storefront"
    ): Promise<number | false> {
        return super.hydrateEnvWithProducts(products, category, salesChannelName);
    }
}
