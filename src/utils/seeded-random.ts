/**
 * Seeded random numbers - deterministic "random" choices that repeat on every run.
 *
 * Used where generated content must be stable across runs, e.g. review texts that are
 * translated in Phase 2 and uploaded in Phase 3.
 */

import { createHash } from "node:crypto";

/**
 * Create a random number generator seeded from a string (mulberry32).
 *
 * @param seed - Any string; the same seed always yields the same sequence
 * @returns Function returning numbers in [0, 1)
 */
export function createSeededRandom(seed: string): () => number {
    let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Pick an item using a seeded random function.
 */
export function seededPick<T>(items: readonly T[], random: () => number): T {
    if (items.length === 0) {
        throw new Error("Cannot pick from empty array");
    }
    return items[Math.floor(random() * items.length)] as T;
}
