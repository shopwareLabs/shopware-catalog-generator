/**
 * Manufacturer hydrator - fictional brands that fit the store
 *
 * Product hydration hands every branch a few placeholder brands built from fixed word lists
 * ("Artisan Home", "Premium Craft"). They are the same in every store, and manufacturers are
 * global in Shopware, so all stores on a shop end up sharing them. This pass asks the AI once
 * per store for fictional brands per category branch and swaps them in. Products that shared
 * a brand still share one, so the grouping per branch stays.
 */

import { z } from "zod";

import type {
    BlueprintCategory,
    BlueprintProduct,
    HydratedBlueprint,
    TextProvider,
} from "../../types/index.js";
import type { StoreContext } from "./product.js";

import { executeWithRetry, logger } from "../../utils/index.js";
import { flattenCategories } from "./category.js";
import { groupProductsByBranch } from "./product.js";

const EXAMPLE_PRODUCTS = 4;

const ManufacturerResponseSchema = z.object({
    branches: z.array(z.object({ index: z.number().int(), brands: z.array(z.string()) })),
});

/** One category branch and the placeholder brands its products use */
interface BranchBrands {
    name: string;
    products: BlueprintProduct[];
    /** Distinct brands in order of first use */
    brands: string[];
}

function distinctBrands(products: BlueprintProduct[]): string[] {
    const names = products
        .map((p) => p.metadata.manufacturerName?.trim())
        .filter((n): n is string => Boolean(n));
    return [...new Set(names)];
}

function collectBranches(blueprint: Pick<HydratedBlueprint, "categories" | "products">) {
    const categories = new Map<string, BlueprintCategory>(
        flattenCategories(blueprint.categories).map((c) => [c.id, c])
    );
    return [...groupProductsByBranch(blueprint.products)]
        .map(([id, products]) => ({
            name: categories.get(id)?.name ?? "Other",
            products,
            brands: distinctBrands(products),
        }))
        .filter((branch) => branch.brands.length > 0);
}

function describeBranch(branch: BranchBrands, index: number): string {
    const examples = branch.products.slice(0, EXAMPLE_PRODUCTS).map((p) => p.name);
    return `${index}. ${branch.name} | ${branch.brands.length} brands | products: ${examples.join("; ")}`;
}

function buildMessages(
    branches: BranchBrands[],
    store: StoreContext
): Array<{ role: "system" | "user"; content: string }> {
    return [
        {
            role: "system",
            content: "You invent brand names for an online shop. You ONLY output valid JSON.",
        },
        {
            role: "user",
            content: [
                `Store: "${store.name}"`,
                `Description: ${store.description}`,
                "",
                "Invent the manufacturers (brands) for each category of this shop.",
                "",
                "Rules:",
                "- fictional: never a real brand or trademark, and not close to one",
                "- each brand sounds like a maker of these products, not a generic word pair",
                "- 1 to 3 words, no legal forms like Inc. or GmbH",
                "- every brand unique across all categories",
                "- exactly the number of brands asked for per category",
                "- keep the index of each category",
                "",
                "Categories:",
                ...branches.map((b, i) => describeBranch(b, i + 1)),
                "",
                'Return JSON: {"branches":[{"index":1,"brands":["..."]}]}',
            ].join("\n"),
        },
    ];
}

function parseBrands(response: string, count: number): Map<number, string[]> {
    const json = response
        .replace(/```json?\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
    const parsed = ManufacturerResponseSchema.parse(JSON.parse(json));
    return new Map(
        parsed.branches
            .filter((b) => b.index >= 1 && b.index <= count)
            .map((b) => [b.index, b.brands.map((n) => n.trim()).filter(Boolean)])
    );
}

/**
 * Old brand → new brand. A branch only gets new brands when the AI returned enough unused
 * ones, so a short answer never merges brands.
 */
function buildRenames(branches: BranchBrands[], proposals: Map<number, string[]>) {
    const used = new Set<string>();
    const renames = new Map<string, string>();
    branches.forEach((branch, i) => {
        const fresh = (proposals.get(i + 1) ?? []).filter((n) => !used.has(n.toLowerCase()));
        const unique = [...new Map(fresh.map((n) => [n.toLowerCase(), n])).values()];
        if (unique.length < branch.brands.length) return;
        branch.brands.forEach((old, j) => {
            const brand = unique[j] as string;
            used.add(brand.toLowerCase());
            renames.set(`${i}:${old}`, brand);
        });
    });
    return renames;
}

/** Result of a manufacturer pass */
export interface ManufacturerHydrationResult {
    products: BlueprintProduct[];
    /** Distinct brands after the pass */
    manufacturers: string[];
    /** Category branches that got new brands */
    branches: number;
}

/**
 * Replace the placeholder brands with fictional brands for this store (one AI call).
 * On a failed call the products keep their brands.
 */
export async function hydrateManufacturers(
    textProvider: TextProvider,
    blueprint: Pick<HydratedBlueprint, "categories" | "products">,
    store: StoreContext
): Promise<ManufacturerHydrationResult> {
    const branches = collectBranches(blueprint);
    if (branches.length === 0) {
        return { products: blueprint.products, manufacturers: [], branches: 0 };
    }

    logger.info(`  Inventing brands for ${branches.length} categories...`, { cli: true });
    const proposals = await fetchBrands(textProvider, branches, store);
    const renames = buildRenames(branches, proposals);
    const branchIndex = new Map(
        branches.flatMap((b, i) => b.products.map((p) => [p.id, i] as const))
    );
    const products = blueprint.products.map((product) => {
        const old = product.metadata.manufacturerName?.trim();
        const brand = old && renames.get(`${branchIndex.get(product.id)}:${old}`);
        if (!brand) return product;
        return { ...product, metadata: { ...product.metadata, manufacturerName: brand } };
    });
    const renamedBranches = new Set([...renames.keys()].map((k) => k.split(":")[0])).size;
    return { products, manufacturers: distinctBrands(products), branches: renamedBranches };
}

async function fetchBrands(
    textProvider: TextProvider,
    branches: BranchBrands[],
    store: StoreContext
): Promise<Map<number, string[]>> {
    try {
        const response = await executeWithRetry(() =>
            textProvider.generateCompletion(
                buildMessages(branches, store),
                ManufacturerResponseSchema,
                "Manufacturers"
            )
        );
        return parseBrands(response, branches.length);
    } catch (error) {
        logger.warn("Manufacturer request failed, keeping the current brands", {
            cli: true,
            data: { error: error instanceof Error ? error.message : String(error) },
        });
        return new Map();
    }
}
