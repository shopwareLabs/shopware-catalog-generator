/**
 * Array utility functions
 */

/**
 * Generate cartesian product of multiple arrays
 *
 * Example:
 *   cartesianProduct([["S", "M"], ["Red", "Blue"]])
 *   → [["S", "Red"], ["S", "Blue"], ["M", "Red"], ["M", "Blue"]]
 */
export function cartesianProduct<T>(arrays: T[][]): T[][] {
    if (arrays.length === 0) return [];
    if (arrays.some((arr) => arr.length === 0)) return [];

    return arrays.reduce<T[][]>(
        (acc, arr) => acc.flatMap((x) => arr.map((y) => [...x, y])),
        [[]] as T[][]
    );
}

/**
 * Randomly sample a percentage of items from an array
 *
 * @param array - Source array
 * @param minPercent - Minimum percentage to select (0-1)
 * @param maxPercent - Maximum percentage to select (0-1)
 * @returns New array with randomly selected items (at least 1 item)
 */
export function randomSamplePercent<T>(
    array: T[],
    minPercent: number,
    maxPercent: number
): T[] {
    if (array.length === 0) return [];

    const percent = minPercent + Math.random() * (maxPercent - minPercent);
    const count = Math.max(1, Math.round(array.length * percent));

    // Shuffle and take first N items
    const shuffled = [...array].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
}

/**
 * Randomly pick N items from an array without replacement
 */
export function randomSample<T>(array: T[], count: number): T[] {
    if (array.length === 0 || count <= 0) return [];

    const shuffled = [...array].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, array.length));
}

/**
 * Pick a random item from an array based on weighted probabilities
 *
 * @param items - Array of items to choose from
 * @param weights - Corresponding weights (should sum to 1, but will be normalized)
 * @returns Randomly selected item
 */
export function weightedRandomPick<T>(items: T[], weights: number[]): T {
    if (items.length === 0) {
        throw new Error("Cannot pick from empty array");
    }
    if (items.length !== weights.length) {
        throw new Error("Items and weights must have same length");
    }

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    const random = Math.random() * totalWeight;

    let cumulative = 0;
    for (let i = 0; i < items.length; i++) {
        const weight = weights[i];
        const item = items[i];
        if (weight === undefined || item === undefined) continue;

        cumulative += weight;
        if (random < cumulative) {
            return item;
        }
    }

    // Fallback to last item (won't be undefined due to length check)
    return items[items.length - 1]!;
}

/**
 * Pick a random item from an array
 */
export function randomPick<T>(array: T[]): T {
    if (array.length === 0) {
        throw new Error("Cannot pick from empty array");
    }
    return array[Math.floor(Math.random() * array.length)]!;
}
