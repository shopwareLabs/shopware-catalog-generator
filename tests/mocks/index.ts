export { createMockAdminClient, createMockAdminClientWithInvoke } from "./admin-client.mock.js";
export type { ApiCall, MockResponse } from "./api-helpers.mock.js";
export { createMockApiHelpers, MockApiHelpers } from "./api-helpers.mock.js";
export { createMockDataCache, MockDataCache, MockImageCache } from "./data-cache.mock.js";
export {
    FailingImageProvider,
    MockImageProvider,
    SlowImageProvider,
} from "./image-provider.mock.js";
export { createMockTextProviderWithProducts, MockTextProvider } from "./text-provider.mock.js";

import type { ProductMetadata } from "../../src/types/index.js";

/** Default product metadata for tests. */
const DEFAULT_MOCK_PRODUCT_METADATA: ProductMetadata = {
    imageCount: 1,
    imageDescriptions: [],
    isVariant: false,
    properties: [],
    reviewCount: 0,
    hasSalesPrice: false,
    hasTieredPricing: false,
    isTopseller: false,
    isNew: false,
    isShippingFree: false,
    weight: 1.0,
    width: 100,
    height: 100,
    length: 100,
    ean: "1234567890128",
    manufacturerNumber: "MPN-TEST0001",
};

/** Returns complete ProductMetadata with sensible defaults, accepting partial overrides. */
export function createMockProductMetadata(
    overrides: Partial<ProductMetadata> = {}
): ProductMetadata {
    return { ...DEFAULT_MOCK_PRODUCT_METADATA, ...overrides };
}
