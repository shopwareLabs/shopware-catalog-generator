#!/usr/bin/env bun

/**
 * E2E Verification Script
 *
 * Verifies that generated data exists in Shopware:
 * - SalesChannel exists
 * - Categories exist (no placeholders)
 * - Products exist (no placeholders)
 * - Manufacturers exist (if generated)
 */

import type { AdminApiClient, Schemas } from "../../src/shopware/admin-client.js";
import type { SearchResult } from "../../src/shopware/api-types.js";

import { createCacheFromEnv } from "../../src/cache.js";
import { DataHydrator } from "../../src/shopware/index.js";
import { countCategories, isPlaceholder } from "../../src/utils/index.js";

/**
 * Typed search helper for E2E tests.
 * Uses the frontends pattern: destructure { data } from invoke(), then narrow with SearchResult.
 */
async function search<T>(
    client: AdminApiClient,
    operation: string,
    body: Record<string, unknown>
): Promise<{ data: T[]; total: number }> {
    const { data } = await client.invoke(operation as never, { body } as never);
    const response = data as SearchResult<T>;
    return {
        data: response.data ?? [],
        total: response.total ?? 0,
    };
}

interface VerificationResult {
    salesChannel: { found: boolean; id?: string; navigationCategoryId?: string };
    categories: { count: number; expected: number; placeholders: string[] };
    products: { count: number; expected: number; placeholders: string[] };
    propertyGroups: { count: number; productsWithProperties: number };
    manufacturers: { count: number };
    images: { productsWithImages: number; totalProducts: number };
    cms: {
        landingPages: number;
        homePage: boolean;
        testingCategory: boolean;
        cookieSettingsLink: boolean;
    };
    passed: boolean;
    errors: string[];
}

interface ExpectedCounts {
    categories: number;
    products: number;
}

async function verifyGeneration(
    salesChannelName: string,
    expected: ExpectedCounts
): Promise<VerificationResult> {
    const result: VerificationResult = {
        salesChannel: { found: false },
        categories: { count: 0, expected: expected.categories, placeholders: [] },
        products: { count: 0, expected: expected.products, placeholders: [] },
        propertyGroups: { count: 0, productsWithProperties: 0 },
        manufacturers: { count: 0 },
        images: { productsWithImages: 0, totalProducts: 0 },
        cms: {
            landingPages: 0,
            homePage: false,
            testingCategory: false,
            cookieSettingsLink: false,
        },
        passed: false,
        errors: [],
    };

    // Connect to Shopware
    const swEnvUrl = process.env.SW_ENV_URL;
    if (!swEnvUrl) {
        result.errors.push("SW_ENV_URL not set");
        return result;
    }

    const hydrator = new DataHydrator();
    try {
        await hydrator.authenticateWithClientCredentials(
            swEnvUrl,
            process.env.SW_CLIENT_ID,
            process.env.SW_CLIENT_SECRET
        );
    } catch (error) {
        result.errors.push(
            `Failed to authenticate: ${error instanceof Error ? error.message : String(error)}`
        );
        return result;
    }

    // Verify SalesChannel
    console.log(`Verifying SalesChannel "${salesChannelName}"...`);
    const salesChannel = await hydrator.findSalesChannelByName(salesChannelName);

    if (!salesChannel) {
        result.errors.push(`SalesChannel "${salesChannelName}" not found`);
        return result;
    }

    result.salesChannel = {
        found: true,
        id: salesChannel.id,
        navigationCategoryId: salesChannel.navigationCategoryId,
    };
    console.log(`  ✓ SalesChannel: ${salesChannel.id}`);
    console.log(`  ✓ Navigation Category: ${salesChannel.navigationCategoryId}`);

    // Get the AdminApiClient from the hydrator for direct queries
    const client = (hydrator as unknown as { client: AdminApiClient }).client;

    // Verify categories
    console.log(`Verifying categories...`);
    try {
        const categoryResponse = await search<Schemas["Category"]>(
            client,
            "searchCategory post /search/category",
            {
                limit: 500,
                filter: [
                    {
                        type: "contains",
                        field: "path",
                        value: salesChannel.navigationCategoryId,
                    },
                ],
            }
        );

        result.categories.count = categoryResponse.total;
        console.log(`  Found ${result.categories.count} categories under root`);

        for (const cat of categoryResponse.data) {
            const name = cat.name ?? "";
            if (isPlaceholder(name)) {
                result.categories.placeholders.push(name);
            }
        }

        if (result.categories.count < result.categories.expected) {
            result.errors.push(
                `Expected at least ${result.categories.expected} categories, found ${result.categories.count}`
            );
        } else {
            console.log(`  ✓ Categories: ${result.categories.count}`);
        }

        if (result.categories.placeholders.length > 0) {
            console.log(
                `  ✗ Found ${result.categories.placeholders.length} placeholder categories`
            );
            result.errors.push(
                `Found ${result.categories.placeholders.length} placeholder category names: ${result.categories.placeholders.slice(0, 5).join(", ")}${result.categories.placeholders.length > 5 ? "..." : ""}`
            );
        }
    } catch (error) {
        console.log(
            `  ✗ Category query failed: ${error instanceof Error ? error.message : String(error)}`
        );
        result.errors.push(
            `Category query failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    // Verify products
    console.log(`Verifying products...`);
    try {
        const productResponse = await search<Schemas["Product"]>(
            client,
            "searchProduct post /search/product",
            {
                limit: 500,
                filter: [
                    {
                        type: "equals",
                        field: "visibilities.salesChannelId",
                        value: salesChannel.id,
                    },
                ],
            }
        );

        result.products.count = productResponse.total;
        console.log(`  Found ${result.products.count} products in SalesChannel`);

        for (const prod of productResponse.data) {
            const name = prod.name ?? "";
            if (isPlaceholder(name)) {
                result.products.placeholders.push(name);
            }
        }

        if (result.products.count < result.products.expected) {
            result.errors.push(
                `Expected at least ${result.products.expected} products, found ${result.products.count}`
            );
        } else {
            console.log(`  ✓ Products: ${result.products.count}`);
        }

        if (result.products.placeholders.length > 0) {
            console.log(`  ✗ Found ${result.products.placeholders.length} placeholder products`);
            result.errors.push(
                `Found ${result.products.placeholders.length} placeholder product names: ${result.products.placeholders.slice(0, 5).join(", ")}${result.products.placeholders.length > 5 ? "..." : ""}`
            );
        }
    } catch (error) {
        console.log(
            `  ✗ Product query failed: ${error instanceof Error ? error.message : String(error)}`
        );
        result.errors.push(
            `Product query failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    // Verify manufacturers
    console.log(`Verifying manufacturers...`);
    try {
        const manufacturerResponse = await search<Schemas["ProductManufacturer"]>(
            client,
            "searchProductManufacturer post /search/product-manufacturer",
            { limit: 500 }
        );

        result.manufacturers.count = manufacturerResponse.total;
        console.log(`  ✓ Manufacturers: ${result.manufacturers.count}`);
    } catch (error) {
        console.log(
            `  ✗ Manufacturer query failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    // Verify property groups
    console.log(`Verifying property groups...`);
    try {
        const propertyResponse = await search<Schemas["PropertyGroup"]>(
            client,
            "searchPropertyGroup post /search/property-group",
            {
                limit: 500,
                associations: { options: {} },
            }
        );

        result.propertyGroups.count = propertyResponse.total;
        console.log(`  ✓ Property groups: ${result.propertyGroups.count}`);

        // Verify Color property group
        const colorGroup = propertyResponse.data.find(
            (g) => (g.name ?? "").toLowerCase() === "color"
        );
        if (colorGroup) {
            if (colorGroup.displayType !== "color") {
                result.errors.push(
                    `Color property group has displayType "${colorGroup.displayType}" instead of "color"`
                );
                console.log(`  ✗ Color displayType: ${colorGroup.displayType} (expected: color)`);
            } else {
                console.log(`  ✓ Color displayType: color`);
            }

            const imageColorNames = [
                "multicolor",
                "multi-color",
                "rainbow",
                "assorted",
                "mixed",
                "patterned",
                "printed",
                "gradient",
            ];
            const options = (colorGroup.options ?? []) as Array<{
                name?: string;
                colorHexCode?: string;
            }>;
            const optionsWithoutHex = options.filter(
                (o) => !o.colorHexCode && !imageColorNames.includes((o.name ?? "").toLowerCase())
            );
            if (optionsWithoutHex.length > 0) {
                result.errors.push(
                    `Color options missing hex codes: ${optionsWithoutHex.map((o) => o.name).join(", ")}`
                );
                console.log(
                    `  ✗ Color options missing hex: ${optionsWithoutHex.map((o) => o.name).join(", ")}`
                );
            } else {
                const imageColors = options.filter((o) =>
                    imageColorNames.includes((o.name ?? "").toLowerCase())
                );
                const hexColors = options.filter((o) => o.colorHexCode);
                console.log(
                    `  ✓ Color options: ${hexColors.length} with hex, ${imageColors.length} with images`
                );
            }
        }

        // Check products with properties
        const productsWithPropsResponse = await search<Schemas["Product"]>(
            client,
            "searchProduct post /search/product",
            {
                limit: 500,
                filter: [
                    {
                        type: "equals",
                        field: "visibilities.salesChannelId",
                        value: salesChannel.id,
                    },
                ],
                associations: { properties: {} },
            }
        );

        const productsWithProps = productsWithPropsResponse.data.filter(
            (p) => p.properties && p.properties.length > 0
        ).length;
        result.propertyGroups.productsWithProperties = productsWithProps;
        console.log(`  ✓ Products with properties: ${productsWithProps}/${result.products.count}`);
    } catch (error) {
        console.log(
            `  ✗ Property query failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    // Verify product images
    console.log(`Verifying images...`);
    try {
        const productsWithMediaResponse = await search<Schemas["Product"]>(
            client,
            "searchProduct post /search/product",
            {
                limit: 500,
                filter: [
                    {
                        type: "equals",
                        field: "visibilities.salesChannelId",
                        value: salesChannel.id,
                    },
                ],
                associations: { media: {} },
            }
        );

        const totalProducts = productsWithMediaResponse.total;
        const productsWithImages = productsWithMediaResponse.data.filter(
            (p) => (p.media && p.media.length > 0) || p.coverId
        ).length;

        result.images.totalProducts = totalProducts;
        result.images.productsWithImages = productsWithImages;
        console.log(`  ✓ Products with images: ${productsWithImages}/${totalProducts}`);
    } catch (error) {
        console.log(
            `  ✗ Image query failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    // Verify homepage CMS page on root category
    console.log(`Verifying homepage CMS layout...`);
    try {
        const rootCatResponse = await search<Schemas["Category"]>(
            client,
            "searchCategory post /search/category",
            {
                ids: [salesChannel.navigationCategoryId],
                limit: 1,
            }
        );

        const rootCategory = rootCatResponse.data[0];
        if (rootCategory?.cmsPageId) {
            result.cms.homePage = true;
            console.log(`  ✓ Root category has homepage CMS layout`);
        } else {
            result.errors.push("Root category has no CMS page assigned (homepage missing)");
            console.log(`  ✗ Root category has no CMS page assigned`);
        }
    } catch (error) {
        console.log(
            `  ✗ Homepage check failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    // Verify CMS landing pages
    console.log(`Verifying CMS pages...`);
    try {
        const landingPageResponse = await search<Schemas["LandingPage"]>(
            client,
            "searchLandingPage post /search/landing-page",
            {
                limit: 50,
                associations: { salesChannels: {} },
                filter: [
                    {
                        type: "equals",
                        field: "salesChannels.id",
                        value: salesChannel.id,
                    },
                ],
            }
        );

        result.cms.landingPages = landingPageResponse.total;
        console.log(`  ✓ Landing pages: ${result.cms.landingPages}`);

        if (result.cms.landingPages < 6) {
            result.errors.push(
                `Expected at least 6 CMS landing pages, found ${result.cms.landingPages}`
            );
        }
    } catch (error) {
        console.log(
            `  ✗ Landing page query failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    // Verify Testing category hierarchy
    console.log(`Verifying Testing category...`);
    try {
        const testingCats = await search<Schemas["Category"]>(
            client,
            "searchCategory post /search/category",
            {
                limit: 10,
                filter: [
                    { type: "equals", field: "name", value: "Testing" },
                    {
                        type: "equals",
                        field: "parentId",
                        value: salesChannel.navigationCategoryId,
                    },
                ],
            }
        );

        if (testingCats.total > 0) {
            result.cms.testingCategory = true;
            console.log(`  ✓ Testing category exists`);
            const testingId = testingCats.data[0]?.id;

            // Check for Cookie settings child
            if (testingId) {
                const cookieCats = await search<
                    Schemas["Category"] & { linkType?: string; externalLink?: string }
                >(client, "searchCategory post /search/category", {
                    limit: 5,
                    filter: [
                        { type: "equals", field: "parentId", value: testingId },
                        { type: "equals", field: "name", value: "Cookie settings" },
                    ],
                });

                if (cookieCats.total > 0) {
                    result.cms.cookieSettingsLink = true;
                    console.log(`  ✓ Cookie settings link exists`);
                } else {
                    result.errors.push("Cookie settings category not found under Testing");
                    console.log(`  ✗ Cookie settings link not found`);
                }
            }
        } else {
            result.errors.push("Testing category not found");
            console.log(`  ✗ Testing category not found`);
        }
    } catch (error) {
        console.log(
            `  ✗ Testing category query failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    // Verify CMS blueprint cache
    const cache = createCacheFromEnv();
    if (cache.hasCmsBlueprint(salesChannelName)) {
        console.log(`  ✓ CMS blueprint cached`);
    } else {
        console.log(`  ⊘ CMS blueprint not cached (CMS used fixture defaults)`);
    }

    // Overall pass/fail
    result.passed = result.errors.length === 0;

    return result;
}

// CLI entry point
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    let salesChannelName: string | undefined;

    for (const arg of args) {
        if (arg.startsWith("--name=")) {
            salesChannelName = arg.slice("--name=".length);
        }
    }

    if (!salesChannelName) {
        console.error("Error: --name=<salesChannel> is required");
        console.error("Usage: bun run tests/e2e/verify.ts --name=<salesChannel>");
        process.exit(1);
    }

    // Load expected counts from hydrated blueprint
    const cache = createCacheFromEnv();
    const blueprint = cache.loadHydratedBlueprint(salesChannelName);

    let expected: ExpectedCounts;
    if (blueprint) {
        expected = {
            categories: countCategories(blueprint.categories),
            products: blueprint.products.length,
        };
        console.log(
            `Loaded blueprint: ${expected.products} products, ${expected.categories} categories`
        );
    } else {
        expected = { categories: 3, products: 10 };
        console.log("No blueprint found, using default expectations");
    }

    console.log("");
    console.log("=== E2E Verification ===");
    console.log("");

    const result = await verifyGeneration(salesChannelName, expected);

    console.log("");

    if (result.passed) {
        console.log("=== All verifications PASSED ===");
        console.log("");
        console.log(`Summary:`);
        console.log(`  SalesChannel: ${result.salesChannel.id}`);
        console.log(
            `  Categories: ${result.categories.count} (${result.categories.placeholders.length} placeholders)`
        );
        console.log(
            `  Products: ${result.products.count} (${result.products.placeholders.length} placeholders)`
        );
        console.log(
            `  Property groups: ${result.propertyGroups.count} (${result.propertyGroups.productsWithProperties} products with properties)`
        );
        console.log(`  Manufacturers: ${result.manufacturers.count}`);
        console.log(
            `  Images: ${result.images.productsWithImages}/${result.images.totalProducts} products with images`
        );
        console.log(
            `  CMS: ${result.cms.landingPages} landing pages, Home: ${result.cms.homePage ? "✓" : "✗"}, Testing: ${result.cms.testingCategory ? "✓" : "✗"}, Cookie: ${result.cms.cookieSettingsLink ? "✓" : "✗"}`
        );
        process.exit(0);
    } else {
        console.log("=== Verification FAILED ===");
        console.log("");
        for (const error of result.errors) {
            console.error(`  ✗ ${error}`);
        }
        process.exit(1);
    }
}

main();
