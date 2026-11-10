/**
 * Small helpers shared by the post-processors
 */

import type { PostProcessorContext } from "./index.js";

import { apiPost, logger, sleep } from "../utils/index.js";

/** Message of a caught error (Error message, else the value as string) */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Shopware sync errors that succeed when retried (MySQL deadlocks, lock timeouts) */
export function isTransientShopwareSyncError(errorText: string): boolean {
    const normalized = errorText.toLowerCase();
    return (
        normalized.includes("deadlock found when trying to get lock") ||
        normalized.includes("sqlstate[40001]") ||
        normalized.includes("savepoint doctrine_") ||
        normalized.includes("lock wait timeout exceeded")
    );
}

export interface SyncResult {
    ok: boolean;
    status: number;
    errorText?: string;
}

export interface SyncRetryOptions {
    attempts?: number;
    /** Delay before the first retry, doubled for each further retry */
    baseDelayMs?: number;
}

/**
 * POST _action/sync and retry transient errors (deadlocks) with backoff.
 * Parallel post-processors write the same tables, so MySQL deadlocks happen.
 * Never throws: other errors are returned on the first attempt.
 */
export async function syncWithRetry(
    context: PostProcessorContext,
    operationName: string,
    payload: unknown,
    { attempts = 3, baseDelayMs = 500 }: SyncRetryOptions = {}
): Promise<SyncResult> {
    let delayMs = baseDelayMs;
    for (let attempt = 1; ; attempt++) {
        const result = await trySync(context, payload);
        const retry = !result.ok && attempt < attempts;
        if (!retry || !isTransientShopwareSyncError(result.errorText ?? "")) return result;

        logger.warn(
            `Transient Shopware sync error during ${operationName} (attempt ${attempt}/${attempts}). Retrying in ${delayMs}ms...`,
            { cli: true }
        );
        await sleep(delayMs);
        delayMs *= 2;
    }
}

async function trySync(context: PostProcessorContext, payload: unknown): Promise<SyncResult> {
    try {
        const response = await apiPost(context, "_action/sync", payload);
        if (response.ok) return { ok: true, status: response.status };
        return { ok: false, status: response.status, errorText: await response.text() };
    } catch (error) {
        return { ok: false, status: 500, errorText: errorMessage(error) };
    }
}
