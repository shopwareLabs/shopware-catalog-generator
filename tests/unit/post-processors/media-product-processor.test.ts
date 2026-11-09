import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import type { SyncOperation } from "../../../src/shopware/api-types.js";

import {
    MEDIA_FIXTURE_DIR,
    MEDIA_SHOWCASE_FILES,
    MEDIA_SHOWCASE_PRODUCT,
} from "../../../src/fixtures/index.js";
import {
    MEDIA_SHOWCASE_PRODUCT_ID,
    MediaProductProcessor,
    mediaShowcaseMediaId,
} from "../../../src/post-processors/media-product-processor.js";
import { ShopwareCapabilities } from "../../../src/shopware/version.js";
import { createTestContext } from "../../helpers/post-processor-context.js";
import { createMockApiHelpers } from "../../mocks/index.js";

type MockApi = ReturnType<typeof createMockApiHelpers>;

/** All sync operations sent to Shopware, keyed by operation name */
function syncOperations(mockApi: MockApi): Record<string, SyncOperation> {
    return Object.assign(
        {},
        ...mockApi
            .getCallsByEndpoint("_action/sync")
            .map((call) => call.body as Record<string, SyncOperation>)
    );
}

function uploadedExtensions(mockApi: MockApi): string[] {
    return mockApi
        .getCallsByMethod("postRaw")
        .map((call) => new URL(`http://x/${call.endpoint}`).searchParams.get("extension") ?? "");
}

function run(version: string, mockApi: MockApi = createMockApiHelpers()) {
    const { context } = createTestContext({
        mockApi,
        shopware: ShopwareCapabilities.fromVersion(version),
    });
    return { mockApi, context, result: MediaProductProcessor.process(context) };
}

describe("media showcase fixtures", () => {
    test("every fixture file exists and is not empty", () => {
        for (const file of MEDIA_SHOWCASE_FILES) {
            const stat = fs.statSync(path.join(MEDIA_FIXTURE_DIR, file.fileName));
            expect(stat.size).toBeGreaterThan(0);
        }
    });

    test("GLB files start with the glTF magic bytes", () => {
        const glbs = MEDIA_SHOWCASE_FILES.filter((file) => file.extension === "glb");
        expect(glbs.length).toBeGreaterThan(0);
        for (const file of glbs) {
            const header = fs
                .readFileSync(path.join(MEDIA_FIXTURE_DIR, file.fileName))
                .subarray(0, 4);
            expect(header.toString("ascii")).toBe("glTF");
        }
    });

    test("LICENSES.md credits every file", () => {
        const licenses = fs.readFileSync(path.join(MEDIA_FIXTURE_DIR, "LICENSES.md"), "utf-8");
        for (const file of MEDIA_SHOWCASE_FILES) {
            expect(licenses).toContain(file.fileName);
        }
    });

    test("media keys are unique", () => {
        const keys = MEDIA_SHOWCASE_FILES.map((file) => file.key);
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe("MediaProductProcessor", () => {
    describe("metadata", () => {
        test("has name, description and no dependencies", () => {
            expect(MediaProductProcessor.name).toBe("media-product");
            expect(MediaProductProcessor.description.length).toBeGreaterThan(0);
            expect(MediaProductProcessor.dependsOn).toEqual([]);
        });
    });

    describe("process", () => {
        test("skips shops without 3D or video gallery (6.5)", async () => {
            const { mockApi, result } = run("6.5.8.0");

            expect(await result).toMatchObject({ processed: 0, skipped: 1, errors: [] });
            expect(mockApi.getCalls()).toEqual([]);
        });

        test("dry run makes no API calls", async () => {
            const mockApi = createMockApiHelpers();
            const { context } = createTestContext({ mockApi, dryRun: true });

            const result = await MediaProductProcessor.process(context);

            expect(result).toMatchObject({ processed: 1, skipped: 0, errors: [] });
            expect(mockApi.getCalls()).toEqual([]);
        });

        test("uploads only the 3D models on 6.6.0 (no gallery videos yet)", async () => {
            const { mockApi, result } = run("6.6.0.0");

            expect((await result).errors).toEqual([]);
            expect(uploadedExtensions(mockApi)).toEqual(["glb", "glb"]);
        });

        test("uploads 3D models and videos on 6.6.1 and newer", async () => {
            const { mockApi, result } = run("6.7.16.0");

            expect(await result).toMatchObject({ processed: 1, errors: [] });
            expect(uploadedExtensions(mockApi).sort()).toEqual(["glb", "glb", "mp4", "mp4"]);
        });

        test("creates the product with a deterministic ID and fixture data", async () => {
            const { mockApi, result } = run("6.7.16.0");
            await result;

            const [product] = syncOperations(mockApi).createMediaShowcaseProduct?.payload ?? [];
            expect(product).toMatchObject({
                id: MEDIA_SHOWCASE_PRODUCT_ID,
                productNumber: MEDIA_SHOWCASE_PRODUCT.productNumber,
                name: MEDIA_SHOWCASE_PRODUCT.name,
                taxId: "tax-id-mock",
                type: "physical",
                active: true,
            });
        });

        test("does not set product.type before 6.7.7", async () => {
            const { mockApi, result } = run("6.6.10.0");
            await result;

            const [product] = syncOperations(mockApi).createMediaShowcaseProduct?.payload ?? [];
            expect(product).toBeDefined();
            expect(product).not.toHaveProperty("type");
        });

        test("does not recreate an existing product", async () => {
            const mockApi = createMockApiHelpers();
            mockApi.mockSearchResponse("product", [{ id: MEDIA_SHOWCASE_PRODUCT_ID }]);
            const { result } = run("6.7.16.0", mockApi);
            await result;

            expect(syncOperations(mockApi).createMediaShowcaseProduct).toBeUndefined();
            expect(syncOperations(mockApi).assignMediaShowcaseGallery).toBeDefined();
        });

        test("skips uploads for media that already has a file", async () => {
            const mockApi = createMockApiHelpers();
            mockApi.mockSearchResponse(
                "media",
                MEDIA_SHOWCASE_FILES.map((file) => ({
                    id: mediaShowcaseMediaId(file),
                    fileName: `media-showcase-${file.key}`,
                }))
            );
            const { result } = run("6.7.16.0", mockApi);

            expect((await result).errors).toEqual([]);
            expect(mockApi.getCallsByMethod("postRaw")).toEqual([]);
            expect(syncOperations(mockApi).createMediaShowcaseMedia).toBeUndefined();
        });

        test("assigns the gallery in fixture order with the first file as cover", async () => {
            const { mockApi, result } = run("6.7.16.0");
            await result;

            const [gallery] = syncOperations(mockApi).assignMediaShowcaseGallery?.payload ?? [];
            const media = (gallery?.media ?? []) as Array<{ id: string; mediaId: string }>;
            expect(media.map((m) => m.mediaId)).toEqual(
                MEDIA_SHOWCASE_FILES.map(mediaShowcaseMediaId)
            );
            expect(gallery?.coverId).toBe(media[0]?.id);
        });

        test("makes the product visible in the SalesChannel", async () => {
            const { mockApi, context, result } = run("6.7.16.0");
            await result;

            const [visibility] = syncOperations(mockApi).addMediaShowcaseVisibility?.payload ?? [];
            expect(visibility).toMatchObject({
                productId: MEDIA_SHOWCASE_PRODUCT_ID,
                salesChannelId: context.salesChannelId,
                visibility: 30,
            });
        });

        test("reports a failed upload and leaves that file out of the gallery", async () => {
            const mockApi = createMockApiHelpers();
            const failing = MEDIA_SHOWCASE_FILES[0];
            const upload = mockApi.uploadMedia.bind(mockApi);
            mockApi.uploadMedia = async (mediaId, file, fileName, extension) => {
                if (failing && mediaId === mediaShowcaseMediaId(failing)) {
                    throw new Error("413 Payload Too Large");
                }
                return upload(mediaId, file, fileName, extension);
            };
            const { result } = run("6.7.16.0", mockApi);

            const { errors, processed } = await result;
            expect(processed).toBe(0);
            expect(errors).toEqual([`${failing?.fileName}: upload failed (413 Payload Too Large)`]);
            const [gallery] = syncOperations(mockApi).assignMediaShowcaseGallery?.payload ?? [];
            const mediaIds = ((gallery?.media ?? []) as Array<{ mediaId: string }>).map(
                (m) => m.mediaId
            );
            expect(mediaIds).toHaveLength(MEDIA_SHOWCASE_FILES.length - 1);
            expect(mediaIds).not.toContain(failing && mediaShowcaseMediaId(failing));
        });
    });

    describe("cleanup", () => {
        test("dry run deletes nothing", async () => {
            const mockApi = createMockApiHelpers();
            const { context } = createTestContext({ mockApi, dryRun: true });

            const result = await MediaProductProcessor.cleanup(context);

            expect(result.deleted).toBe(0);
            expect(mockApi.getCalls()).toEqual([]);
        });

        test("removes only the SalesChannel visibility, keeps the shared product", async () => {
            const mockApi = createMockApiHelpers();
            const { context } = createTestContext({ mockApi });

            const result = await MediaProductProcessor.cleanup(context);

            expect(result.deleted).toBe(1);
            const deletes = mockApi.getCallsByMethod("delete").map((call) => call.endpoint);
            expect(deletes).toHaveLength(1);
            expect(deletes[0]).toStartWith("product-visibility/");
        });
    });
});
