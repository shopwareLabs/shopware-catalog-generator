import { describe, expect, spyOn, test } from "bun:test";

import type { AdminApiClient } from "../../../src/shopware/admin-client.js";

import { ShopwareApiHelpers } from "../../../src/shopware/api-helpers.js";

function createHelpers(): ShopwareApiHelpers {
    const client = {
        invoke: async () => ({ data: {} }),
        getSessionData: () => ({ accessToken: "token", expirationTime: Date.now() + 60_000 }),
    } as unknown as AdminApiClient;
    return new ShopwareApiHelpers(client, "http://shop.test", async () => "token");
}

describe("ShopwareApiHelpers.uploadMedia", () => {
    test.each([
        ["webp", "image/webp"],
        ["png", "image/png"],
        ["glb", "model/gltf-binary"],
        ["mp4", "video/mp4"],
        ["webm", "video/webm"],
        ["xyz", "application/octet-stream"],
    ])("sends .%s as %s", async (extension, contentType) => {
        const helpers = createHelpers();
        const postRaw = spyOn(helpers, "postRaw").mockResolvedValue(undefined);

        await helpers.uploadMedia("media-1", Buffer.from("x"), "my file", extension);

        expect(postRaw).toHaveBeenCalledWith(
            `_action/media/media-1/upload?extension=${extension}&fileName=my%20file`,
            expect.any(Buffer),
            { "Content-Type": contentType }
        );
    });
});
