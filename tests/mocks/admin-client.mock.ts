import { mock } from "bun:test";

import type { AdminApiClient } from "../../src/shopware/admin-client.js";

/**
 * Build a mock AdminApiClient whose `invoke` method dispatches by operation
 * string, returning pre-configured responses.
 *
 * Callers provide a record of operation-substring -> response-value. When
 * `invoke` is called, the first key that matches (via `includes`) wins.
 * Unmatched operations return `{ data: { data: [], total: 0 } }`.
 */
export function createMockAdminClient(responses: Record<string, unknown> = {}): AdminApiClient {
    return {
        invoke: mock(async (operation: string) => {
            for (const [key, value] of Object.entries(responses)) {
                if (operation.includes(key)) {
                    return { data: value };
                }
            }
            return { data: { data: [], total: 0 } };
        }),
        getSessionData: () => ({ accessToken: "test-token" }),
    } as unknown as AdminApiClient;
}

/**
 * Build a mock AdminApiClient with a fully custom invoke handler.
 * Use when tests need body inspection or multi-step dispatch logic.
 */
export function createMockAdminClientWithInvoke(
    invoke: (operation: string, params: { body?: unknown }) => Promise<unknown>
): AdminApiClient {
    return {
        invoke: mock(invoke),
        getSessionData: () => ({ accessToken: "test-token" }),
    } as unknown as AdminApiClient;
}
