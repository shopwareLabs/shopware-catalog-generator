import type { CheerioAPI } from "cheerio";

const HEX_COLOR_RE = /#([0-9a-fA-F]{3}){1,2}\b/;

/** Extract brand description from og:description or meta description */
export function extractBrandDescription($: CheerioAPI): string | undefined {
    const og = $('meta[property="og:description"]').attr("content")?.trim();
    if (og && og.length > 10) return og;

    const meta = $('meta[name="description"]').attr("content")?.trim();
    if (meta && meta.length > 10) return meta;

    return undefined;
}

/** Extract primary brand color from theme-color meta tag or CSS custom properties */
export function extractPrimaryColor($: CheerioAPI): string | undefined {
    const themeColor = $('meta[name="theme-color"]').attr("content")?.trim();
    if (themeColor && HEX_COLOR_RE.test(themeColor)) return themeColor.toLowerCase();

    // Scan inline <style> for common CSS variable names
    const cssVarRe =
        /--(?:primary|brand|main|accent|color-primary|color-brand)(?:-color)?[^:]*:\s*(#[0-9a-fA-F]{3,6})/gi;

    let color: string | undefined;

    $("style").each((_, el) => {
        if (color) return;
        const css = $(el).html() ?? "";
        const match = cssVarRe.exec(css);
        if (match?.[1]) {
            color = match[1].toLowerCase();
        }
        cssVarRe.lastIndex = 0;
    });

    return color;
}

/** Extract secondary/accent color from CSS custom properties */
export function extractSecondaryColor($: CheerioAPI): string | undefined {
    const cssVarRe =
        /--(?:secondary|accent|highlight|color-secondary|color-accent)(?:-color)?[^:]*:\s*(#[0-9a-fA-F]{3,6})/gi;

    let color: string | undefined;

    $("style").each((_, el) => {
        if (color) return;
        const css = $(el).html() ?? "";
        const match = cssVarRe.exec(css);
        if (match?.[1]) {
            color = match[1].toLowerCase();
        }
        cssVarRe.lastIndex = 0;
    });

    return color;
}
