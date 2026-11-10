/**
 * Checks for catalog features: variants, colour system and colour images per variant.
 * Expected values come from the hydrated blueprint and the cache, like the upload.
 */

import type { FeatureCheck, FeatureCheckContext, FeatureCheckOutcome } from "./types.js";

import { collectVariantImageTasks } from "../../../src/blueprint/hydrators/index.js";
import { blueprintVariantSettings, capVariantConfigs } from "../../../src/blueprint/index.js";
import { COLOR_FAMILY_GROUP_ID, COLOR_FAMILY_GROUP_NAME } from "../../../src/fixtures/index.js";
import { fail, pass, skip, visibleIn } from "./types.js";

/** Parents per children query: 5 × max 100 variants stays within the 500 row limit */
const PARENTS_PER_QUERY = 5;

interface VariantRow {
    id: string;
    parentId?: string | null;
    coverId?: string | null;
    options?: Array<{ name?: string | null }> | null;
}

interface PropertyGroupRow {
    id: string;
    name?: string | null;
    filterable?: boolean | null;
    options?: Array<{ id: string }> | null;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
    return Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
        items.slice(i * size, i * size + size)
    );
}

/** All variants of the given parents, keyed by parent ID */
async function loadVariants(
    context: FeatureCheckContext,
    parentIds: string[]
): Promise<Map<string, VariantRow[]>> {
    const batches = await Promise.all(
        chunk(parentIds, PARENTS_PER_QUERY).map((ids) =>
            context.api.searchEntities<VariantRow>(
                "product",
                [{ type: "equalsAny", field: "parentId", value: ids }],
                { limit: 500, associations: { options: {} } }
            )
        )
    );
    const byParent = new Map<string, VariantRow[]>(parentIds.map((id) => [id, []]));
    for (const row of batches.flat()) {
        if (row.parentId) byParent.get(row.parentId)?.push(row);
    }
    return byParent;
}

/** Variant count per product, computed like the variants processor (cache first, then cap) */
export function expectedVariantCounts(
    context: Pick<FeatureCheckContext, "blueprint" | "cache" | "salesChannelName">
): Map<string, { name: string; count: number }> {
    const { maxVariants } = blueprintVariantSettings(context.blueprint);
    const expected = new Map<string, { name: string; count: number }>();
    for (const product of context.blueprint.products) {
        const metadata = context.cache.loadProductMetadata(context.salesChannelName, product.id);
        const configs = metadata?.variantConfigs ?? product.metadata.variantConfigs;
        if (!product.metadata.isVariant || !configs?.length) continue;
        const count = capVariantConfigs(configs, maxVariants).reduce(
            (n, config) => n * config.selectedOptions.length,
            1
        );
        expected.set(product.id, { name: product.name, count });
    }
    return expected;
}

const variants: FeatureCheck = {
    name: "variants",
    async run(context): Promise<FeatureCheckOutcome> {
        const expected = expectedVariantCounts(context);
        if (expected.size === 0) return skip("blueprint has no variant products");

        const byParent = await loadVariants(context, [...expected.keys()]);
        const wrong = [...expected].flatMap(([id, { name, count }]) => {
            const actual = byParent.get(id)?.length ?? 0;
            return actual === count ? [] : [`${name} ${actual}/${count}`];
        });
        const total = [...byParent.values()].reduce((n, rows) => n + rows.length, 0);
        if (wrong.length > 0) return fail(`wrong variant count: ${wrong.join(", ")}`);
        return pass(`${expected.size} products, ${total} variants`);
    },
};

function checkGroupFlags(groups: PropertyGroupRow[], familyOptions: number): string | null {
    const family = groups.find((g) => g.id === COLOR_FAMILY_GROUP_ID);
    if (!family) return `"${COLOR_FAMILY_GROUP_NAME}" group missing`;
    if (family.filterable === false) return `"${COLOR_FAMILY_GROUP_NAME}" is not filterable`;
    const actualOptions = family.options?.length ?? 0;
    if (actualOptions < familyOptions) {
        return `"${COLOR_FAMILY_GROUP_NAME}" has ${actualOptions}/${familyOptions} options`;
    }
    const shades = groups.find((g) => (g.name ?? "").toLowerCase() === "color");
    if (shades?.filterable === true) return `"Color" (shades) is shown in the filter`;
    return null;
}

const colorFamilies: FeatureCheck = {
    name: "color-families",
    async run(context): Promise<FeatureCheckOutcome> {
        const blueprintGroup = context.blueprint.propertyGroups.find(
            (g) => g.name === COLOR_FAMILY_GROUP_NAME
        );
        if (!blueprintGroup) return skip("blueprint has no colour families");

        const groups = await context.api.searchEntities<PropertyGroupRow>(
            "property-group",
            [{ type: "equalsAny", field: "name", value: ["Color", COLOR_FAMILY_GROUP_NAME] }],
            { associations: { options: {} } }
        );
        const problem = checkGroupFlags(groups, blueprintGroup.options.length);
        if (problem) return fail(problem);

        const withFamily = await context.api.searchEntities<{ id: string }>(
            "product",
            [
                visibleIn(context.salesChannelId),
                { type: "equals", field: "properties.groupId", value: COLOR_FAMILY_GROUP_ID },
            ],
            { includes: { product: ["id"] } }
        );
        if (withFamily.length === 0) return fail("no product has a colour family");
        return pass(
            `${blueprintGroup.options.length} families in the filter, ${withFamily.length} products`
        );
    },
};

/** Colour (shade) per variant product, from the cached colour images */
function cachedColorImages(context: FeatureCheckContext): Map<string, Set<string>> {
    const tasks = collectVariantImageTasks(context.blueprint, "all").filter((task) =>
        context.cache.images.hasImageWithView(
            context.salesChannelName,
            task.productId,
            task.view,
            "product_media"
        )
    );
    const shades = new Map<string, Set<string>>();
    for (const task of tasks) {
        const set = shades.get(task.productId) ?? new Set<string>();
        set.add(task.color.name.toLowerCase());
        shades.set(task.productId, set);
    }
    return shades;
}

function hasShade(row: VariantRow, shades: Set<string>): boolean {
    return (row.options ?? []).some((o) => shades.has((o.name ?? "").toLowerCase()));
}

const variantImages: FeatureCheck = {
    name: "variant-images",
    async run(context): Promise<FeatureCheckOutcome> {
        const shadesByProduct = cachedColorImages(context);
        if (shadesByProduct.size === 0) {
            return skip("no cached colour images (image provider without image editing?)");
        }

        const productIds = [...shadesByProduct.keys()];
        const [parents, byParent] = await Promise.all([
            context.api.searchEntities<VariantRow>("product", [], {
                ids: productIds,
                includes: { product: ["id", "coverId"] },
            }),
            loadVariants(context, productIds),
        ]);
        const parentCover = new Map(parents.map((p) => [p.id, p.coverId ?? null]));

        const colourVariants = productIds.flatMap((id) =>
            (byParent.get(id) ?? []).filter((row) =>
                hasShade(row, shadesByProduct.get(id) ?? new Set())
            )
        );
        const inheriting = colourVariants.filter(
            (row) => !row.coverId || row.coverId === parentCover.get(row.parentId ?? "")
        );
        if (colourVariants.length === 0) return fail("no colour variants found in Shopware");
        if (inheriting.length > 0) {
            return fail(
                `${inheriting.length}/${colourVariants.length} colour variants still show the parent image`
            );
        }
        return pass(`${colourVariants.length} colour variants with their own cover`);
    },
};

export const CATALOG_CHECKS: readonly FeatureCheck[] = [variants, colorFamilies, variantImages];
