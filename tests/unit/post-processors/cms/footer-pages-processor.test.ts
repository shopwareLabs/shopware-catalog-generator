import { describe, expect, test } from "bun:test";

import type { PostProcessorContext } from "../../../../src/post-processors/index.js";

import { FooterPagesProcessor } from "../../../../src/post-processors/cms/footer-pages-processor.js";
import { createTestBlueprint } from "../../../helpers/blueprint-factory.js";
import { createTestContext } from "../../../helpers/post-processor-context.js";
import { MockApiHelpers } from "../../../mocks/index.js";

interface CategoryRow {
    id: string;
    name: string;
    parentId: string | null;
    cmsPageId?: string | null;
}

interface CmsPageRow {
    id: string;
    name: string;
}

interface SalesChannelRow {
    id: string;
    footerCategoryId: string | null;
    serviceCategoryId: string | null;
    serviceCmsPageId: string | null;
    revocationCmsPageId: string | null;
    paymentShippingCmsPageId: string | null;
    privacyCmsPageId: string | null;
    imprintCmsPageId: string | null;
}

interface MockDb {
    categories: CategoryRow[];
    cmsPages: CmsPageRow[];
    salesChannels: SalesChannelRow[];
}

/**
 * Stateful mock API helpers that simulate a DB for footer pages tests.
 * Overrides post/searchEntities/deleteEntity to maintain state.
 */
class FooterMockApiHelpers extends MockApiHelpers {
    constructor(private db: MockDb) {
        super();
    }

    override async searchEntities<T = Record<string, unknown>>(
        entity: string,
        _filters?: import("../../../../src/shopware/api-helpers.js").ShopwareFilter[],
        _options?: Record<string, unknown>
    ): Promise<T[]> {
        if (entity === "sales-channel") {
            return this.db.salesChannels as unknown as T[];
        }
        return [];
    }

    override async post<T = unknown>(endpoint: string, body?: unknown): Promise<T> {
        const b = (body as Record<string, unknown>) ?? {};

        if (endpoint === "search/category") {
            const filter =
                (b.filter as Array<{ field?: string; value?: unknown }> | undefined) ?? [];
            const name = filter.find((f) => f.field === "name")?.value as string | undefined;
            const parentId = filter.find((f) => f.field === "parentId")?.value as
                | string
                | null
                | undefined;
            let rows = this.db.categories;
            if (name !== undefined) rows = rows.filter((r) => r.name === name);
            if (parentId !== undefined) rows = rows.filter((r) => r.parentId === parentId);
            return { data: rows.slice(0, 50) } as unknown as T;
        }

        if (endpoint === "search/cms-page") {
            const filter =
                (b.filter as
                    | Array<{ type?: string; field?: string; value?: unknown }>
                    | undefined) ?? [];
            const name = filter.find((f) => f.field === "name" && f.type !== "contains")?.value as
                | string
                | undefined;
            const contains = filter.find((f) => f.type === "contains")?.value as string | undefined;
            let rows = this.db.cmsPages;
            if (contains) rows = rows.filter((r) => r.name.includes(contains));
            else if (name) rows = rows.filter((r) => r.name === name);
            return { data: rows.slice(0, 50) } as unknown as T;
        }

        if (endpoint === "search/sales-channel") {
            return { data: this.db.salesChannels } as unknown as T;
        }

        if (endpoint === "_action/sync") {
            const operations = b as Record<
                string,
                {
                    entity?: string;
                    action?: string;
                    payload?: Array<Record<string, unknown>>;
                }
            >;

            for (const op of Object.values(operations)) {
                if (!op.entity || !Array.isArray(op.payload)) continue;

                if (op.entity === "category" && op.action === "upsert") {
                    for (const payload of op.payload) {
                        const id = String(payload.id);
                        const existing = this.db.categories.find((c) => c.id === id);
                        const row: CategoryRow = {
                            id,
                            name: String(payload.name ?? existing?.name ?? ""),
                            parentId:
                                payload.parentId === undefined
                                    ? (existing?.parentId ?? null)
                                    : ((payload.parentId as string | null) ?? null),
                            cmsPageId: (payload.cmsPageId as string | null | undefined) ?? null,
                        };
                        if (existing) {
                            Object.assign(existing, row);
                        } else {
                            this.db.categories.push(row);
                        }
                    }
                }

                if (op.entity === "cms_page" && op.action === "upsert") {
                    for (const payload of op.payload) {
                        const id = String(payload.id);
                        const existing = this.db.cmsPages.find((p) => p.id === id);
                        const row: CmsPageRow = { id, name: String(payload.name) };
                        if (existing) {
                            Object.assign(existing, row);
                        } else {
                            this.db.cmsPages.push(row);
                        }
                    }
                }

                if (op.entity === "sales_channel" && op.action === "upsert") {
                    for (const payload of op.payload) {
                        const id = String(payload.id);
                        const existing = this.db.salesChannels.find((s) => s.id === id);
                        if (!existing) continue;
                        Object.assign(existing, payload);
                    }
                }
            }
            return {} as T;
        }

        return {} as T;
    }

    override async deleteEntity(entity: string, id: string): Promise<boolean> {
        if (entity === "category") {
            this.db.categories = this.db.categories.filter((c) => c.id !== id);
            return true;
        }
        if (entity === "cms-page" || entity === "cms_page") {
            this.db.cmsPages = this.db.cmsPages.filter((p) => p.id !== id);
            return true;
        }
        return true;
    }
}

function createContext(db: MockDb, dryRun = false): PostProcessorContext {
    const mockApi = new FooterMockApiHelpers(db);
    const { context } = createTestContext({
        mockApi,
        salesChannelId: "sc-1",
        salesChannelName: "store-one",
        blueprint: createTestBlueprint({
            salesChannel: { name: "store-one", description: "Store" },
        }),
        dryRun,
    });
    return context;
}

function createDb(): MockDb {
    return {
        categories: [],
        cmsPages: [
            { id: "cms-right-of-rescission", name: "Right of rescission" },
            { id: "cms-payment-shipping", name: "Payment / Shipping" },
            { id: "cms-privacy", name: "Privacy" },
            { id: "cms-terms", name: "Terms of service" },
            { id: "cms-imprint", name: "Imprint" },
        ],
        salesChannels: [
            {
                id: "sc-1",
                footerCategoryId: null,
                serviceCategoryId: null,
                serviceCmsPageId: null,
                revocationCmsPageId: null,
                paymentShippingCmsPageId: null,
                privacyCmsPageId: null,
                imprintCmsPageId: null,
            },
            {
                id: "sc-2",
                footerCategoryId: null,
                serviceCategoryId: null,
                serviceCmsPageId: null,
                revocationCmsPageId: null,
                paymentShippingCmsPageId: null,
                privacyCmsPageId: null,
                imprintCmsPageId: null,
            },
        ],
    };
}

describe("FooterPagesProcessor", () => {
    test("has expected metadata", () => {
        expect(FooterPagesProcessor.name).toBe("cms-footer-pages");
        expect(FooterPagesProcessor.dependsOn).toEqual([]);
    });

    test("dry-run performs no writes", async () => {
        const db = createDb();
        const context = createContext(db, true);

        const result = await FooterPagesProcessor.process(context);

        expect(result.errors).toEqual([]);
        expect(db.categories.length).toBe(0);
        expect(db.cmsPages.length).toBe(5);
    });

    test("creates both footer trees and assigns all sales channels", async () => {
        const db = createDb();
        const context = createContext(db, false);

        const result = await FooterPagesProcessor.process(context);

        expect(result.errors).toEqual([]);

        const footerRoot = db.categories.find(
            (c) => c.name === "Footer-Navigation" && c.parentId === null
        );
        const serviceRoot = db.categories.find(
            (c) => c.name === "Footer-Service-Navigation" && c.parentId === null
        );
        const customerServices = db.categories.find(
            (c) => c.name === "Customer Services" && c.parentId === footerRoot?.id
        );
        expect(footerRoot).toBeDefined();
        expect(serviceRoot).toBeDefined();
        expect(customerServices).toBeDefined();

        const customerChildren = db.categories.filter((c) => c.parentId === customerServices?.id);
        const serviceChildren = db.categories.filter((c) => c.parentId === serviceRoot?.id);
        expect(customerChildren.map((c) => c.name).sort()).toEqual([
            "Payment / Shipping",
            "Privacy",
            "Right of rescission",
        ]);
        expect(serviceChildren.map((c) => c.name).sort()).toEqual(["Imprint", "Terms of service"]);
        expect(customerChildren.every((c) => !!c.cmsPageId)).toBe(true);
        expect(serviceChildren.every((c) => !!c.cmsPageId)).toBe(true);

        for (const salesChannel of db.salesChannels) {
            expect(salesChannel.footerCategoryId).toBe(footerRoot?.id ?? null);
            expect(salesChannel.serviceCategoryId).toBe(serviceRoot?.id ?? null);
        }
    });

    test("is idempotent on repeated process run", async () => {
        const db = createDb();
        const context = createContext(db, false);

        await FooterPagesProcessor.process(context);
        const categoryCount = db.categories.length;
        const pageCount = db.cmsPages.length;
        await FooterPagesProcessor.process(context);

        expect(db.categories.length).toBe(categoryCount);
        expect(db.cmsPages.length).toBe(pageCount);
    });

    test("cleanup keeps shared roots when other sales channels still reference them", async () => {
        const db = createDb();
        const context = createContext(db, false);
        await FooterPagesProcessor.process(context);

        const cleanupResult = await FooterPagesProcessor.cleanup(context);
        expect(cleanupResult.errors).toEqual([]);

        const footerRoot = db.categories.find((c) => c.name === "Footer-Navigation");
        const serviceRoot = db.categories.find((c) => c.name === "Footer-Service-Navigation");
        expect(footerRoot).toBeDefined();
        expect(serviceRoot).toBeDefined();

        const currentSalesChannel = db.salesChannels.find((sc) => sc.id === "sc-1");
        expect(currentSalesChannel?.footerCategoryId).toBeNull();
        expect(currentSalesChannel?.serviceCategoryId).toBeNull();

        const otherSalesChannel = db.salesChannels.find((sc) => sc.id === "sc-2");
        expect(otherSalesChannel?.footerCategoryId).toBe(footerRoot?.id ?? null);
        expect(otherSalesChannel?.serviceCategoryId).toBe(serviceRoot?.id ?? null);
    });

    test("cleanup deletes managed trees when no sales channel references remain", async () => {
        const db = createDb();
        const context = createContext(db, false);
        await FooterPagesProcessor.process(context);

        for (const salesChannel of db.salesChannels) {
            salesChannel.footerCategoryId = null;
            salesChannel.serviceCategoryId = null;
            salesChannel.serviceCmsPageId = null;
            salesChannel.revocationCmsPageId = null;
            salesChannel.paymentShippingCmsPageId = null;
            salesChannel.privacyCmsPageId = null;
            salesChannel.imprintCmsPageId = null;
        }

        const cleanupResult = await FooterPagesProcessor.cleanup(context);
        expect(cleanupResult.errors).toEqual([]);

        expect(db.categories.length).toBe(0);
        expect(db.cmsPages.length).toBe(5);
    });
});
