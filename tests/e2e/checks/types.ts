import type { DataCacheApi } from "../../../src/cache.js";
import type { ShopwareFeature } from "../../../src/fixtures/index.js";
import type { ShopwareApi } from "../../../src/shopware/api-helpers.js";
import type { ShopwareCapabilities } from "../../../src/shopware/index.js";
import type { HydratedBlueprint } from "../../../src/types/index.js";

/** Everything a feature check needs: API, shop capabilities and the expected data */
export interface FeatureCheckContext {
    api: Pick<ShopwareApi, "searchEntities">;
    shopware: ShopwareCapabilities;
    salesChannelId: string;
    salesChannelName: string;
    blueprint: HydratedBlueprint;
    cache: Pick<DataCacheApi, "loadProductMetadata" | "images">;
}

export type FeatureCheckStatus = "pass" | "fail" | "skip";

export interface FeatureCheckOutcome {
    status: FeatureCheckStatus;
    detail: string;
}

/** Result of one check, written to verify.json */
export interface FeatureCheckResult extends FeatureCheckOutcome {
    name: string;
}

/**
 * One end-to-end check of a generator feature.
 *
 * `requires` names the Shopware feature (src/fixtures/shopware-features.ts) the check
 * depends on. On shops without it the check is skipped, because the upload leaves the
 * field out there too.
 */
export interface FeatureCheck {
    readonly name: string;
    readonly requires?: ShopwareFeature;
    run(context: FeatureCheckContext): Promise<FeatureCheckOutcome>;
}

export function pass(detail: string): FeatureCheckOutcome {
    return { status: "pass", detail };
}

export function fail(detail: string): FeatureCheckOutcome {
    return { status: "fail", detail };
}

export function skip(detail: string): FeatureCheckOutcome {
    return { status: "skip", detail };
}

/** Filter for products visible in the SalesChannel (parents; variants inherit it) */
export function visibleIn(salesChannelId: string): {
    type: "equals";
    field: string;
    value: string;
} {
    return { type: "equals", field: "visibilities.salesChannelId", value: salesChannelId };
}
