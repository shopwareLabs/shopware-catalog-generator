import { describe, expect, test } from "bun:test";

import type { HydratedBlueprint, ProductMetadata } from "../../../../src/types/index.js";

import {
    buildCmsImageSpecs,
    hydrateCmsImages,
    hydrateProductImages,
} from "../../../../src/blueprint/hydrators/image.js";
import { DataCache } from "../../../../src/cache.js";
import { NoOpImageProvider } from "../../../../src/providers/noop-provider.js";
import { FailingImageProvider, MockImageProvider } from "../../../mocks/image-provider.mock.js";

function createTestCache(): DataCache {
    return new DataCache({
        cacheDir: "/tmp/test-image-hydrator-" + Date.now(),
        enabled: true,
        useCache: true,
    });
}

describe("buildCmsImageSpecs", () => {
    test("returns 20 image specs", () => {
        const specs = buildCmsImageSpecs("music", "Musical instruments");
        expect(specs).toHaveLength(20);
    });

    test("all specs have required fields", () => {
        const specs = buildCmsImageSpecs("beauty", "Beauty products");

        for (const spec of specs) {
            expect(spec.key).toBeDefined();
            expect(spec.key.length).toBeGreaterThan(0);
            expect(spec.prompt).toBeDefined();
            expect(spec.prompt.length).toBeGreaterThan(0);
            expect(spec.width).toBeGreaterThan(0);
            expect(spec.height).toBeGreaterThan(0);
        }
    });

    test("all keys are unique", () => {
        const specs = buildCmsImageSpecs("test", "Test store");
        const keys = specs.map((s) => s.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    test("includes home hero image", () => {
        const specs = buildCmsImageSpecs("music", "Musical instruments");
        const hero = specs.find((s) => s.key === "home-hero");
        expect(hero).toBeDefined();
        expect(hero!.width).toBe(800);
        expect(hero!.height).toBe(800);
    });

    test("includes 5 slider images", () => {
        const specs = buildCmsImageSpecs("music", "Musical instruments");
        const sliders = specs.filter((s) => s.key.startsWith("img-slider-"));
        expect(sliders).toHaveLength(5);

        for (const s of sliders) {
            expect(s.width).toBe(1920);
            expect(s.height).toBe(1080);
        }
    });

    test("includes 6 gallery images", () => {
        const specs = buildCmsImageSpecs("music", "Musical instruments");
        const galleries = specs.filter((s) => s.key.startsWith("img-gallery-"));
        expect(galleries).toHaveLength(6);

        for (const g of galleries) {
            expect(g.width).toBe(1200);
            expect(g.height).toBe(1200);
        }
    });

    test("includes text-images page keys", () => {
        const specs = buildCmsImageSpecs("music", "Musical instruments");
        const keys = specs.map((s) => s.key);

        expect(keys).toContain("ti-left");
        expect(keys).toContain("ti-right");
        expect(keys).toContain("ct-left");
        expect(keys).toContain("ct-right");
        expect(keys).toContain("bubble-left");
        expect(keys).toContain("bubble-center");
        expect(keys).toContain("bubble-right");
        expect(keys).toContain("toi-bg");
    });

    test("prompts contain store description", () => {
        const specs = buildCmsImageSpecs("music", "Musical instruments and gear");

        for (const spec of specs) {
            expect(spec.prompt).toContain("Musical instruments and gear");
        }
    });

    test("home hero prompt contains store name", () => {
        const specs = buildCmsImageSpecs("music", "Musical instruments");
        const hero = specs.find((s) => s.key === "home-hero");
        expect(hero!.prompt).toContain("music");
    });
});

describe("hydrateCmsImages", () => {
    test("generates all images when cache is empty", async () => {
        const imageProvider = new MockImageProvider();
        const cache = createTestCache();

        const result = await hydrateCmsImages(imageProvider, cache, "test-store", "Test products");

        expect(result.total).toBe(20);
        expect(result.generated).toBe(20);
        expect(result.skipped).toBe(0);
        expect(result.failed).toBe(0);
        expect(imageProvider.callCount).toBe(20);
    });

    test("skips images already in cache", async () => {
        const imageProvider = new MockImageProvider();
        const cache = createTestCache();

        // Pre-populate 5 images in cache
        for (let i = 0; i < 5; i++) {
            cache.images.saveImageForSalesChannel(
                "test-store",
                `img-slider-${i}`,
                `img-slider-${i}`,
                "dGVzdA==",
                "test prompt",
                undefined,
                "cms_media"
            );
        }

        const result = await hydrateCmsImages(imageProvider, cache, "test-store", "Test products");

        expect(result.total).toBe(20);
        expect(result.skipped).toBe(5);
        expect(result.generated).toBe(15);
        expect(result.failed).toBe(0);
        expect(imageProvider.callCount).toBe(15);
    });

    test("skips all when fully cached", async () => {
        const imageProvider = new MockImageProvider();
        const cache = createTestCache();
        const specs = buildCmsImageSpecs("test-store", "Test products");

        for (const spec of specs) {
            cache.images.saveImageForSalesChannel(
                "test-store",
                spec.key,
                spec.key,
                "dGVzdA==",
                "test prompt",
                undefined,
                "cms_media"
            );
        }

        const result = await hydrateCmsImages(imageProvider, cache, "test-store", "Test products");

        expect(result.total).toBe(20);
        expect(result.skipped).toBe(20);
        expect(result.generated).toBe(0);
        expect(result.failed).toBe(0);
        expect(imageProvider.callCount).toBe(0);
    });

    test("handles NoOpImageProvider gracefully", async () => {
        const imageProvider = new NoOpImageProvider();
        const cache = createTestCache();

        const result = await hydrateCmsImages(imageProvider, cache, "test-store", "Test products");

        expect(result.total).toBe(20);
        expect(result.generated).toBe(0);
        expect(result.failed).toBe(20);
    });

    test("handles FailingImageProvider gracefully", async () => {
        const imageProvider = new FailingImageProvider();
        const cache = createTestCache();

        const result = await hydrateCmsImages(imageProvider, cache, "test-store", "Test products");

        expect(result.total).toBe(20);
        expect(result.generated).toBe(0);
        expect(result.failed).toBe(20);
    });

    test("passes correct dimensions to image provider", async () => {
        const imageProvider = new MockImageProvider();
        const cache = createTestCache();

        await hydrateCmsImages(imageProvider, cache, "test-store", "Test products");

        const calls = imageProvider.getCalls();
        const sliderCalls = calls.filter((c) => c.prompt.includes("Slide"));
        const galleryCalls = calls.filter((c) => c.prompt.includes("Gallery item"));
        const heroCalls = calls.filter((c) => c.prompt.includes("promotional banner"));

        for (const call of sliderCalls) {
            expect(call.options?.width).toBe(1920);
            expect(call.options?.height).toBe(1080);
        }

        for (const call of galleryCalls) {
            expect(call.options?.width).toBe(1200);
            expect(call.options?.height).toBe(1200);
        }

        for (const call of heroCalls) {
            expect(call.options?.width).toBe(800);
            expect(call.options?.height).toBe(800);
        }
    });
});

// =============================================================================
// hydrateProductImages tests
// =============================================================================

function createMinimalBlueprint(
    products: Array<{ id: string; name: string }>,
    categories: HydratedBlueprint["categories"] = []
): HydratedBlueprint {
    return {
        version: "1.0",
        salesChannel: { name: "test-store", description: "Test store" },
        categories,
        products: products.map((p) => ({
            id: p.id,
            name: p.name,
            description: "Test description",
            price: 29.99,
            stock: 10,
            primaryCategoryId: "cat1",
            categoryIds: ["cat1"],
            metadata: {
                imageCount: 1 as const,
                imageDescriptions: [],
                isVariant: false,
                properties: [],
                reviewCount: 0 as const,
                hasSalesPrice: false,
            },
        })),
        propertyGroups: [],
        createdAt: new Date().toISOString(),
        hydratedAt: new Date().toISOString(),
    };
}

function saveProductMetadata(
    cache: DataCache,
    salesChannel: string,
    productId: string,
    metadata: Partial<ProductMetadata>
): void {
    const full: ProductMetadata = {
        imageCount: 1,
        imageDescriptions: [],
        isVariant: false,
        properties: [],
        reviewCount: 0 as const,
        hasSalesPrice: false,
        ...metadata,
    };
    cache.saveProductMetadata(salesChannel, productId, full);
}

describe("hydrateProductImages", () => {
    test("generates images for products with metadata", async () => {
        const imageProvider = new MockImageProvider();
        const cache = createTestCache();
        const blueprint = createMinimalBlueprint([
            { id: "p1", name: "Guitar" },
            { id: "p2", name: "Piano" },
        ]);

        saveProductMetadata(cache, "test-store", "p1", {
            baseImagePrompt: "A high-quality guitar",
            imageDescriptions: [
                { view: "front", prompt: "Guitar front view" },
                { view: "side", prompt: "Guitar side view" },
            ],
        });
        saveProductMetadata(cache, "test-store", "p2", {
            baseImagePrompt: "A grand piano",
            imageDescriptions: [{ view: "front", prompt: "Piano front view" }],
        });

        const result = await hydrateProductImages(imageProvider, cache, "test-store", blueprint);

        expect(result.generated).toBe(3);
        expect(result.skipped).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.total).toBe(3);
        expect(imageProvider.callCount).toBe(3);
    });

    test("skips products without metadata", async () => {
        const imageProvider = new MockImageProvider();
        const cache = createTestCache();
        const blueprint = createMinimalBlueprint([{ id: "p1", name: "Guitar" }]);

        const result = await hydrateProductImages(imageProvider, cache, "test-store", blueprint);

        expect(result.generated).toBe(0);
        expect(result.skipped).toBe(0);
        expect(result.total).toBe(0);
        expect(imageProvider.callCount).toBe(0);
    });

    test("skips images already in cache", async () => {
        const imageProvider = new MockImageProvider();
        const cache = createTestCache();
        const blueprint = createMinimalBlueprint([{ id: "p1", name: "Guitar" }]);

        saveProductMetadata(cache, "test-store", "p1", {
            baseImagePrompt: "A guitar",
            imageDescriptions: [
                { view: "front", prompt: "Guitar front" },
                { view: "side", prompt: "Guitar side" },
            ],
        });

        // Pre-cache the front view
        cache.images.saveImageWithView(
            "test-store",
            "p1",
            "front",
            "dGVzdA==",
            "A guitar",
            "mock",
            "product_media"
        );

        const result = await hydrateProductImages(imageProvider, cache, "test-store", blueprint);

        expect(result.generated).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.total).toBe(2);
        expect(imageProvider.callCount).toBe(1);
    });

    test("detects and regenerates stale images", async () => {
        const imageProvider = new MockImageProvider();
        const cache = createTestCache();
        const blueprint = createMinimalBlueprint([{ id: "p1", name: "Guitar" }]);

        saveProductMetadata(cache, "test-store", "p1", {
            baseImagePrompt: "A new guitar prompt",
            imageDescriptions: [{ view: "front", prompt: "Guitar front" }],
        });

        // Save image with old prompt (stale)
        cache.images.saveImageWithView(
            "test-store",
            "p1",
            "front",
            "dGVzdA==",
            "An old guitar prompt",
            "mock",
            "product_media"
        );

        const result = await hydrateProductImages(imageProvider, cache, "test-store", blueprint);

        expect(result.stale).toBe(1);
        expect(result.generated).toBe(1);
        expect(result.skipped).toBe(0);
    });

    test("generates category banner images", async () => {
        const imageProvider = new MockImageProvider();
        const cache = createTestCache();

        const categories: HydratedBlueprint["categories"] = [
            {
                id: "cat1",
                name: "Guitars",
                description: "Guitar category",
                level: 1,
                hasImage: true,
                imageDescription: "A banner showing guitars",
                children: [],
            },
            {
                id: "cat2",
                name: "Pianos",
                description: "Piano category",
                level: 1,
                hasImage: false,
                children: [],
            },
        ];

        const blueprint = createMinimalBlueprint([], categories);

        const result = await hydrateProductImages(imageProvider, cache, "test-store", blueprint);

        expect(result.generated).toBe(1);
        expect(result.skipped).toBe(0);
        expect(result.total).toBe(1);
    });

    test("handles NoOpImageProvider gracefully", async () => {
        const imageProvider = new NoOpImageProvider();
        const cache = createTestCache();
        const blueprint = createMinimalBlueprint([{ id: "p1", name: "Guitar" }]);

        saveProductMetadata(cache, "test-store", "p1", {
            baseImagePrompt: "A guitar",
            imageDescriptions: [{ view: "front", prompt: "Guitar front" }],
        });

        const result = await hydrateProductImages(imageProvider, cache, "test-store", blueprint);

        expect(result.generated).toBe(0);
        expect(result.failed).toBe(1);
        expect(result.total).toBe(1);
    });

    test("reports all when fully cached", async () => {
        const imageProvider = new MockImageProvider();
        const cache = createTestCache();
        const blueprint = createMinimalBlueprint([{ id: "p1", name: "Guitar" }]);

        saveProductMetadata(cache, "test-store", "p1", {
            baseImagePrompt: "A guitar",
            imageDescriptions: [{ view: "front", prompt: "Guitar front" }],
        });

        cache.images.saveImageWithView(
            "test-store",
            "p1",
            "front",
            "dGVzdA==",
            "A guitar",
            "mock",
            "product_media"
        );

        const result = await hydrateProductImages(imageProvider, cache, "test-store", blueprint);

        expect(result.generated).toBe(0);
        expect(result.skipped).toBe(1);
        expect(result.total).toBe(1);
        expect(imageProvider.callCount).toBe(0);
    });
});
