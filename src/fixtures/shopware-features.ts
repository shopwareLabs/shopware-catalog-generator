/**
 * Shopware feature list - maps each optional Shopware feature the generator can
 * use to the first release that supports it.
 *
 * Check new entries against the Shopware source (`#[Entity(since: ...)]`,
 * `new Since(...)`, or the first release tag containing the field) before adding them.
 * Use `capabilities.supports("<key>")` at upload time; never drop data from blueprints.
 */

import type { ShopwareFeatureRequirement } from "../types/index.js";

/**
 * Oldest Shopware version the generator supports. Older shops still run, but
 * best-effort only: a warning is logged and failures are not treated as bugs.
 */
export const MIN_SUPPORTED_SHOPWARE_VERSION = "6.6.0.0";

/** Optional Shopware features, keyed by the name used in `supports()` */
export const SHOPWARE_FEATURES = {
    productType: {
        description: "product.type (physical/digital)",
        since: "6.7.7.0",
    },
    productTypeRequired: {
        description: "product.type is required when creating products",
        since: "6.8.0.0",
        flag: "v6.8.0.0",
    },
    measurementUnits: {
        description: "Measurement systems and per-domain measurement units",
        since: "6.7.1.0",
    },
    customFieldSearchable: {
        description: "custom_field.includeInSearch (custom field values in product search)",
        since: "6.7.7.0",
    },
    spatialMedia: {
        description: "3D models (.glb) in the product gallery with the 3D viewer",
        since: "6.6.0.0",
    },
    productVideo: {
        description: "Videos (.mp4/.webm) in the product gallery",
        since: "6.6.1.0",
    },
    productOpenGraph: {
        description: "product.ogTitle / ogDescription / openGraphMediaId (social sharing)",
        since: "6.7.10.0",
    },
} as const satisfies Record<string, ShopwareFeatureRequirement>;

/** Name of a feature in SHOPWARE_FEATURES */
export type ShopwareFeature = keyof typeof SHOPWARE_FEATURES;
