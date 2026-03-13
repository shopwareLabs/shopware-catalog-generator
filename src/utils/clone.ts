/**
 * Typed deep-clone wrapper around structuredClone.
 *
 * Single point of change if the cloning strategy ever needs to be swapped
 * (e.g. for validation, logging, or fallback to JSON round-trip).
 */
export function cloneDeep<T>(value: T): T {
    return structuredClone(value);
}
