import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";

import { classifyPage } from "../../../src/crawlers/page-classifier.js";

function classify(html: string) {
    const $ = cheerio.load(html);
    return classifyPage(html, $);
}

function page(head: string, body = "") {
    return `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`;
}

// ── Tier 1: JSON-LD ──────────────────────────────────────────────────────────

describe("Tier 1 JSON-LD", () => {
    test("Product with offers → product", () => {
        const html = page(`<script type="application/ld+json">
            {"@type":"Product","name":"Oslo Chair","offers":{"price":"99.00"}}</script>`);
        expect(classify(html)).toBe("product");
    });

    test("ProductGroup → product", () => {
        const html = page(`<script type="application/ld+json">
            {"@type":"ProductGroup","name":"Oslo Chair","offers":{}}</script>`);
        expect(classify(html)).toBe("product");
    });

    test("bare Product with name only (no product-specific fields) does not match", () => {
        const html = page(`<script type="application/ld+json">
            {"@type":"Product","name":"Oslo Chair"}</script>`);
        // No offers/sku/gtin/etc → falls through to lower tiers
        expect(classify(html)).not.toBe("product");
    });

    test("ItemList (not BreadcrumbList) → category", () => {
        const html = page(`<script type="application/ld+json">
            {"@type":"ItemList","itemListElement":[{"@type":"Product","name":"A"}]}</script>`);
        expect(classify(html)).toBe("category");
    });

    test("BreadcrumbList alone does NOT classify as category", () => {
        // BreadcrumbList is navigation — should not trigger category
        const html = page(`<script type="application/ld+json">
            {"@type":"BreadcrumbList","itemListElement":[{"name":"Sofas"}]}</script>`);
        expect(classify(html)).not.toBe("category");
    });

    test("Article → cms", () => {
        const html = page(
            `<script type="application/ld+json">{"@type":"Article","name":"Blog"}</script>`
        );
        expect(classify(html)).toBe("cms");
    });

    test("FAQPage alone → cms (weakCms, no stronger signal)", () => {
        const html = page(`<script type="application/ld+json">{"@type":"FAQPage"}</script>`);
        expect(classify(html)).toBe("cms");
    });

    test("Product + FAQPage on same page → product (FAQPage is only weakCms)", () => {
        const html = page(`
            <script type="application/ld+json">{"@type":"Product","name":"P","offers":{}}</script>
            <script type="application/ld+json">{"@type":"FAQPage"}</script>
        `);
        expect(classify(html)).toBe("product");
    });

    test("@graph with Product → product", () => {
        const html = page(`<script type="application/ld+json">
            {"@graph":[{"@type":"WebPage"},{"@type":"Product","name":"X","sku":"123"}]}</script>`);
        expect(classify(html)).toBe("product");
    });
});

// ── og:type ──────────────────────────────────────────────────────────────────

describe("og:type", () => {
    test("og:type=article → cms", () => {
        const html = page(`<meta property="og:type" content="article">`);
        expect(classify(html)).toBe("cms");
    });

    test("og:type=product → product (Tier 2)", () => {
        const html = page(`<meta property="og:type" content="product">`);
        expect(classify(html)).toBe("product");
    });

    test("og:type=og:product (legacy prefix) → product", () => {
        const html = page(`<meta property="og:type" content="og:product">`);
        expect(classify(html)).toBe("product");
    });

    test("og:type=product overrides FAQPage weakCms", () => {
        const html = page(`
            <meta property="og:type" content="product">
            <script type="application/ld+json">{"@type":"FAQPage"}</script>
        `);
        expect(classify(html)).toBe("product");
    });

    test("og:type=product.group → category (IKEA pattern)", () => {
        // IKEA collection pages: no prices, no cart, og:type=product.group
        const html = page(`<meta property="og:type" content="product.group">`);
        expect(classify(html)).toBe("category");
    });

    test("og:type=article wins over a page full of prices", () => {
        const prices = Array(12).fill("49,99 €").join(" ");
        expect(classify(page(`<meta property="og:type" content="article">`, prices))).toBe("cms");
    });

    test("og:type=product wins over 10+ variant prices", () => {
        const prices = Array(12).fill("49,99 €").join(" ");
        expect(classify(page(`<meta property="og:type" content="product">`, prices))).toBe(
            "product"
        );
    });

    test("og:type=product.group loses to a price signal", () => {
        const html = page(`<meta property="og:type" content="product.group">`, "39,99 €");
        expect(classify(html)).toBe("product");
    });
});

// ── Tier 2: Microdata ────────────────────────────────────────────────────────

describe("Tier 2 Microdata", () => {
    test("itemtype Product without ItemList → product", () => {
        const html = page(
            "",
            `<div itemtype="https://schema.org/Product"><span itemprop="name">X</span></div>`
        );
        expect(classify(html)).toBe("product");
    });

    test("itemtype ItemList → category", () => {
        const html = page("", `<div itemtype="https://schema.org/ItemList"></div>`);
        expect(classify(html)).toBe("category");
    });

    test("3+ itemprop=price → category", () => {
        const html = page(
            "",
            `
            <span itemprop="price">10.00</span>
            <span itemprop="price">20.00</span>
            <span itemprop="price">30.00</span>
        `
        );
        expect(classify(html)).toBe("category");
    });

    test("1 itemprop=price → product", () => {
        const html = page("", `<span itemprop="price">49.99</span>`);
        expect(classify(html)).toBe("product");
    });

    test("single AggregateRating without ItemList → product", () => {
        const html = page(
            "",
            `<div itemtype="https://schema.org/AggregateRating"><span itemprop="ratingValue">4.5</span></div>`
        );
        expect(classify(html)).toBe("product");
    });
});

// ── Tier 3: Price + Cart count ───────────────────────────────────────────────

describe("Tier 3 price/cart signals", () => {
    test("10+ prices → category", () => {
        const prices = Array(12).fill("49,99 €").join(" ");
        expect(classify(page("", prices))).toBe("category");
    });

    test("2+ cart signals → category", () => {
        const html = page("", "In den Warenkorb In den Warenkorb");
        expect(classify(html)).toBe("category");
    });

    test("6–9 prices with 0 cart signals → category (Hyva/mey.com pattern)", () => {
        const prices = Array(8).fill("49,99 €").join(" ");
        expect(classify(page("", prices))).toBe("category");
    });

    test("6 prices with 1 cart signal → product (variant pricing on product page)", () => {
        const prices = Array(6).fill("49,99 €").join(" ");
        const html = page("", `${prices} In den Warenkorb`);
        expect(classify(html)).toBe("product");
    });

    test("1–5 prices with 0 cart signals → product (JS-only cart button)", () => {
        const html = page("", "39,99 €");
        expect(classify(html)).toBe("product");
    });

    test("1–5 prices with 1 cart signal → product", () => {
        const html = page("", "39,99 € In den Warenkorb");
        expect(classify(html)).toBe("product");
    });

    test("0 prices 0 cart → cms/unknown", () => {
        const html = page("", "<p>About our company.</p>");
        expect(classify(html)).toBe("cms");
    });

    test("script-embedded prices are stripped before counting", () => {
        // Variables like openOffcanvasAfterAddToCart in inline scripts must not count
        const html = page(
            `<script>var x = "add to cart special"; var y = "In den Warenkorb";</script>`,
            `<p>19,99 € in den Warenkorb</p>`
        );
        // One real price, one real cart signal — product
        expect(classify(html)).toBe("product");
    });
    test("exactly 10 prices with 1 cart signal → category", () => {
        const prices = Array(10).fill("49,99 €").join(" ");
        expect(classify(page("", `${prices} In den Warenkorb`))).toBe("category");
    });

    test("exactly 6 prices with 0 cart signals → category", () => {
        const prices = Array(6).fill("49,99 €").join(" ");
        expect(classify(page("", prices))).toBe("category");
    });

    test("5 prices with 0 cart signals → product", () => {
        const prices = Array(5).fill("49,99 €").join(" ");
        expect(classify(page("", prices))).toBe("product");
    });

    test("3 cart signals with 1 price → category", () => {
        const html = page("", "39,99 € Add to cart Add to cart Add to cart");
        expect(classify(html)).toBe("category");
    });

    test("1 cart signal without prices → unknown", () => {
        expect(classify(page("", "<button>Add to cart</button>"))).toBe("unknown");
    });

    test("cart text only inside a script is ignored", () => {
        const html = page(`<script>var label = "Add to cart";</script>`, "<p>About us.</p>");
        expect(classify(html)).toBe("cms");
    });
});

describe("JSON-LD and microdata edge cases", () => {
    const ld = (data: unknown): string =>
        `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

    test.each([
        "offers",
        "sku",
        "gtin",
        "mpn",
        "description",
        "brand",
        "color",
        "material",
        "additionalProperty",
        "aggregateRating",
        "review",
    ])("Product with only %s is substantial → product", (field) => {
        expect(classify(page(ld({ "@type": "Product", name: "X", [field]: "v" })))).toBe("product");
    });

    test("product field with an empty value is not substantial", () => {
        expect(classify(page(ld({ "@type": "Product", name: "X", sku: "" })))).toBe("cms");
    });

    test("schema.org URL types and type arrays are normalized", () => {
        expect(
            classify(page(ld({ "@type": ["Thing", "https://schema.org/Product"], sku: "1" })))
        ).toBe("product");
    });

    test("first strong signal wins: ItemList before Product → category", () => {
        expect(
            classify(page(ld([{ "@type": "ItemList" }, { "@type": "Product", sku: "1" }])))
        ).toBe("category");
    });

    test("blocks without @type and malformed JSON are ignored", () => {
        const head = `<script type="application/ld+json">{ broken</script>${ld([
            { name: "untyped" },
            null,
            "text",
        ])}`;
        expect(classify(page(head))).toBe("cms");
    });

    test("a type list that includes BreadcrumbList is not a category", () => {
        expect(classify(page(ld({ "@type": ["ItemList", "BreadcrumbList"] })))).toBe("cms");
    });

    test("two microdata Product scopes without a list → category", () => {
        const body = `<div itemscope itemtype="https://schema.org/Product"></div>
            <div itemscope itemtype="https://schema.org/Product"></div>`;
        expect(classify(page("", body))).toBe("category");
    });

    test("one Product scope inside an ItemList → category", () => {
        const body = `<div itemscope itemtype="https://schema.org/ItemList">
            <div itemscope itemtype="https://schema.org/Product"></div></div>`;
        expect(classify(page("", body))).toBe("category");
    });

    test("a microdata BreadcrumbList is not counted as a list", () => {
        const body = `<ol itemscope itemtype="https://schema.org/BreadcrumbList"></ol>`;
        expect(classify(page("", body))).toBe("cms");
    });

    test("two microdata prices give no microdata signal", () => {
        const body = `<span itemprop="price"></span><span itemprop="offers"></span>`;
        expect(classify(page("", body))).toBe("cms");
    });

    test("two AggregateRating scopes give no microdata signal", () => {
        const body = `<div itemscope itemtype="https://schema.org/AggregateRating"></div>
            <div itemscope itemtype="https://schema.org/AggregateRating"></div>`;
        expect(classify(page("", body))).toBe("cms");
    });
});
