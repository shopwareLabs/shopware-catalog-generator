import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
    BlueprintProduct,
    BlueprintPropertyGroup,
    HydratedBlueprint,
} from "../../src/types/index.js";

import {
    findBlueprintFiles,
    generateVariantConfigs,
    migrateBlueprint,
    migrateBlueprintFiles,
    parseArgs,
} from "../../src/migrate-variants.js";
import { createTestBlueprint, createTestProduct } from "../helpers/blueprint-factory.js";

function group(name: string, options: string[]): BlueprintPropertyGroup {
    return {
        id: `group-${name}`,
        name,
        displayType: "text",
        options: options.map((option) => ({ id: `${name}-${option}`, name: option })),
    };
}

const SIZE = group("Size", ["S", "M", "L", "XL", "Oversized"]);
const MATERIAL = group("Material", ["Plastic", "Wood", "Metal"]);
const FINISH = group("Finish", ["Matte", "Gloss"]);
const SINGLE = group("Single", ["Only"]);

let randomSpy: ReturnType<typeof spyOn> | undefined;

function mockRandom(value: number): void {
    randomSpy = spyOn(Math, "random").mockReturnValue(value);
}

afterEach(() => {
    randomSpy?.mockRestore();
    randomSpy = undefined;
});

describe("generateVariantConfigs", () => {
    test("returns no configs when no group has at least two options", () => {
        expect(generateVariantConfigs([SINGLE], [])).toEqual([]);
        expect(generateVariantConfigs([], undefined)).toEqual([]);
    });

    test("uses one group when the weighted pick is 1 and prefers groups the product uses", () => {
        mockRandom(0);
        const configs = generateVariantConfigs(
            [SIZE, MATERIAL, SINGLE],
            [{ group: "Material", value: "Wood" }]
        );

        expect(configs).toHaveLength(1);
        expect(configs[0]?.group).toBe("Material");
    });

    test("keeps the blueprint order when the product uses none of the groups", () => {
        mockRandom(0);
        const configs = generateVariantConfigs([SIZE, MATERIAL], undefined);

        expect(configs.map((c) => c.group)).toEqual(["Size"]);
    });

    test("uses up to three groups and never more than are eligible", () => {
        mockRandom(0.99);
        const configs = generateVariantConfigs([SIZE, MATERIAL, FINISH, SINGLE], []);
        expect(configs.map((c) => c.group)).toEqual(["Size", "Material", "Finish"]);

        const fewer = generateVariantConfigs([SIZE, SINGLE], []);
        expect(fewer.map((c) => c.group)).toEqual(["Size"]);
    });

    test("uses two groups for a mid-range weighted pick", () => {
        mockRandom(0.6);
        const configs = generateVariantConfigs([SIZE, MATERIAL, FINISH], []);

        expect(configs.map((c) => c.group)).toEqual(["Size", "Material"]);
    });

    test("falls back to the first two options when the sample is too small", () => {
        mockRandom(0);
        const configs = generateVariantConfigs([MATERIAL], []);

        expect(configs[0]?.selectedOptions).toEqual(["Plastic", "Wood"]);
    });

    test("keeps a sample of exactly two options instead of falling back", () => {
        // With Math.random() = 0 the shuffle reverses the options and 40% of 5 is 2
        mockRandom(0);
        const [config] = generateVariantConfigs([SIZE], []);

        expect(config?.selectedOptions).toEqual(["Oversized", "XL"]);
    });

    test("keeps a sample of two or more options", () => {
        mockRandom(0.99);
        const [config] = generateVariantConfigs([SIZE], []);

        expect(config?.selectedOptions).toHaveLength(3);
        expect(SIZE.options.map((o) => o.name)).toEqual(
            expect.arrayContaining(config?.selectedOptions ?? [])
        );
    });

    test("sets known price modifiers and 1.0 for unknown options", () => {
        mockRandom(0);
        const [material] = generateVariantConfigs([MATERIAL], []);
        expect(material?.priceModifiers).toEqual({ Plastic: 0.8, Wood: 1.0 });

        const [finish] = generateVariantConfigs([FINISH], []);
        expect(finish?.priceModifiers).toEqual({ Matte: 1.0, Gloss: 1.0 });
    });
});

describe("migrateBlueprint", () => {
    let dir: string;
    let logSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-variants-"));
        logSpy = spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function writeBlueprint(blueprint: HydratedBlueprint): string {
        const filePath = path.join(dir, "hydrated-blueprint.json");
        fs.writeFileSync(filePath, JSON.stringify(blueprint));
        return filePath;
    }

    function readProducts(filePath: string): BlueprintProduct[] {
        const blueprint: HydratedBlueprint = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        return blueprint.products;
    }

    function legacyVariant(id: string): BlueprintProduct {
        const product = createTestProduct({ id, name: `Product ${id}` });
        Object.assign(product.metadata, {
            isVariant: true,
            variantProperty: "Size",
            variantPriceModifiers: { S: 0.9 },
        });
        return product;
    }

    test("migrates legacy variant products and removes the legacy fields", () => {
        mockRandom(0);
        const filePath = writeBlueprint(
            createTestBlueprint({ products: [legacyVariant("a")], propertyGroups: [SIZE] })
        );

        const result = migrateBlueprint(filePath, false);

        expect(result).toEqual({ migrated: 1, skipped: 0, errors: [] });
        const [product] = readProducts(filePath);
        expect(product?.metadata.variantConfigs?.[0]?.group).toBe("Size");
        expect(product?.metadata).not.toHaveProperty("variantProperty");
        expect(product?.metadata).not.toHaveProperty("variantPriceModifiers");
    });

    test("ignores products that are not variants", () => {
        const plain = createTestProduct({ id: "plain" });
        plain.metadata.isVariant = false;
        const filePath = writeBlueprint(
            createTestBlueprint({ products: [plain], propertyGroups: [SIZE] })
        );
        const before = fs.readFileSync(filePath, "utf-8");

        expect(migrateBlueprint(filePath, false)).toEqual({ migrated: 0, skipped: 0, errors: [] });
        expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    });

    test("skips products that already have configs with more than two options", () => {
        const done = legacyVariant("done");
        done.metadata.variantConfigs = [
            { group: "Size", selectedOptions: ["S", "M", "L"], priceModifiers: {} },
        ];
        const filePath = writeBlueprint(
            createTestBlueprint({ products: [done], propertyGroups: [SIZE] })
        );

        expect(migrateBlueprint(filePath, false)).toEqual({ migrated: 0, skipped: 1, errors: [] });
    });

    test("re-migrates products whose configs have two or fewer options", () => {
        mockRandom(0.99);
        const shallow = legacyVariant("shallow");
        shallow.metadata.variantConfigs = [
            { group: "Size", selectedOptions: ["S", "M"], priceModifiers: {} },
        ];
        const filePath = writeBlueprint(
            createTestBlueprint({ products: [shallow], propertyGroups: [SIZE] })
        );

        expect(migrateBlueprint(filePath, false).migrated).toBe(1);
        expect(
            readProducts(filePath)[0]?.metadata.variantConfigs?.[0]?.selectedOptions
        ).toHaveLength(3);
    });

    test("re-migrates products whose configs have fewer than two options", () => {
        mockRandom(0);
        const thin = legacyVariant("thin");
        thin.metadata.variantConfigs = [
            { group: "Size", selectedOptions: ["S"], priceModifiers: {} },
        ];
        const filePath = writeBlueprint(
            createTestBlueprint({ products: [thin], propertyGroups: [SIZE] })
        );

        expect(migrateBlueprint(filePath, false).migrated).toBe(1);
    });

    test("skips variant products when the blueprint has no usable property groups", () => {
        const blueprint = createTestBlueprint({ products: [legacyVariant("a")] });
        Reflect.deleteProperty(blueprint, "propertyGroups");
        const filePath = writeBlueprint(blueprint);

        expect(migrateBlueprint(filePath, false)).toEqual({ migrated: 0, skipped: 1, errors: [] });
    });

    test("does not write the file in dry-run mode but logs a summary per product", () => {
        mockRandom(0);
        const filePath = writeBlueprint(
            createTestBlueprint({ products: [legacyVariant("a")], propertyGroups: [SIZE] })
        );
        const before = fs.readFileSync(filePath, "utf-8");

        const result = migrateBlueprint(filePath, true);

        expect(result.migrated).toBe(1);
        expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
        expect(logSpy).toHaveBeenCalledWith("    Product a: Size(2)");
    });

    test("does not log product summaries outside dry-run mode", () => {
        mockRandom(0);
        const filePath = writeBlueprint(
            createTestBlueprint({ products: [legacyVariant("a")], propertyGroups: [SIZE] })
        );

        migrateBlueprint(filePath, false);

        expect(logSpy).not.toHaveBeenCalled();
    });

    test("reports unreadable files as errors", () => {
        const filePath = path.join(dir, "broken.json");
        fs.writeFileSync(filePath, "{ not json");

        const result = migrateBlueprint(filePath, false);

        expect(result.migrated).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toStartWith(`${filePath}: `);
        // The error message is used, not the "SyntaxError: ..." string form
        expect(result.errors[0]).not.toContain("SyntaxError");
    });
});

describe("findBlueprintFiles", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-find-"));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test("returns an empty list when the cache directory is missing", () => {
        expect(findBlueprintFiles(path.join(dir, "missing"))).toEqual([]);
    });

    test("returns only SalesChannels that have a hydrated blueprint", () => {
        fs.mkdirSync(path.join(dir, "music"));
        fs.mkdirSync(path.join(dir, "empty"));
        fs.writeFileSync(path.join(dir, "music", "hydrated-blueprint.json"), "{}");

        expect(findBlueprintFiles(dir)).toEqual([
            path.join(dir, "music", "hydrated-blueprint.json"),
        ]);
    });
});

describe("parseArgs", () => {
    test("reads long and short flags", () => {
        expect(parseArgs([])).toEqual({ dryRun: false, help: false });
        expect(parseArgs(["--dry-run"])).toEqual({ dryRun: true, help: false });
        expect(parseArgs(["-n"])).toEqual({ dryRun: true, help: false });
        expect(parseArgs(["--help"])).toEqual({ dryRun: false, help: true });
        expect(parseArgs(["-h"])).toEqual({ dryRun: false, help: true });
    });
});

describe("migrateBlueprintFiles", () => {
    let dir: string;
    let logSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-files-"));
        logSpy = spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function writeStore(name: string, content: string): string {
        fs.mkdirSync(path.join(dir, name));
        const filePath = path.join(dir, name, "hydrated-blueprint.json");
        fs.writeFileSync(filePath, content);
        return filePath;
    }

    function variantBlueprint(): string {
        const product = createTestProduct({ id: "v" });
        product.metadata.isVariant = true;
        return JSON.stringify(createTestBlueprint({ products: [product], propertyGroups: [SIZE] }));
    }

    test("sums the results of all files and collects their errors", () => {
        mockRandom(0);
        const files = [
            writeStore("music", variantBlueprint()),
            writeStore("garden", variantBlueprint()),
            writeStore("broken", "nope"),
        ];

        const totals = migrateBlueprintFiles(files, false);

        expect(totals.migrated).toBe(2);
        expect(totals.skipped).toBe(0);
        expect(totals.errors).toHaveLength(1);
        expect(totals.errors[0]).toContain("broken");
    });

    test("sums skipped products across files", () => {
        const files = [
            writeStore("a", JSON.stringify(createTestBlueprint({ products: [] }))),
            writeStore(
                "b",
                JSON.stringify(
                    createTestBlueprint({
                        products: [
                            createTestProduct({ metadata: { isVariant: true } }),
                            createTestProduct({ id: "p2", metadata: { isVariant: true } }),
                        ],
                    })
                )
            ),
        ];

        expect(migrateBlueprintFiles(files, false)).toEqual({
            migrated: 0,
            skipped: 2,
            errors: [],
        });
    });

    test("logs one processing and one summary line per file", () => {
        mockRandom(0);
        const files = [writeStore("music", variantBlueprint())];

        migrateBlueprintFiles(files, false);

        expect(logSpy).toHaveBeenCalledWith("  Processing: music");
        expect(logSpy).toHaveBeenCalledWith("    ✓ Migrated 1 products, skipped 0");
    });

    test("logs a dry-run summary in dry-run mode", () => {
        mockRandom(0);
        const files = [writeStore("music", variantBlueprint())];

        migrateBlueprintFiles(files, true);

        expect(logSpy).toHaveBeenCalledWith("    [DRY RUN] Would migrate 1 products, skip 0");
    });

    test("returns zero totals for no files", () => {
        expect(migrateBlueprintFiles([], false)).toEqual({ migrated: 0, skipped: 0, errors: [] });
    });
});
