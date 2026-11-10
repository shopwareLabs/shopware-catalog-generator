/**
 * Checks for fields that only newer Shopware versions accept. Each one names its feature
 * in `requires`, so older lanes skip it instead of failing.
 */

import type { FeatureCheck, FeatureCheckOutcome } from "./types.js";

import { GIFT_CARD_50, PRODUCT_CUSTOM_FIELD_SET } from "../../../src/fixtures/index.js";
import { fail, pass, visibleIn } from "./types.js";

const productType: FeatureCheck = {
    name: "product-type",
    requires: "productType",
    async run(context): Promise<FeatureCheckOutcome> {
        const rows = await context.api.searchEntities<{
            productNumber?: string | null;
            type?: string | null;
        }>("product", [visibleIn(context.salesChannelId)], {
            includes: { product: ["id", "productNumber", "type"] },
        });
        const giftCard = rows.find((r) => r.productNumber === GIFT_CARD_50.productNumber);
        const others = rows.filter((r) => r !== giftCard);
        const notPhysical = others.filter((r) => r.type !== "physical");
        if (notPhysical.length > 0) {
            return fail(`${notPhysical.length}/${others.length} products are not "physical"`);
        }
        if (giftCard && giftCard.type !== GIFT_CARD_50.type) {
            return fail(`gift card has type "${giftCard.type}"`);
        }
        return pass(`${others.length} physical${giftCard ? ", gift card digital" : ""}`);
    },
};

const openGraph: FeatureCheck = {
    name: "open-graph",
    requires: "productOpenGraph",
    async run(context): Promise<FeatureCheckOutcome> {
        const rows = await context.api.searchEntities<{ ogTitle?: string | null }>(
            "product",
            [visibleIn(context.salesChannelId)],
            { includes: { product: ["id", "ogTitle"] } }
        );
        const withTitle = rows.filter((r) => r.ogTitle).length;
        if (withTitle === 0) return fail("no product has an ogTitle");
        return pass(`${withTitle}/${rows.length} products with ogTitle`);
    },
};

const imperialDomain: FeatureCheck = {
    name: "imperial-domain",
    requires: "measurementUnits",
    async run(context): Promise<FeatureCheckOutcome> {
        const domains = await context.api.searchEntities<{
            url?: string | null;
            measurementUnits?: { system?: string | null } | null;
        }>("sales-channel-domain", [
            { type: "equals", field: "salesChannelId", value: context.salesChannelId },
        ]);
        const imperial = domains.filter((d) => d.measurementUnits?.system === "imperial");
        if (imperial.length === 0) return fail("no domain uses imperial units");
        return pass(imperial.map((d) => d.url).join(", "));
    },
};

const searchableCustomField: FeatureCheck = {
    name: "searchable-custom-field",
    requires: "customFieldSearchable",
    async run(context): Promise<FeatureCheckOutcome> {
        const searchable = PRODUCT_CUSTOM_FIELD_SET.fields
            .filter((f) => f.includeInSearch)
            .map((f) => f.name);
        const rows = await context.api.searchEntities<{
            name?: string | null;
            includeInSearch?: boolean | null;
        }>("custom-field", [{ type: "equalsAny", field: "name", value: searchable }]);
        const off = searchable.filter(
            (name) => !rows.some((r) => r.name === name && r.includeInSearch === true)
        );
        if (off.length > 0) return fail(`not searchable: ${off.join(", ")}`);
        return pass(searchable.join(", "));
    },
};

export const VERSION_CHECKS: readonly FeatureCheck[] = [
    productType,
    openGraph,
    imperialDomain,
    searchableCustomField,
];
