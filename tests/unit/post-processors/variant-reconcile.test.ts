import { describe, expect, test } from "bun:test";

import {
    isVariantPlanEmpty,
    planVariantReconcile,
} from "../../../src/post-processors/variant-reconcile.js";

const red = { id: "red" };
const blue = { id: "blue" };
const small = { id: "s" };
const large = { id: "l" };

const combos = [
    [red, small],
    [red, large],
    [blue, small],
    [blue, large],
];

describe("planVariantReconcile", () => {
    test("creates everything for a product without variants", () => {
        const plan = planVariantReconcile(combos, { children: [], settings: [] });

        expect(plan.missingCombos).toEqual(combos);
        expect(plan.missingOptionIds).toEqual(["red", "s", "l", "blue"]);
        expect(plan.staleChildIds).toEqual([]);
        expect(plan.staleSettingIds).toEqual([]);
    });

    test("is empty when every variant and setting exists, in any option order", () => {
        const plan = planVariantReconcile(combos, {
            children: [
                { id: "c1", optionIds: ["s", "red"] },
                { id: "c2", optionIds: ["red", "l"] },
                { id: "c3", optionIds: ["blue", "s"] },
                { id: "c4", optionIds: ["l", "blue"] },
            ],
            settings: ["red", "blue", "s", "l"].map((optionId) => ({
                id: `cs-${optionId}`,
                optionId,
            })),
        });

        expect(isVariantPlanEmpty(plan)).toBe(true);
    });

    test("only adds what an interrupted run did not create", () => {
        const plan = planVariantReconcile(combos, {
            children: [{ id: "c1", optionIds: ["red", "s"] }],
            settings: [{ id: "cs-red", optionId: "red" }],
        });

        expect(plan.missingCombos).toEqual([
            [red, large],
            [blue, small],
            [blue, large],
        ]);
        expect(plan.missingOptionIds).toEqual(["s", "l", "blue"]);
        expect(isVariantPlanEmpty(plan)).toBe(false);
    });

    test("removes variants and settings of options that left the blueprint", () => {
        const plan = planVariantReconcile([[red], [blue]], {
            children: [
                { id: "c-red", optionIds: ["red"] },
                { id: "c-green", optionIds: ["green"] },
                { id: "c-red-s", optionIds: ["red", "s"] },
            ],
            settings: [
                { id: "cs-red", optionId: "red" },
                { id: "cs-green", optionId: "green" },
            ],
        });

        expect(plan.staleChildIds).toEqual(["c-green", "c-red-s"]);
        expect(plan.staleSettingIds).toEqual(["cs-green"]);
        expect(plan.missingCombos).toEqual([[blue]]);
        expect(plan.missingOptionIds).toEqual(["blue"]);
    });
});
