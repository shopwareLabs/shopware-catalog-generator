import { describe, expect, test } from "bun:test";

import { detectImageFormat } from "../../../src/utils/image-format.js";

describe("detectImageFormat", () => {
    test.each([
        [Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]), "webp"],
        [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "jpg"],
        [Buffer.from([0x89, 0x50, 0x4e, 0x47]), "png"],
        [Buffer.from("GIF89a"), "gif"],
        [Buffer.from("unknown"), "jpg"],
    ])("detects %#", (buffer, extension) => {
        expect(detectImageFormat(buffer).extension).toBe(extension);
    });

    test("returns the matching mime type", () => {
        const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
        expect(detectImageFormat(webp)).toEqual({ extension: "webp", mimeType: "image/webp" });
    });
});
