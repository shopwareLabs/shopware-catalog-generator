import { describe, expect, test } from "bun:test";

import type { PostProcessorContext } from "../../../../src/post-processors/index.js";

import { FooterPagesProcessor } from "../../../../src/post-processors/cms/footer-pages-processor.js";

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

function createContext(db: MockDb, dryRun = false): PostProcessorContext {
    const mockFetch = async (
        input: string | URL | Request,
        init?: RequestInit
    ): Promise<Response> => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";

        if (method === "DELETE") {
            const parts = url.split("/");
            const id = parts[parts.length - 1];
            const entity = parts[parts.length - 2];

            if (entity === "category") {
                db.categories = db.categories.filter((c) => c.id !== id);
            }
            if (entity === "cms-page") {
                db.cmsPages = db.cmsPages.filter((p) => p.id !== id);
            }
            return new Response(null, { status: 204 });
        }

        const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};

        if (url.includes("/api/search/category")) {
            const filter = (body.filter as Array<{ field?: string; value?: unknown }>) ?? [];
            const name = filter.find((f) => f.field === "name")?.value as string | undefined;
            const parentId = (filter.find((f) => f.field === "parentId")?.value ?? undefined) as
                | string
                | null
                | undefined;
            let rows = db.categories;
            if (name !== undefined) rows = rows.filter((r) => r.name === name);
            if (parentId !== undefined) rows = rows.filter((r) => r.parentId === parentId);
            return Response.json({ data: rows.slice(0, 50) });
        }

        if (url.includes("/api/search/cms-page")) {
            const filter =
                (body.filter as Array<{ type?: string; field?: string; value?: unknown }>) ?? [];
            const name = filter.find((f) => f.field === "name")?.value as string | undefined;
            const contains = filter.find((f) => f.field === "name")?.value as string | undefined;
            const queryType = (filter[0]?.type as string | undefined) ?? "equals";
            const rows =
                queryType === "contains" && contains
                    ? db.cmsPages.filter((r) => r.name.includes(contains))
                    : name
                      ? db.cmsPages.filter((r) => r.name === name)
                      : db.cmsPages;
            return Response.json({ data: rows.slice(0, 50) });
        }

        if (url.includes("/api/search/sales-channel")) {
            return Response.json({ data: db.salesChannels });
        }

        if (url.includes("/api/_action/sync")) {
            for (const op of Object.values(body)) {
                const operation = op as {
                    entity?: string;
                    action?: string;
                    payload?: Array<Record<string, unknown>>;
                };
                if (!operation.entity || !Array.isArray(operation.payload)) continue;

                if (operation.entity === "category" && operation.action === "upsert") {
                    for (const payload of operation.payload) {
                        const id = String(payload.id);
                        const existing = db.categories.find((c) => c.id === id);
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
                            db.categories.push(row);
                        }
                    }
                }

                if (operation.entity === "cms_page" && operation.action === "upsert") {
                    for (const payload of operation.payload) {
                        const id = String(payload.id);
                        const existing = db.cmsPages.find((p) => p.id === id);
                        const row: CmsPageRow = { id, name: String(payload.name) };
                        if (existing) {
                            Object.assign(existing, row);
                        } else {
                            db.cmsPages.push(row);
                        }
                    }
                }

                if (operation.entity === "sales_channel" && operation.action === "upsert") {
                    for (const payload of operation.payload) {
                        const id = String(payload.id);
                        const existing = db.salesChannels.find((s) => s.id === id);
                        if (!existing) continue;
                        Object.assign(existing, payload);
                    }
                }
            }
            return Response.json({});
        }

        return Response.json({ data: [] });
    };
    globalThis.fetch = mockFetch as typeof fetch;

    return {
        salesChannelId: "sc-1",
        salesChannelName: "store-one",
        blueprint: {
            version: "1.0",
            createdAt: new Date().toISOString(),
            hydratedAt: new Date().toISOString(),
            salesChannel: { name: "store-one", description: "Store" },
            categories: [],
            products: [],
            propertyGroups: [],
        },
        cache: {
            getSalesChannelDir: () => "/tmp/test",
            loadCmsBlueprint: () => null,
        } as unknown as PostProcessorContext["cache"],
        shopwareUrl: "https://example.test",
        getAccessToken: async () => "token",
        options: { batchSize: 5, dryRun },
    };
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
