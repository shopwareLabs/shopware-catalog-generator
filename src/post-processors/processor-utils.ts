/**
 * Small helpers shared by the post-processors
 */

/** Message of a caught error (Error message, else the value as string) */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
