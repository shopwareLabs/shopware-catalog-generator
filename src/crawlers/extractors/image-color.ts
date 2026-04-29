import sharp from "sharp";
import type { CheerioAPI } from "cheerio";

const IMAGE_FETCH_TIMEOUT_MS = 8_000;

function toAbsolute(href: string, baseUrl: string): string | null {
    try {
        return new URL(href, baseUrl).href;
    } catch {
        return null;
    }
}

interface FetchResult {
    buffer: Buffer;
    contentType: string;
}

async function fetchUrl(url: string): Promise<FetchResult | null> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (compatible; ShopwareCatalogBot/1.0; +https://github.com/shopwareLabs/shopware-catalog-generator)",
            },
        });
        clearTimeout(timer);
        if (!response.ok) return null;
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("html")) return null;
        return { buffer: Buffer.from(await response.arrayBuffer()), contentType };
    } catch {
        return null;
    }
}

interface ColorPair {
    primary: string;
    secondary?: string;
}

/**
 * Extract dominant colors from raw RGB pixel data.
 * First pass: colored (saturated) pixels only.
 * Second pass (fallback): includes near-black pixels to support monochrome logos like Foot Locker.
 */
function extractDominantColors(pixels: Buffer): ColorPair | null {
    const toHex = (key: string) => {
        const [r, g, b] = key.split(",").map(Number);
        return `#${r!.toString(16).padStart(2, "0")}${g!.toString(16).padStart(2, "0")}${b!.toString(16).padStart(2, "0")}`;
    };

    for (const includeNearBlack of [false, true]) {
        const counts = new Map<string, number>();

        for (let i = 0; i < pixels.length; i += 3) {
            const r = pixels[i]!;
            const g = pixels[i + 1]!;
            const b = pixels[i + 2]!;

            if (r > 230 && g > 230 && b > 230) continue; // near-white
            if (!includeNearBlack && r < 25 && g < 25 && b < 25) continue; // near-black
            if (!includeNearBlack && Math.max(r, g, b) - Math.min(r, g, b) < 40) continue; // low saturation

            const key = `${Math.floor(r / 32) * 32},${Math.floor(g / 32) * 32},${Math.floor(b / 32) * 32}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }

        if (counts.size === 0) continue;

        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const primary = toHex(sorted[0]![0]);
        const [pr, pg, pb] = sorted[0]![0].split(",").map(Number);

        let secondary: string | undefined;
        for (const [key] of sorted.slice(1, 15)) {
            const [sr, sg, sb] = key.split(",").map(Number);
            if (Math.abs(pr! - sr!) + Math.abs(pg! - sg!) + Math.abs(pb! - sb!) > 80) {
                secondary = toHex(key);
                break;
            }
        }

        return { primary, secondary };
    }

    return null;
}

/** Parse fill/stroke color values from SVG markup without rasterizing. */
function extractColorsFromSvg(svgText: string): ColorPair | null {
    const hexRe = /(?:fill|stroke|stop-color)\s*(?:=\s*['"]|:\s*)(#[0-9a-fA-F]{3,6})/gi;
    const seen = new Map<string, number>();
    let match: RegExpExecArray | null;

    while ((match = hexRe.exec(svgText)) !== null) {
        const color = match[1]!.toLowerCase();
        if (color === "#000" || color === "#000000" || color === "#fff" || color === "#ffffff") {
            continue;
        }
        seen.set(color, (seen.get(color) ?? 0) + 1);
    }

    if (seen.size === 0) return null;

    const sorted = [...seen.entries()].sort((a, b) => b[1] - a[1]);
    return {
        primary: sorted[0]![0],
        secondary: sorted.length > 1 ? sorted[1]![0] : undefined,
    };
}

async function analyzeUrl(url: string): Promise<ColorPair | null> {
    const result = await fetchUrl(url);
    if (!result) return null;

    const { buffer, contentType } = result;

    if (contentType.includes("svg") || url.toLowerCase().includes(".svg")) {
        return extractColorsFromSvg(buffer.toString("utf8"));
    }

    try {
        const { data } = await sharp(buffer)
            .resize(80, 80, { fit: "fill" })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        return extractDominantColors(data);
    } catch {
        return null;
    }
}

/**
 * Collect candidate brand image URLs in priority order:
 * apple-touch-icon → SVG/PNG favicons → msapplication tile → well-known paths → og:image
 */
function findBrandImageUrls($: CheerioAPI, baseUrl: string): string[] {
    const urls: string[] = [];
    const seen = new Set<string>();
    const origin = new URL(baseUrl).origin;

    const push = (href: string | undefined) => {
        if (!href) return;
        if (href.startsWith("data:")) return;
        const abs = toAbsolute(href, baseUrl);
        if (!abs) return;
        if (!seen.has(abs)) {
            seen.add(abs);
            urls.push(abs);
        }
    };

    // 1. Apple touch icons — explicitly designed as brand icon
    $('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').each((_, el) => {
        push($(el).attr("href"));
    });

    // 2. SVG icons (can parse fill colors directly) + large PNG favicons
    const LARGE_SIZES = new Set(["192x192", "180x180", "128x128", "96x96", "64x64", "48x48", "32x32"]);
    $('link[rel="icon"], link[rel="shortcut icon"]').each((_, el) => {
        const sizes = $(el).attr("sizes") ?? "";
        const type = $(el).attr("type") ?? "";
        const href = $(el).attr("href") ?? "";
        if (type.includes("svg") || href.includes(".svg") || LARGE_SIZES.has(sizes) || type.includes("png")) {
            push(href);
        }
    });

    // 3. Microsoft tile image
    push($('meta[name="msapplication-TileImage"]').attr("content"));

    // 4. Well-known fallback paths (for sites with no icon links in HTML, e.g. Edeka)
    push(`${origin}/apple-touch-icon.png`);
    push(`${origin}/apple-touch-icon-180x180.png`);
    push(`${origin}/apple-touch-icon-precomposed.png`);

    // 5. OG image — last resort, may be a product/lifestyle photo
    push($('meta[property="og:image"]').attr("content"));

    return urls;
}

/**
 * Extract brand colors by downloading and analyzing the site's brand images.
 * Tries icons first (most reliable), falls back to og:image.
 * Supports raster images (via sharp) and SVG (via fill/stroke color parsing).
 */
export async function extractColorsFromBrandImage(
    $: CheerioAPI,
    baseUrl: string
): Promise<ColorPair | null> {
    for (const url of findBrandImageUrls($, baseUrl)) {
        const colors = await analyzeUrl(url);
        if (colors?.primary) return colors;
    }
    return null;
}
