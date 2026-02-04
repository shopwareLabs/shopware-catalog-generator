import { describe, expect, test } from "bun:test";

import type { HydratedBlueprint } from "../../../src/types/index.js";

import { PropertyCollector } from "../../../src/utils/property-collector.js";

function createMockBlueprint(
    products: Array<{
        id: string;
        properties: Array<{ group: string; value: string }>;
        manufacturerName?: string;
    }>
): HydratedBlueprint {
    return {
        version: "1.0",
        salesChannel: {
            name: "test-store",
            description: "Test store",
        },
        categories: [],
        products: products.map((p) => ({
            id: p.id,
            name: `Product ${p.id}`,
            description: "Test description",
            price: 29.99,
            stock: 10,
            primaryCategoryId: "cat1",
            categoryIds: ["cat1"],
            metadata: {
                imageCount: 1 as const,
                imageDescriptions: [],
                isVariant: false,
                properties: p.properties,
                manufacturerName: p.manufacturerName,
                reviewCount: 0 as const,
                hasSalesPrice: false,
            },
        })),
        propertyGroups: [],
        createdAt: new Date().toISOString(),
        hydratedAt: new Date().toISOString(),
    };
}

describe("PropertyCollector", () => {
    describe("collectFromBlueprint", () => {
        test("collects unique property groups", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [{ group: "Color", value: "Red" }] },
                { id: "2", properties: [{ group: "Color", value: "Blue" }] },
                { id: "3", properties: [{ group: "Size", value: "Large" }] },
            ]);

            const groups = collector.collectFromBlueprint(blueprint);

            expect(groups.length).toBe(2);
            expect(groups.map((g) => g.name)).toContain("Color");
            expect(groups.map((g) => g.name)).toContain("Size");
        });

        test("deduplicates property values within groups", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [{ group: "Color", value: "Red" }] },
                { id: "2", properties: [{ group: "Color", value: "Red" }] },
                { id: "3", properties: [{ group: "Color", value: "Blue" }] },
            ]);

            const groups = collector.collectFromBlueprint(blueprint);
            const colorGroup = groups.find((g) => g.name === "Color");

            expect(colorGroup).toBeDefined();
            expect(colorGroup?.options.length).toBe(2); // Red and Blue
            expect(colorGroup?.options.map((o) => o.name)).toContain("Red");
            expect(colorGroup?.options.map((o) => o.name)).toContain("Blue");
        });

        test("generates UUIDs for groups and options", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [{ group: "Color", value: "Red" }] },
            ]);

            const groups = collector.collectFromBlueprint(blueprint);

            expect(groups[0]?.id).toMatch(/^[0-9a-f]{32}$/);
            expect(groups[0]?.options[0]?.id).toMatch(/^[0-9a-f]{32}$/);
        });

        test("sets displayType to color for Color group even without existing", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [{ group: "Color", value: "Red" }] },
                { id: "2", properties: [{ group: "Material", value: "Wood" }] },
            ]);

            // Color group is automatically "color" type, others are "text"
            const groups = collector.collectFromBlueprint(blueprint);
            const colorGroup = groups.find((g) => g.name === "Color");
            const materialGroup = groups.find((g) => g.name === "Material");

            expect(colorGroup?.displayType).toBe("color");
            expect(materialGroup?.displayType).toBe("text");
        });

        test("inherits displayType color from existing groups", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [{ group: "Color", value: "Red" }] },
            ]);

            const existingProperties = [
                {
                    id: "existing-color",
                    name: "Color",
                    displayType: "color" as const,
                    options: [],
                },
            ];

            const groups = collector.collectFromBlueprint(blueprint, existingProperties);
            const colorGroup = groups.find((g) => g.name === "Color");

            expect(colorGroup?.displayType).toBe("color");
        });

        test("sets colorHexCode for Color groups even without existing", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [{ group: "Color", value: "Red" }] },
                { id: "2", properties: [{ group: "Color", value: "Blue" }] },
            ]);

            // Color groups get hex codes automatically (fresh store scenario)
            const groups = collector.collectFromBlueprint(blueprint);
            const colorGroup = groups.find((g) => g.name === "Color");
            expect(colorGroup?.options.find((o) => o.name === "Red")?.colorHexCode).toBe("#dc2626");
            expect(colorGroup?.options.find((o) => o.name === "Blue")?.colorHexCode).toBe("#2563eb");
        });

        test("sets colorHexCode for Color groups with existing properties", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [{ group: "Color", value: "Red" }] },
                { id: "2", properties: [{ group: "Color", value: "Blue" }] },
            ]);

            // With existing color group, hex codes are still generated
            const existingProperties = [
                {
                    id: "existing-color",
                    name: "Color",
                    displayType: "color" as const,
                    options: [],
                },
            ];
            const groupsWithExisting = collector.collectFromBlueprint(blueprint, existingProperties);
            const colorGroupWithExisting = groupsWithExisting.find((g) => g.name === "Color");
            expect(colorGroupWithExisting?.options.find((o) => o.name === "Red")?.colorHexCode).toBe("#dc2626");
            expect(colorGroupWithExisting?.options.find((o) => o.name === "Blue")?.colorHexCode).toBe("#2563eb");
        });

        test("merges with existing properties", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [{ group: "Color", value: "Red" }] },
            ]);

            const existingProperties = [
                {
                    id: "existing-color-group",
                    name: "Color",
                    displayType: "color",
                    options: [
                        { id: "existing-blue", name: "Blue" },
                        { id: "existing-green", name: "Green" },
                    ],
                },
            ];

            const groups = collector.collectFromBlueprint(blueprint, existingProperties);
            const colorGroup = groups.find((g) => g.name === "Color");

            expect(colorGroup?.options.length).toBe(3); // Red, Blue, Green
            expect(colorGroup?.options.map((o) => o.name)).toContain("Red");
            expect(colorGroup?.options.map((o) => o.name)).toContain("Blue");
            expect(colorGroup?.options.map((o) => o.name)).toContain("Green");
        });

        test("reuses existing group ID", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [{ group: "Color", value: "Red" }] },
            ]);

            const existingProperties = [
                {
                    id: "existing-color-group-id",
                    name: "Color",
                    displayType: "color",
                    options: [{ id: "existing-blue-id", name: "Blue" }],
                },
            ];

            const groups = collector.collectFromBlueprint(blueprint, existingProperties);
            const colorGroup = groups.find((g) => g.name === "Color");

            // Should reuse existing group ID
            expect(colorGroup?.id).toBe("existing-color-group-id");
        });

        test("reuses existing option IDs for matching values", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [{ group: "Color", value: "Blue" }] }, // Matches existing
                { id: "2", properties: [{ group: "Color", value: "Red" }] }, // New value
            ]);

            const existingProperties = [
                {
                    id: "existing-color-group",
                    name: "Color",
                    displayType: "color",
                    options: [{ id: "existing-blue-id", name: "Blue", colorHexCode: "#0000ff" }],
                },
            ];

            const groups = collector.collectFromBlueprint(blueprint, existingProperties);
            const colorGroup = groups.find((g) => g.name === "Color");

            // Blue should reuse existing ID
            const blueOpt = colorGroup?.options.find((o) => o.name === "Blue");
            expect(blueOpt?.id).toBe("existing-blue-id");
            expect(blueOpt?.colorHexCode).toBe("#0000ff"); // Preserve existing hex

            // Red should have a new UUID
            const redOpt = colorGroup?.options.find((o) => o.name === "Red");
            expect(redOpt?.id).toMatch(/^[0-9a-f]{32}$/);
            expect(redOpt?.id).not.toBe("existing-blue-id");
        });

        test("preserves existing name casing", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [{ group: "color", value: "blue" }] }, // lowercase
            ]);

            const existingProperties = [
                {
                    id: "existing-color-group",
                    name: "Color", // Capitalized
                    displayType: "color",
                    options: [{ id: "existing-blue", name: "Blue" }], // Capitalized
                },
            ];

            const groups = collector.collectFromBlueprint(blueprint, existingProperties);
            const colorGroup = groups.find((g) => g.name === "Color");

            // Should use existing name casing
            expect(colorGroup?.name).toBe("Color"); // Not "color"
            expect(colorGroup?.options[0]?.name).toBe("Blue"); // Not "blue"
        });

        test("generates new IDs for non-matching groups", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [{ group: "Material", value: "Wood" }] },
            ]);

            const existingProperties = [
                {
                    id: "existing-color-group",
                    name: "Color",
                    displayType: "color",
                    options: [{ id: "existing-blue", name: "Blue" }],
                },
            ];

            const groups = collector.collectFromBlueprint(blueprint, existingProperties);
            const materialGroup = groups.find((g) => g.name === "Material");

            // Material is new, should have generated UUID
            expect(materialGroup?.id).toMatch(/^[0-9a-f]{32}$/);
            expect(materialGroup?.id).not.toBe("existing-color-group");
        });

        test("handles empty properties", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [] },
                { id: "2", properties: [] },
            ]);

            const groups = collector.collectFromBlueprint(blueprint);

            expect(groups.length).toBe(0);
        });

        test("ignores empty group names and values", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [{ group: "", value: "Red" }] },
                { id: "2", properties: [{ group: "Color", value: "" }] },
                { id: "3", properties: [{ group: "Color", value: "Blue" }] },
            ]);

            const groups = collector.collectFromBlueprint(blueprint);

            expect(groups.length).toBe(1);
            expect(groups[0]?.name).toBe("Color");
            expect(groups[0]?.options.length).toBe(1);
            expect(groups[0]?.options[0]?.name).toBe("Blue");
        });
    });

    describe("collectManufacturers", () => {
        test("collects unique manufacturer names", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [], manufacturerName: "Acme Corp" },
                { id: "2", properties: [], manufacturerName: "Acme Corp" },
                { id: "3", properties: [], manufacturerName: "Best Inc" },
            ]);

            const manufacturers = collector.collectManufacturers(blueprint);

            expect(manufacturers.length).toBe(2);
            expect(manufacturers).toContain("Acme Corp");
            expect(manufacturers).toContain("Best Inc");
        });

        test("ignores empty manufacturer names", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [], manufacturerName: "" },
                { id: "2", properties: [], manufacturerName: "  " },
                { id: "3", properties: [], manufacturerName: "Acme Corp" },
            ]);

            const manufacturers = collector.collectManufacturers(blueprint);

            expect(manufacturers.length).toBe(1);
            expect(manufacturers).toContain("Acme Corp");
        });

        test("handles missing manufacturer names", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [] },
                { id: "2", properties: [] },
            ]);

            const manufacturers = collector.collectManufacturers(blueprint);

            expect(manufacturers.length).toBe(0);
        });
    });

    describe("createOptionIdMap", () => {
        test("creates mapping from group:value to option id", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [{ group: "Color", value: "Red" }] },
            ]);

            const groups = collector.collectFromBlueprint(blueprint);
            const optionIdMap = collector.createOptionIdMap(groups);

            const optionId = optionIdMap.get("color:red");
            expect(optionId).toBeDefined();
            expect(optionId).toMatch(/^[0-9a-f]{32}$/);
        });

        test("getOptionId returns correct ID", () => {
            const collector = new PropertyCollector();
            const blueprint = createMockBlueprint([
                { id: "1", properties: [{ group: "Color", value: "Red" }] },
            ]);

            const groups = collector.collectFromBlueprint(blueprint);
            const optionIdMap = collector.createOptionIdMap(groups);

            const optionId = collector.getOptionId(optionIdMap, "Color", "Red");
            expect(optionId).toBeDefined();

            const nonExistent = collector.getOptionId(optionIdMap, "Color", "Purple");
            expect(nonExistent).toBeUndefined();
        });
    });
});
