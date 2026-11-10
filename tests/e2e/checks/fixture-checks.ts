/**
 * Checks for the fixture-based processors: digital product, media showcase, customers,
 * cross-selling, reviews and footer pages.
 */

import type { FeatureCheck, FeatureCheckOutcome } from "./types.js";

import {
    DEMO_CUSTOMERS,
    GIFT_CARD_50,
    MEDIA_SHOWCASE_FILES,
    MEDIA_SHOWCASE_PRODUCT,
} from "../../../src/fixtures/index.js";
import { fail, pass, visibleIn } from "./types.js";

interface MediaRow {
    id: string;
    media?: Array<{ media?: { fileExtension?: string | null } | null }> | null;
}

const digitalProduct: FeatureCheck = {
    name: "digital-product",
    async run(context): Promise<FeatureCheckOutcome> {
        const rows = await context.api.searchEntities<{ id: string }>(
            "product",
            [
                visibleIn(context.salesChannelId),
                { type: "equals", field: "productNumber", value: GIFT_CARD_50.productNumber },
            ],
            { associations: { downloads: {} } }
        );
        if (rows.length === 0) return fail(`${GIFT_CARD_50.productNumber} not in the SalesChannel`);
        return pass(GIFT_CARD_50.productNumber);
    },
};

/** Count of gallery files per extension, e.g. { glb: 2, mp4: 2 } */
function countExtensions(row: MediaRow | undefined): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of row?.media ?? []) {
        const extension = entry.media?.fileExtension ?? "";
        counts[extension] = (counts[extension] ?? 0) + 1;
    }
    return counts;
}

const mediaShowcase: FeatureCheck = {
    name: "media-showcase",
    requires: "spatialMedia",
    async run(context): Promise<FeatureCheckOutcome> {
        const [row] = await context.api.searchEntities<MediaRow>(
            "product",
            [
                visibleIn(context.salesChannelId),
                {
                    type: "equals",
                    field: "productNumber",
                    value: MEDIA_SHOWCASE_PRODUCT.productNumber,
                },
            ],
            { associations: { media: { associations: { media: {} } } } }
        );
        if (!row) return fail(`${MEDIA_SHOWCASE_PRODUCT.productNumber} not in the SalesChannel`);

        // Only files the shop can display are uploaded (videos need 6.6.1)
        const expected = MEDIA_SHOWCASE_FILES.filter((f) => context.shopware.supports(f.feature));
        const actual = countExtensions(row);
        const missing = [...new Set(expected.map((f) => f.extension))].filter(
            (ext) => (actual[ext] ?? 0) < expected.filter((f) => f.extension === ext).length
        );
        if (missing.length > 0) return fail(`missing ${missing.join(", ")} files in the gallery`);
        return pass(
            Object.entries(actual)
                .map(([ext, n]) => `${n} ${ext}`)
                .join(", ")
        );
    },
};

const customers: FeatureCheck = {
    name: "customers",
    async run(context): Promise<FeatureCheckOutcome> {
        const emails = DEMO_CUSTOMERS.map((c) => c.email);
        const rows = await context.api.searchEntities<{ email?: string | null }>(
            "customer",
            [{ type: "equalsAny", field: "email", value: emails }],
            { includes: { customer: ["id", "email"] } }
        );
        const found = new Set(rows.map((r) => r.email));
        const missing = emails.filter((email) => !found.has(email));
        if (missing.length > 0) return fail(`missing ${missing.join(", ")}`);
        return pass(`${emails.length} demo customers`);
    },
};

const crossSelling: FeatureCheck = {
    name: "cross-selling",
    async run(context): Promise<FeatureCheckOutcome> {
        const rows = await context.api.searchEntities<{ id: string }>(
            "product-cross-selling",
            [
                {
                    type: "equals",
                    field: "product.visibilities.salesChannelId",
                    value: context.salesChannelId,
                },
            ],
            { includes: { product_cross_selling: ["id"] } }
        );
        if (rows.length === 0) return fail("no cross-selling groups");
        return pass(`${rows.length} cross-selling groups`);
    },
};

const reviews: FeatureCheck = {
    name: "reviews",
    async run(context): Promise<FeatureCheckOutcome> {
        const rows = await context.api.searchEntities<{ id: string }>(
            "product-review",
            [{ type: "equals", field: "salesChannelId", value: context.salesChannelId }],
            { includes: { product_review: ["id"] } }
        );
        if (rows.length === 0) return fail("no reviews");
        return pass(`${rows.length} reviews`);
    },
};

const footerPages: FeatureCheck = {
    name: "footer-pages",
    async run(context): Promise<FeatureCheckOutcome> {
        const [salesChannel] = await context.api.searchEntities<{
            footerCategoryId?: string | null;
        }>("sales-channel", [], {
            ids: [context.salesChannelId],
            includes: { sales_channel: ["id", "footerCategoryId"] },
        });
        if (!salesChannel?.footerCategoryId) return fail("SalesChannel has no footer category");
        return pass("footer category set");
    },
};

export const FIXTURE_CHECKS: readonly FeatureCheck[] = [
    digitalProduct,
    mediaShowcase,
    customers,
    crossSelling,
    reviews,
    footerPages,
];
