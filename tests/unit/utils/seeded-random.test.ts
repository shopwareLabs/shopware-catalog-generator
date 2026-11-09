import { describe, expect, test } from "bun:test";

import { createSeededRandom, seededPick } from "../../../src/utils/seeded-random.js";
import { deterministicUUID } from "../../../src/utils/uuid.js";

describe("createSeededRandom", () => {
    test("repeats the same sequence for the same seed", () => {
        const a = createSeededRandom("seed");
        const b = createSeededRandom("seed");
        expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    });

    test("differs between seeds", () => {
        expect(createSeededRandom("one")()).not.toBe(createSeededRandom("two")());
    });

    test("returns numbers in [0, 1)", () => {
        const random = createSeededRandom("range");
        const values = Array.from({ length: 1000 }, () => random());
        expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    });
});

describe("seededPick", () => {
    test("picks deterministically", () => {
        const items = ["a", "b", "c", "d"];
        expect(seededPick(items, createSeededRandom("x"))).toBe(
            seededPick(items, createSeededRandom("x"))
        );
    });

    test("throws on an empty list", () => {
        expect(() => seededPick([], createSeededRandom("x"))).toThrow();
    });
});

describe("deterministicUUID", () => {
    test("returns a stable 32-character hex ID", () => {
        const id = deterministicUUID("review:p1:0");
        expect(id).toMatch(/^[0-9a-f]{32}$/);
        expect(deterministicUUID("review:p1:0")).toBe(id);
        expect(deterministicUUID("review:p1:1")).not.toBe(id);
    });
});
