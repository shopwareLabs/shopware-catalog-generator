import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import * as cheerio from "cheerio";
import sharp from "sharp";

import { extractColorsFromBrandImage } from "../../../src/crawlers/extractors/image-color.js";

const SVG_LOGO = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect fill="#0058a3" width="100" height="100"/>
    <text fill="#ffdb00" x="20" y="60">IKEA</text>
</svg>`;

const SVG_WITH_GRADIENT = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <defs>
        <linearGradient id="g">
            <stop stop-color="#e91e63" offset="0"/>
            <stop stop-color="#9c27b0" offset="1"/>
        </linearGradient>
    </defs>
    <rect fill="url(#g)" width="100" height="100"/>
</svg>`;

const SVG_BLACK_WHITE_ONLY = `<svg><rect fill="#ffffff"/><rect fill="#000000"/></svg>`;

/** Create a small PNG buffer with a single dominant color */
async function makePng(r: number, g: number, b: number): Promise<Buffer> {
    return sharp({
        create: {
            width: 32,
            height: 32,
            channels: 3,
            background: { r, g, b },
        },
    })
        .png()
        .toBuffer();
}

interface FetchPayload {
    body: Buffer | string;
    contentType: string;
    ok?: boolean;
}

function setupFetch(routes: Record<string, FetchPayload>): void {
    // @ts-expect-error — mocking fetch
    globalThis.fetch = async (url: string) => {
        const route = routes[url];
        if (!route) {
            return { ok: false, headers: { get: () => "" }, arrayBuffer: async () => new ArrayBuffer(0) };
        }
        const buffer =
            typeof route.body === "string" ? Buffer.from(route.body, "utf8") : route.body;
        return {
            ok: route.ok ?? true,
            headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? route.contentType : "") },
            arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        };
    };
}

describe("extractColorsFromBrandImage", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test("parses SVG fill colors directly without rasterizing", async () => {
        const $ = cheerio.load(`
            <link rel="icon" type="image/svg+xml" href="https://example.com/logo.svg">
        `);

        setupFetch({
            "https://example.com/logo.svg": { body: SVG_LOGO, contentType: "image/svg+xml" },
        });

        const result = await extractColorsFromBrandImage($, "https://example.com");
        expect(result).not.toBeNull();
        expect(result?.primary).toBe("#0058a3");
        expect(result?.secondary).toBe("#ffdb00");
    });

    test("parses SVG stop-color from gradients", async () => {
        const $ = cheerio.load(`
            <link rel="icon" href="https://example.com/g.svg">
        `);

        setupFetch({
            "https://example.com/g.svg": { body: SVG_WITH_GRADIENT, contentType: "image/svg+xml" },
        });

        const result = await extractColorsFromBrandImage($, "https://example.com");
        expect(result?.primary).toBe("#e91e63");
        expect(result?.secondary).toBe("#9c27b0");
    });

    test("returns null when SVG only contains black/white", async () => {
        const $ = cheerio.load(`
            <link rel="icon" type="image/svg+xml" href="https://example.com/bw.svg">
        `);

        setupFetch({
            "https://example.com/bw.svg": {
                body: SVG_BLACK_WHITE_ONLY,
                contentType: "image/svg+xml",
            },
        });

        const result = await extractColorsFromBrandImage($, "https://example.com");
        expect(result).toBeNull();
    });

    test("extracts dominant color from PNG via pixel analysis", async () => {
        const $ = cheerio.load(`
            <link rel="apple-touch-icon" href="https://example.com/icon.png">
        `);

        const png = await makePng(0xe0, 0, 0); // red
        setupFetch({
            "https://example.com/icon.png": { body: png, contentType: "image/png" },
        });

        const result = await extractColorsFromBrandImage($, "https://example.com");
        expect(result?.primary).toMatch(/^#e0[0-9a-f]{2}[0-9a-f]{2}$/i);
    });

    test("falls back to near-black for monochrome logos", async () => {
        const $ = cheerio.load(`
            <link rel="apple-touch-icon" href="https://example.com/black.png">
        `);

        const png = await makePng(0, 0, 0); // pure black
        setupFetch({
            "https://example.com/black.png": { body: png, contentType: "image/png" },
        });

        const result = await extractColorsFromBrandImage($, "https://example.com");
        expect(result?.primary).toBe("#000000");
    });

    test("apple-touch-icon takes priority over icon", async () => {
        const $ = cheerio.load(`
            <link rel="icon" type="image/svg+xml" href="https://example.com/wrong.svg">
            <link rel="apple-touch-icon" href="https://example.com/correct.svg">
        `);

        const wrongSvg = `<svg><rect fill="#ff0000"/></svg>`;
        const correctSvg = `<svg><rect fill="#00ff00"/></svg>`;

        setupFetch({
            "https://example.com/wrong.svg": { body: wrongSvg, contentType: "image/svg+xml" },
            "https://example.com/correct.svg": { body: correctSvg, contentType: "image/svg+xml" },
        });

        const result = await extractColorsFromBrandImage($, "https://example.com");
        expect(result?.primary).toBe("#00ff00");
    });

    test("tries well-known fallback paths when no icon links present", async () => {
        const $ = cheerio.load(`<html><head></head></html>`);

        // Use a color whose 32-step quantization is stable: r=0x40,g=0x40,b=0xc0 → #4040c0
        const png = await makePng(0x40, 0x40, 0xc0);
        setupFetch({
            "https://example.com/apple-touch-icon.png": { body: png, contentType: "image/png" },
        });

        const result = await extractColorsFromBrandImage($, "https://example.com");
        expect(result?.primary).toBe("#4040c0");
    });

    test("falls through to og:image as last resort", async () => {
        const $ = cheerio.load(`
            <meta property="og:image" content="https://example.com/share.png">
        `);

        const png = await makePng(0xab, 0x00, 0xab);
        setupFetch({
            "https://example.com/share.png": { body: png, contentType: "image/png" },
        });

        const result = await extractColorsFromBrandImage($, "https://example.com");
        expect(result?.primary).toMatch(/^#a[0-9a-f]00a[0-9a-f]$/i);
    });

    test("skips data: URIs", async () => {
        const $ = cheerio.load(`
            <link rel="apple-touch-icon" href="data:image/png;base64,iVBORw0KGgo=">
        `);

        // No fetch routes set — should still resolve to null without throwing
        setupFetch({});

        const result = await extractColorsFromBrandImage($, "https://example.com");
        expect(result).toBeNull();
    });

    test("returns null when all candidate images fail to fetch", async () => {
        const $ = cheerio.load(`
            <link rel="apple-touch-icon" href="https://example.com/missing.png">
        `);

        setupFetch({
            "https://example.com/missing.png": { body: "", contentType: "", ok: false },
        });

        const result = await extractColorsFromBrandImage($, "https://example.com");
        expect(result).toBeNull();
    });

    test("resolves relative icon paths against base URL", async () => {
        const $ = cheerio.load(`
            <link rel="apple-touch-icon" href="/relative-icon.png">
        `);

        const png = await makePng(0x00, 0x88, 0x00);
        setupFetch({
            "https://shop.example.com/relative-icon.png": { body: png, contentType: "image/png" },
        });

        const result = await extractColorsFromBrandImage($, "https://shop.example.com/de/");
        expect(result?.primary).toMatch(/^#0[0-9a-f]8[0-9a-f]0[0-9a-f]$/i);
    });
});
