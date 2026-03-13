import { mock } from "bun:test";

import type { DataCacheApi, ImageCacheApi } from "../../src/cache.js";
import type { MediaType } from "../../src/image-cache.js";
import type { CmsBlueprint, Manufacturer, ProductMetadata } from "../../src/types/index.js";

/**
 * Mock image cache for testing.
 *
 * Supports configuring which images are "cached" via cachedImages/staleImages sets.
 */
export class MockImageCache implements ImageCacheApi {
    private readonly cachedImages: Set<string>;
    private readonly staleImages: Set<string>;

    constructor(options: { cachedImages?: Set<string>; staleImages?: Set<string> } = {}) {
        this.cachedImages = options.cachedImages ?? new Set();
        this.staleImages = options.staleImages ?? new Set();
    }

    readonly hasImageWithViewMock = mock(
        (_sc: string, _id: string, _view: string, _type?: MediaType) => false
    );
    readonly loadImageWithViewMock = mock(
        (_sc: string, _id: string, _view: string, _type?: MediaType) => null as string | null
    );
    readonly loadImageForSalesChannelMock = mock(
        (_sc: string, _id: string, _type?: MediaType) => null as string | null
    );

    hasImageWithView(
        _salesChannel: string,
        entityId: string,
        view: string,
        _mediaType?: MediaType
    ): boolean {
        this.hasImageWithViewMock(_salesChannel, entityId, view, _mediaType);
        return this.cachedImages.has(`${entityId}-${view}`);
    }

    loadImageWithView(
        _salesChannel: string,
        entityId: string,
        view: string,
        _mediaType?: MediaType
    ): string | null {
        this.loadImageWithViewMock(_salesChannel, entityId, view, _mediaType);
        if (this.staleImages.has(`${entityId}-${view}`)) return null;
        if (this.cachedImages.has(`${entityId}-${view}`)) {
            return Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
        }
        return null;
    }

    loadImageForSalesChannel(
        _salesChannel: string,
        entityId: string,
        _mediaType?: MediaType
    ): string | null {
        this.loadImageForSalesChannelMock(_salesChannel, entityId, _mediaType);
        if (this.cachedImages.has(entityId)) {
            return Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
        }
        return null;
    }
}

/**
 * Mock data cache for testing post-processors.
 *
 * Allows configuring product metadata, manufacturers, CMS blueprints, and image availability.
 */
export class MockDataCache implements DataCacheApi {
    readonly images: MockImageCache;
    private readonly metadataMap: Map<string, Partial<ProductMetadata>>;
    private readonly manufacturers: Array<{ id: string; name: string }>;

    readonly loadProductMetadataMock = mock(
        (_sc: string, _id: string) => null as ProductMetadata | null
    );
    readonly saveManufacturersMock = mock((_sc: string, _mfgs: Manufacturer[]) => undefined);
    readonly loadManufacturersMock = mock((_sc: string) => null as Manufacturer[] | null);
    readonly loadCmsBlueprintMock = mock((_sc: string) => null as CmsBlueprint | null);

    constructor(
        options: {
            metadataMap?: Map<string, Partial<ProductMetadata>>;
            cachedImages?: Set<string>;
            staleImages?: Set<string>;
        } = {}
    ) {
        this.metadataMap = options.metadataMap ?? new Map();
        this.manufacturers = [];
        this.images = new MockImageCache({
            cachedImages: options.cachedImages,
            staleImages: options.staleImages,
        });
    }

    getSalesChannelDir(_salesChannel: string): string {
        return `/tmp/mock-cache/${_salesChannel}`;
    }

    loadCmsBlueprint(_salesChannel: string): CmsBlueprint | null {
        this.loadCmsBlueprintMock(_salesChannel);
        return null;
    }

    loadProductMetadata(_salesChannel: string, productId: string): ProductMetadata | null {
        this.loadProductMetadataMock(_salesChannel, productId);
        const partial = this.metadataMap.get(productId);
        if (!partial) return null;
        return {
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
            ...partial,
        } satisfies ProductMetadata;
    }

    saveManufacturers(_salesChannel: string, mfgs: Manufacturer[]): void {
        this.saveManufacturersMock(_salesChannel, mfgs);
        this.manufacturers.push(...mfgs);
    }

    loadManufacturers(_salesChannel: string): Manufacturer[] | null {
        this.loadManufacturersMock(_salesChannel);
        return this.manufacturers.length > 0 ? [...this.manufacturers] : null;
    }
}

/** Create a pre-configured mock data cache */
export function createMockDataCache(
    options: {
        metadataMap?: Map<string, Partial<ProductMetadata>>;
        cachedImages?: Set<string>;
        staleImages?: Set<string>;
    } = {}
): MockDataCache {
    return new MockDataCache(options);
}
