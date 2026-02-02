import { describe, expect, test } from "bun:test";

import { generateUUID, generateAccessKey } from "../../../src/utils/uuid.js";

describe("UUID Utilities", () => {
    describe("generateUUID", () => {
        test("generates 32-character string", () => {
            const uuid = generateUUID();
            expect(uuid.length).toBe(32);
        });

        test("generates only hexadecimal characters", () => {
            const uuid = generateUUID();
            expect(uuid).toMatch(/^[0-9a-f]+$/);
        });

        test("does not contain dashes", () => {
            const uuid = generateUUID();
            expect(uuid).not.toContain("-");
        });

        test("generates unique UUIDs", () => {
            const uuids = new Set<string>();
            for (let i = 0; i < 100; i++) {
                uuids.add(generateUUID());
            }
            expect(uuids.size).toBe(100);
        });
    });

    describe("generateAccessKey", () => {
        test("generates 32-character string", () => {
            const key = generateAccessKey();
            expect(key.length).toBe(32);
        });

        test("starts with SW", () => {
            const key = generateAccessKey();
            expect(key.startsWith("SW")).toBe(true);
        });

        test("contains only uppercase letters and digits after SW prefix", () => {
            const key = generateAccessKey();
            const suffix = key.slice(2);
            expect(suffix).toMatch(/^[A-Z0-9]+$/);
        });

        test("generates unique access keys", () => {
            const keys = new Set<string>();
            for (let i = 0; i < 100; i++) {
                keys.add(generateAccessKey());
            }
            expect(keys.size).toBe(100);
        });
    });
});
