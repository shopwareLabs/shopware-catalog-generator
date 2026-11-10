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

    test.each([
        ["jpg", Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg"],
        ["png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png"],
        ["gif", Buffer.from("GIF"), "image/gif"],
    ])("returns the %s mime type", (extension, buffer, mimeType) => {
        expect(detectImageFormat(buffer)).toEqual({ extension, mimeType });
    });

    test.each([
        [
            "RIFF without WEBP (e.g. WAV)",
            Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]),
        ],
        [
            "WEBP marker without RIFF",
            Buffer.concat([Buffer.from("RIFX"), Buffer.alloc(4), Buffer.from("WEBP")]),
        ],
        ["truncated RIFF header", Buffer.from("RIFF")],
        ["partial JPEG signature", Buffer.from([0xff, 0xd8, 0x00])],
        ["partial PNG signature", Buffer.from([0x89, 0x50, 0x4e, 0x00])],
        ["partial GIF signature", Buffer.from("GIX")],
        ["empty buffer", Buffer.alloc(0)],
    ])("falls back to jpg for %s", (_label, buffer) => {
        expect(detectImageFormat(buffer)).toEqual({ extension: "jpg", mimeType: "image/jpeg" });
    });
});
