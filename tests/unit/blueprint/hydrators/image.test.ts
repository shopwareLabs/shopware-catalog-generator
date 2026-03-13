import { describe, expect, test } from "bun:test";

import type { HydratedBlueprint } from "../../../../src/types/index.js";

import {
    buildCmsImageSpecs,
    buildThemeImageSpecs,
    hydrateCmsImages,
    hydrateProductImages,
    hydrateThemeMedia,
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

type TestProduct = {
    id: string;
    name: string;
    baseImagePrompt?: string;
    imageDescriptions?: HydratedBlueprint["products"][number]["metadata"]["imageDescriptions"];
};

function createMinimalBlueprint(
    products: TestProduct[],
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
                imageDescriptions: p.imageDescriptions ?? [],
                baseImagePrompt: p.baseImagePrompt,
                isVariant: false,
                properties: [],
                reviewCount: 0 as const,
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
            },
        })),
        propertyGroups: [],
        createdAt: new Date().toISOString(),
        hydratedAt: new Date().toISOString(),
    };
}

describe("hydrateProductImages", () => {
    test("generates images for products with metadata on the blueprint", async () => {
        const imageProvider = new MockImageProvider();
        const cache = createTestCache();
        // imageDescriptions live on the blueprint in-memory (not pre-written to disk),
        // matching the real call order in blueprint-service.ts where hydrateProductImages
        // runs before saveHydratedBlueprint writes metadata files.
        const blueprint = createMinimalBlueprint([
            {
                id: "p1",
                name: "Guitar",
                baseImagePrompt: "A high-quality guitar",
                imageDescriptions: [
                    { view: "front", prompt: "Guitar front view" },
                    { view: "side", prompt: "Guitar side view" },
                ],
            },
            {
                id: "p2",
                name: "Piano",
                baseImagePrompt: "A grand piano",
                imageDescriptions: [{ view: "front", prompt: "Piano front view" }],
            },
        ]);

        const result = await hydrateProductImages(imageProvider, cache, "test-store", blueprint);

        expect(result.generated).toBe(3);
        expect(result.skipped).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.total).toBe(3);
        expect(imageProvider.callCount).toBe(3);
    });

    test("skips products with no imageDescriptions", async () => {
        const imageProvider = new MockImageProvider();
        const cache = createTestCache();
        const blueprint = createMinimalBlueprint([{ id: "p1", name: "Guitar" }]);
        // imageDescriptions defaults to [] — no tasks expected

        const result = await hydrateProductImages(imageProvider, cache, "test-store", blueprint);

        expect(result.generated).toBe(0);
        expect(result.skipped).toBe(0);
        expect(result.total).toBe(0);
        expect(imageProvider.callCount).toBe(0);
    });

    test("skips images already in cache", async () => {
        const imageProvider = new MockImageProvider();
        const cache = createTestCache();
        const blueprint = createMinimalBlueprint([
            {
                id: "p1",
                name: "Guitar",
                baseImagePrompt: "A guitar",
                imageDescriptions: [
                    { view: "front", prompt: "Guitar front" },
                    { view: "side", prompt: "Guitar side" },
                ],
            },
        ]);

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
        const blueprint = createMinimalBlueprint([
            {
                id: "p1",
                name: "Guitar",
                baseImagePrompt: "A new guitar prompt",
                imageDescriptions: [{ view: "front", prompt: "Guitar front" }],
            },
        ]);

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
        const blueprint = createMinimalBlueprint([
            {
                id: "p1",
                name: "Guitar",
                baseImagePrompt: "A guitar",
                imageDescriptions: [{ view: "front", prompt: "Guitar front" }],
            },
        ]);

        const result = await hydrateProductImages(imageProvider, cache, "test-store", blueprint);

        expect(result.generated).toBe(0);
        expect(result.failed).toBe(1);
        expect(result.total).toBe(1);
    });

    test("reports all when fully cached", async () => {
        const imageProvider = new MockImageProvider();
        const cache = createTestCache();
        const blueprint = createMinimalBlueprint([
            {
                id: "p1",
                name: "Guitar",
                baseImagePrompt: "A guitar",
                imageDescriptions: [{ view: "front", prompt: "Guitar front" }],
            },
        ]);

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

// =============================================================================
// Theme Media Tests
// =============================================================================

describe("buildThemeImageSpecs", () => {
    test("returns 3 specs: logo, favicon, share", () => {
        const specs = buildThemeImageSpecs("beauty", "Beauty products");
        expect(specs).toHaveLength(3);

        const keys = specs.map((s) => s.key);
        expect(keys).toContain("store-logo");
        expect(keys).toContain("store-favicon");
        expect(keys).toContain("store-share");
    });

    test("logo has compact landscape dimensions", () => {
        const specs = buildThemeImageSpecs("music", "Musical instruments");
        const logo = specs.find((s) => s.key === "store-logo");
        expect(logo).toBeDefined();
        expect(logo!.width).toBe(474);
        expect(logo!.height).toBe(70);
        expect(logo!.width).toBeGreaterThan(logo!.height);
    });

    test("favicon is square", () => {
        const specs = buildThemeImageSpecs("music", "Musical instruments");
        const favicon = specs.find((s) => s.key === "store-favicon");
        expect(favicon).toBeDefined();
        expect(favicon!.width).toBe(96);
        expect(favicon!.height).toBe(96);
    });

    test("share icon has og:image dimensions", () => {
        const specs = buildThemeImageSpecs("music", "Musical instruments");
        const share = specs.find((s) => s.key === "store-share");
        expect(share).toBeDefined();
        expect(share!.width).toBe(1200);
        expect(share!.height).toBe(630);
    });

    test("prompts include store description", () => {
        const specs = buildThemeImageSpecs("garden-store", "Plants and garden accessories");

        for (const spec of specs) {
            expect(spec.prompt).toContain("Plants and garden accessories");
        }
    });

    test("logo and favicon are transparent, share is not", () => {
        const specs = buildThemeImageSpecs("music", "Musical instruments");
        const logo = specs.find((s) => s.key === "store-logo");
        const favicon = specs.find((s) => s.key === "store-favicon");
        const share = specs.find((s) => s.key === "store-share");
        expect(logo!.transparent).toBe(true);
        expect(favicon!.transparent).toBe(true);
        expect(share!.transparent).toBeUndefined();
    });

    test("logo uses fitHeight mode for optimal header sizing", () => {
        const specs = buildThemeImageSpecs("music", "Musical instruments");
        const logo = specs.find((s) => s.key === "store-logo");
        const favicon = specs.find((s) => s.key === "store-favicon");
        const share = specs.find((s) => s.key === "store-share");
        expect(logo!.fitHeight).toBe(true);
        expect(favicon!.fitHeight).toBeUndefined();
        expect(share!.fitHeight).toBeUndefined();
    });

    test("logo and favicon prompts mention transparent background", () => {
        const specs = buildThemeImageSpecs("music", "Musical instruments");
        const logo = specs.find((s) => s.key === "store-logo");
        const favicon = specs.find((s) => s.key === "store-favicon");
        expect(logo!.prompt).toContain("transparent background");
        expect(favicon!.prompt).toContain("transparent background");
    });

    test("cleans technical store name prefix from description", () => {
        const specs = buildThemeImageSpecs(
            "e2e-test-kids-store-1773308802",
            "e2e-test-kids-store-1773308802 is your one-stop shop for engaging toys and games"
        );
        const logo = specs.find((s) => s.key === "store-logo");
        expect(logo!.prompt).not.toContain("e2e-test-kids-store-1773308802 is your");
        expect(logo!.prompt).toContain("engaging toys and games");
    });

    test("logo prompt includes humanized store name", () => {
        const specs = buildThemeImageSpecs("kids-store", "Toys and games for children");
        const logo = specs.find((s) => s.key === "store-logo");
        expect(logo!.prompt).toContain("Kids Store");
    });

    test("strips leading e2e and test segments from logo display name", () => {
        const specs = buildThemeImageSpecs("e2e-test-kids-store", "Toys");
        const logo = specs.find((s) => s.key === "store-logo");
        expect(logo!.prompt).toContain("Kids Store");
        expect(logo!.prompt).not.toContain("E2e");
        expect(logo!.prompt).not.toContain("Test");
    });

    test("strips trailing Unix-timestamp suffix (8+ digits) from logo display name", () => {
        const specs = buildThemeImageSpecs("e2e-test-kids-store-1773326586", "Toys and games");
        const logo = specs.find((s) => s.key === "store-logo");
        expect(logo!.prompt).toContain("Kids Store");
        expect(logo!.prompt).not.toContain("1773326586");
        expect(logo!.prompt).not.toContain("E2e");
        expect(logo!.prompt).not.toContain("Test");
    });

    test("preserves short numeric suffixes like studio-54 or camera-360", () => {
        const specs54 = buildThemeImageSpecs("studio-54", "Music and entertainment");
        const logo54 = specs54.find((s) => s.key === "store-logo");
        expect(logo54!.prompt).toContain("Studio 54");

        const specs360 = buildThemeImageSpecs("camera-360", "Photography gear");
        const logo360 = specs360.find((s) => s.key === "store-logo");
        expect(logo360!.prompt).toContain("Camera 360");
    });

    test("falls back to full name if all segments would be stripped", () => {
        // A store named just "e2e-test" should still get some display name
        const specs = buildThemeImageSpecs("e2e-test", "Testing store");
        const logo = specs.find((s) => s.key === "store-logo");
        expect(logo!.prompt).toContain("E2e Test");
    });

    test("prompts include brand color hex values when provided", () => {
        const specs = buildThemeImageSpecs("beauty", "Cosmetics and skincare", {
            primary: "#E91E63",
            secondary: "#F8BBD0",
        });

        for (const spec of specs) {
            expect(spec.prompt).toContain("#E91E63");
            expect(spec.prompt).toContain("#F8BBD0");
        }
    });

    test("prompts work without brand colors", () => {
        const specs = buildThemeImageSpecs("music", "Musical instruments");

        for (const spec of specs) {
            expect(spec.prompt).not.toContain("#");
            expect(spec.prompt.length).toBeGreaterThan(20);
        }
    });

    test("all keys are unique", () => {
        const specs = buildThemeImageSpecs("test", "Test store");
        const keys = specs.map((s) => s.key);
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe("hydrateThemeMedia", () => {
    test("generates all 3 images when cache is empty", async () => {
        const imageProvider = new MockImageProvider();
        const cache = createTestCache();

        const result = await hydrateThemeMedia(imageProvider, cache, "test-store", "Test products");

        expect(result.total).toBe(3);
        expect(result.generated).toBe(3);
        expect(result.skipped).toBe(0);
        expect(result.failed).toBe(0);
        expect(imageProvider.callCount).toBe(3);
    });

    test("skips images already in cache", async () => {
        const imageProvider = new MockImageProvider();
        const cache = createTestCache();

        cache.images.saveImageForSalesChannel(
            "test-store",
            "store-logo",
            "store-logo",
            "dGVzdA==",
            "logo prompt",
            undefined,
            "theme_media"
        );

        const result = await hydrateThemeMedia(imageProvider, cache, "test-store", "Test products");

        expect(result.total).toBe(3);
        expect(result.generated).toBe(2);
        expect(result.skipped).toBe(1);
        expect(imageProvider.callCount).toBe(2);
    });

    test("handles failed generations", async () => {
        const imageProvider = new FailingImageProvider();
        const cache = createTestCache();

        const result = await hydrateThemeMedia(imageProvider, cache, "test-store", "Test products");

        expect(result.total).toBe(3);
        expect(result.generated).toBe(0);
        expect(result.failed).toBe(3);
    });

    test("passes correct dimensions to image provider", async () => {
        const imageProvider = new MockImageProvider();
        const cache = createTestCache();

        await hydrateThemeMedia(imageProvider, cache, "test-store", "Test products");

        const calls = imageProvider.getCalls();
        const logoCalls = calls.filter((c) => c.options?.width === 474);
        expect(logoCalls).toHaveLength(1);
        expect(logoCalls[0]?.options?.height).toBe(70);

        const faviconCalls = calls.filter((c) => c.options?.width === 96);
        expect(faviconCalls).toHaveLength(1);
        expect(faviconCalls[0]?.options?.height).toBe(96);

        const shareCalls = calls.filter((c) => c.options?.width === 1200);
        expect(shareCalls).toHaveLength(1);
        expect(shareCalls[0]?.options?.height).toBe(630);
    });
});
