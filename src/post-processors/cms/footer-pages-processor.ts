/**
 * Footer Pages Processor - Creates shared footer/service navigation category trees.
 */

import type { CmsPageFixture } from "../../fixtures/index.js";
import type { CategorySyncPayload, SalesChannelUpdatePayload } from "../../types/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "../index.js";

import { findCategoryIdByName, searchAllByFilter } from "../../shopware/api-helpers.js";
import { apiPost, generateUUID, logger } from "../../utils/index.js";
import { BaseCmsProcessor } from "./base-processor.js";

interface LegalCategoryConfig {
    categoryName: string;
    parent: "customerServices" | "serviceRoot";
    cmsPageNameCandidates: string[];
}

interface SalesChannelRow {
    id: string;
    footerCategoryId?: string | null;
    serviceCategoryId?: string | null;
}

const FOOTER_NAVIGATION_ROOT = "Footer-Navigation";
const FOOTER_SERVICE_NAVIGATION_ROOT = "Footer-Service-Navigation";
const CUSTOMER_SERVICES_CATEGORY = "Customer Services";

const LEGAL_CATEGORIES: LegalCategoryConfig[] = [
    {
        categoryName: "Right of rescission",
        parent: "customerServices",
        cmsPageNameCandidates: ["Right of rescission", "Right of withdrawal", "Revocation policy"],
    },
    {
        categoryName: "Payment / Shipping",
        parent: "customerServices",
        cmsPageNameCandidates: [
            "Payment / Shipping",
            "Payment and shipping",
            "Shipping and payment",
        ],
    },
    {
        categoryName: "Privacy",
        parent: "customerServices",
        cmsPageNameCandidates: ["Privacy", "Privacy policy", "Data protection"],
    },
    {
        categoryName: "Terms of service",
        parent: "serviceRoot",
        cmsPageNameCandidates: [
            "Terms of service",
            "Terms and conditions",
            "General terms and conditions",
        ],
    },
    {
        categoryName: "Imprint",
        parent: "serviceRoot",
        cmsPageNameCandidates: ["Imprint", "Legal notice"],
    },
];

const FOOTER_PAGE_FIXTURE: CmsPageFixture = {
    name: "footer-pages-placeholder",
    type: "page",
    sections: [],
};

class FooterPagesProcessorImpl extends BaseCmsProcessor implements PostProcessor {
    readonly name = "cms-footer-pages";
    readonly description = "Create shared footer and footer-service navigation categories";
    readonly pageFixture = FOOTER_PAGE_FIXTURE;
    override readonly dependsOn: string[] = [];

    override async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        if (context.options.dryRun) {
            logger.info(`    [DRY RUN] Would create ${FOOTER_NAVIGATION_ROOT} hierarchy`, {
                cli: true,
            });
            logger.info(`    [DRY RUN] Would create ${FOOTER_SERVICE_NAVIGATION_ROOT} hierarchy`, {
                cli: true,
            });
            logger.info(`    [DRY RUN] Would assign footer/service roots to all SalesChannels`, {
                cli: true,
            });
            return { name: this.name, processed: 1, skipped: 0, errors: [], durationMs: 0 };
        }

        const errors: string[] = [];

        try {
            const salesChannels = await this.getAllSalesChannels(context);
            if (salesChannels.length === 0) {
                return {
                    name: this.name,
                    processed: 0,
                    skipped: 0,
                    errors: ["No SalesChannels found for footer assignment"],
                    durationMs: 0,
                };
            }

            const footerRootId = await this.ensureRootCategory(context, FOOTER_NAVIGATION_ROOT);
            const customerServicesId = await this.ensureStructuringCategory(
                context,
                CUSTOMER_SERVICES_CATEGORY,
                footerRootId
            );
            await this.fixRescissionTypo(context, customerServicesId);
            const serviceRootId = await this.ensureRootCategory(
                context,
                FOOTER_SERVICE_NAVIGATION_ROOT
            );

            await this.ensureLegalCategories(context, customerServicesId, serviceRootId, errors);

            for (const salesChannel of salesChannels) {
                await this.assignSalesChannel(
                    context,
                    salesChannel,
                    footerRootId,
                    serviceRootId,
                    errors
                );
            }

            await this.validateHierarchy(
                context,
                footerRootId,
                customerServicesId,
                serviceRootId,
                errors
            );
            await this.validateSalesChannelAssignments(
                context,
                footerRootId,
                serviceRootId,
                errors
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`Footer pages processor failed: ${message}`);
        }

        return {
            name: this.name,
            processed: errors.length === 0 ? 1 : 0,
            skipped: 0,
            errors,
            durationMs: 0,
        };
    }

    override async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        if (context.options.dryRun) {
            logger.info(`    [DRY RUN] Would clean up footer page assignments`, { cli: true });
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        const errors: string[] = [];
        let deleted = 0;

        try {
            const salesChannels = await this.getAllSalesChannels(context);
            const currentSalesChannel = salesChannels.find(
                (sc) => sc.id === context.salesChannelId
            );
            if (!currentSalesChannel) {
                return {
                    name: this.name,
                    deleted: 0,
                    errors: [`SalesChannel "${context.salesChannelId}" not found`],
                    durationMs: 0,
                };
            }

            const footerRootId = await this.findRootCategoryId(context, FOOTER_NAVIGATION_ROOT);
            const serviceRootId = await this.findRootCategoryId(
                context,
                FOOTER_SERVICE_NAVIGATION_ROOT
            );

            await this.clearSalesChannelAssignments(
                context,
                currentSalesChannel,
                footerRootId,
                serviceRootId,
                errors
            );

            const refreshedSalesChannels = await this.getAllSalesChannels(context);
            deleted += await this.cleanupFooterTree(
                context,
                refreshedSalesChannels,
                footerRootId,
                serviceRootId,
                errors
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`Cleanup failed: ${message}`);
        }

        return { name: this.name, deleted, errors, durationMs: 0 };
    }

    private async ensureLegalCategories(
        context: PostProcessorContext,
        customerServicesId: string,
        serviceRootId: string,
        errors: string[]
    ): Promise<void> {
        let afterCustomerServicesCategoryId: string | undefined;
        let afterServiceRootCategoryId: string | undefined;

        for (const config of LEGAL_CATEGORIES) {
            const parentId =
                config.parent === "customerServices" ? customerServicesId : serviceRootId;
            const afterCategoryId =
                config.parent === "customerServices"
                    ? afterCustomerServicesCategoryId
                    : afterServiceRootCategoryId;
            const cmsPageId = await this.findCmsPageIdByCandidates(
                context,
                config.cmsPageNameCandidates
            );
            if (!cmsPageId) {
                errors.push(
                    `Missing CMS page for "${config.categoryName}" (tried: ${config.cmsPageNameCandidates.join(", ")})`
                );
                continue;
            }

            const categoryId = await this.ensurePageCategory(
                context,
                config.categoryName,
                parentId,
                cmsPageId,
                afterCategoryId
            );
            if (!categoryId) {
                errors.push(`Failed to ensure legal category "${config.categoryName}"`);
                continue;
            }

            if (config.parent === "customerServices") {
                afterCustomerServicesCategoryId = categoryId;
            } else {
                afterServiceRootCategoryId = categoryId;
            }
        }
    }

    private async assignSalesChannel(
        context: PostProcessorContext,
        salesChannel: SalesChannelRow,
        footerRootId: string,
        serviceRootId: string,
        errors: string[]
    ): Promise<void> {
        const payload: SalesChannelUpdatePayload = {
            id: salesChannel.id,
            footerCategoryId: footerRootId,
            serviceCategoryId: serviceRootId,
        };

        const response = await apiPost(context, "_action/sync", {
            assignFooterPagesToSalesChannel: {
                entity: "sales_channel",
                action: "upsert",
                payload: [payload],
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            errors.push(`SalesChannel ${salesChannel.id}: assignment failed (${errorText})`);
            return;
        }

        logger.info(`    ✓ Assigned footer roots for SalesChannel ${salesChannel.id}`, {
            cli: true,
        });
    }

    private async validateHierarchy(
        context: PostProcessorContext,
        footerRootId: string,
        customerServicesId: string,
        serviceRootId: string,
        errors: string[]
    ): Promise<void> {
        for (const config of LEGAL_CATEGORIES) {
            const parentId =
                config.parent === "customerServices" ? customerServicesId : serviceRootId;
            const categoryId = await findCategoryIdByName(context, config.categoryName, parentId);
            if (!categoryId) {
                errors.push(`Validation: missing category "${config.categoryName}"`);
            }
        }

        const customerServicesExists = await findCategoryIdByName(
            context,
            CUSTOMER_SERVICES_CATEGORY,
            footerRootId
        );
        if (!customerServicesExists) {
            errors.push(`Validation: missing category "${CUSTOMER_SERVICES_CATEGORY}"`);
        }
    }

    private async validateSalesChannelAssignments(
        context: PostProcessorContext,
        footerRootId: string,
        serviceRootId: string,
        errors: string[]
    ): Promise<void> {
        const salesChannels = await this.getAllSalesChannels(context);
        for (const salesChannel of salesChannels) {
            if (salesChannel.footerCategoryId !== footerRootId) {
                errors.push(`Validation: SalesChannel ${salesChannel.id} missing footerCategoryId`);
            }
            if (salesChannel.serviceCategoryId !== serviceRootId) {
                errors.push(
                    `Validation: SalesChannel ${salesChannel.id} missing serviceCategoryId`
                );
            }
        }
    }

    private async clearSalesChannelAssignments(
        context: PostProcessorContext,
        salesChannel: SalesChannelRow,
        footerRootId: string | null,
        serviceRootId: string | null,
        errors: string[]
    ): Promise<void> {
        const payload: SalesChannelUpdatePayload = { id: salesChannel.id };

        if (footerRootId && salesChannel.footerCategoryId === footerRootId) {
            payload.footerCategoryId = null;
        }
        if (serviceRootId && salesChannel.serviceCategoryId === serviceRootId) {
            payload.serviceCategoryId = null;
        }

        if (Object.keys(payload).length === 1) return;

        const response = await apiPost(context, "_action/sync", {
            clearFooterPagesFromSalesChannel: {
                entity: "sales_channel",
                action: "upsert",
                payload: [payload],
            },
        });
        if (!response.ok) {
            const errorText = await response.text();
            errors.push(
                `SalesChannel ${salesChannel.id}: failed to clear assignments (${errorText})`
            );
        }
    }

    private async cleanupFooterTree(
        context: PostProcessorContext,
        salesChannels: SalesChannelRow[],
        footerRootId: string | null,
        serviceRootId: string | null,
        errors: string[]
    ): Promise<number> {
        let deleted = 0;

        const footerReferenced = footerRootId
            ? salesChannels.some((salesChannel) => salesChannel.footerCategoryId === footerRootId)
            : false;
        const serviceReferenced = serviceRootId
            ? salesChannels.some((salesChannel) => salesChannel.serviceCategoryId === serviceRootId)
            : false;

        if (!footerReferenced && footerRootId) {
            deleted += await this.deleteFooterNavigationTree(context, footerRootId, errors);
        }
        if (!serviceReferenced && serviceRootId) {
            deleted += await this.deleteFooterServiceTree(context, serviceRootId, errors);
        }

        return deleted;
    }

    private async deleteFooterNavigationTree(
        context: PostProcessorContext,
        footerRootId: string,
        errors: string[]
    ): Promise<number> {
        return this.deleteCategorySubtree(context, footerRootId, FOOTER_NAVIGATION_ROOT, errors);
    }

    private async deleteFooterServiceTree(
        context: PostProcessorContext,
        serviceRootId: string,
        errors: string[]
    ): Promise<number> {
        return this.deleteCategorySubtree(
            context,
            serviceRootId,
            FOOTER_SERVICE_NAVIGATION_ROOT,
            errors
        );
    }

    private async deleteCategorySubtree(
        context: PostProcessorContext,
        rootCategoryId: string,
        rootName: string,
        errors: string[]
    ): Promise<number> {
        let deleted = 0;
        const childIds = await this.getDirectChildCategoryIds(context, rootCategoryId);

        for (const childId of childIds) {
            deleted += await this.deleteCategorySubtree(context, childId, rootName, errors);
        }

        if (await this.deleteEntity(context, "category", rootCategoryId)) {
            return deleted + 1;
        }

        errors.push(`Failed to delete category in "${rootName}" tree (${rootCategoryId})`);
        return deleted;
    }

    private async getDirectChildCategoryIds(
        context: PostProcessorContext,
        parentId: string
    ): Promise<string[]> {
        interface CategoryResponse {
            data?: Array<{ id: string }>;
        }

        const childIds: string[] = [];
        const limit = 100;
        let page = 1;

        while (true) {
            const response = await apiPost(context, "search/category", {
                filter: [{ type: "equals", field: "parentId", value: parentId }],
                limit,
                page,
            });
            if (!response.ok) {
                return childIds;
            }

            const data = (await response.json()) as CategoryResponse;
            const pageIds = (data.data ?? []).map((category) => category.id);
            childIds.push(...pageIds);

            if (pageIds.length < limit) {
                return childIds;
            }

            page++;
        }
    }

    private async findCmsPageIdByCandidates(
        context: PostProcessorContext,
        candidates: string[]
    ): Promise<string | null> {
        for (const candidate of candidates) {
            const exactMatch = await this.findCmsPageIdByName(context, candidate);
            if (exactMatch) {
                return exactMatch;
            }
        }

        for (const candidate of candidates) {
            const containsMatch = await this.findCmsPageIdByNameContains(context, candidate);
            if (containsMatch) {
                return containsMatch;
            }
        }

        return null;
    }

    private async findCmsPageIdByName(
        context: PostProcessorContext,
        name: string
    ): Promise<string | null> {
        interface CmsPageResponse {
            data?: Array<{ id: string }>;
        }

        const response = await apiPost(context, "search/cms-page", {
            filter: [{ type: "equals", field: "name", value: name }],
            limit: 1,
        });
        if (!response.ok) return null;
        const data = (await response.json()) as CmsPageResponse;
        return data.data?.[0]?.id ?? null;
    }

    private async findCmsPageIdByNameContains(
        context: PostProcessorContext,
        nameFragment: string
    ): Promise<string | null> {
        interface CmsPageResponse {
            data?: Array<{ id: string }>;
        }

        const response = await apiPost(context, "search/cms-page", {
            filter: [{ type: "contains", field: "name", value: nameFragment }],
            limit: 1,
        });
        if (!response.ok) return null;
        const data = (await response.json()) as CmsPageResponse;
        return data.data?.[0]?.id ?? null;
    }

    private async fixRescissionTypo(
        context: PostProcessorContext,
        customerServicesId: string
    ): Promise<void> {
        const typoId = await findCategoryIdByName(
            context,
            "Right of recission",
            customerServicesId
        );
        if (!typoId) return;

        const correctId = await findCategoryIdByName(
            context,
            "Right of rescission",
            customerServicesId
        );
        if (correctId) return;

        const response = await apiPost(context, "_action/sync", {
            renameRescissionCategory: {
                entity: "category",
                action: "upsert",
                payload: [{ id: typoId, name: "Right of rescission" }],
            },
        });
        if (!response.ok) {
            logger.warn(`Failed to rename "Right of recission" to "Right of rescission"`);
        }
    }

    private async ensureRootCategory(context: PostProcessorContext, name: string): Promise<string> {
        const existing = await this.findRootCategoryId(context, name);
        if (existing) return existing;

        const categoryId = generateUUID();
        const response = await apiPost(context, "_action/sync", {
            createRootCategory: {
                entity: "category",
                action: "upsert",
                payload: [
                    {
                        id: categoryId,
                        name,
                        active: true,
                        type: "page",
                        visible: true,
                        displayNestedProducts: false,
                    },
                ],
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create root category "${name}": ${errorText}`);
        }

        logger.info(`    ✓ Created root category "${name}"`, { cli: true });
        return categoryId;
    }

    private async findRootCategoryId(
        context: PostProcessorContext,
        name: string
    ): Promise<string | null> {
        interface CategoryResponse {
            data?: Array<{ id: string }>;
        }

        const response = await apiPost(context, "search/category", {
            filter: [
                { type: "equals", field: "name", value: name },
                { type: "equals", field: "parentId", value: null },
            ],
            limit: 1,
        });
        if (!response.ok) return null;
        const data = (await response.json()) as CategoryResponse;
        return data.data?.[0]?.id ?? null;
    }

    private async ensurePageCategory(
        context: PostProcessorContext,
        name: string,
        parentId: string,
        cmsPageId: string,
        afterCategoryId?: string
    ): Promise<string> {
        const existing = await findCategoryIdByName(context, name, parentId);
        const categoryId = existing ?? generateUUID();

        const payload: CategorySyncPayload = {
            id: categoryId,
            parentId,
            name,
            active: true,
            type: "page",
            visible: true,
            displayNestedProducts: false,
            cmsPageId,
            afterCategoryId,
        };

        const response = await apiPost(context, "_action/sync", {
            upsertCategory: {
                entity: "category",
                action: "upsert",
                payload: [payload],
            },
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to ensure category "${name}": ${errorText}`);
        }

        return categoryId;
    }

    private async ensureStructuringCategory(
        context: PostProcessorContext,
        name: string,
        parentId: string
    ): Promise<string> {
        const existing = await findCategoryIdByName(context, name, parentId);
        const categoryId = existing ?? generateUUID();

        const payload: CategorySyncPayload = {
            id: categoryId,
            parentId,
            name,
            active: true,
            type: "folder",
            visible: true,
            displayNestedProducts: false,
        };

        const response = await apiPost(context, "_action/sync", {
            upsertStructuringCategory: {
                entity: "category",
                action: "upsert",
                payload: [payload],
            },
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to ensure structuring category "${name}": ${errorText}`);
        }

        return categoryId;
    }

    private async getAllSalesChannels(context: PostProcessorContext): Promise<SalesChannelRow[]> {
        const salesChannels = await searchAllByFilter(context, "sales-channel", []);
        return salesChannels as SalesChannelRow[];
    }
}

export const FooterPagesProcessor = new FooterPagesProcessorImpl();
