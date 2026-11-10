import { describe, expect, test } from "bun:test";

import {
    isTransientShopwareSyncError,
    syncWithRetry,
} from "../../../src/post-processors/processor-utils.js";
import { createTestContext } from "../../helpers/post-processor-context.js";

const DEADLOCK =
    "API POST _action/sync failed: 400 - SQLSTATE[40001]: Serialization failure: 1213 Deadlock found when trying to get lock";

/** Context whose sync calls throw the given errors in order, then succeed */
function contextFailingWith(errors: string[]) {
    const { context, mockApi } = createTestContext();
    const post = mockApi.post.bind(mockApi);
    let calls = 0;
    mockApi.post = async (endpoint, body) => {
        const error = errors[calls++];
        if (error) throw new Error(error);
        return post(endpoint, body);
    };
    return { context, calls: () => calls };
}

describe("isTransientShopwareSyncError", () => {
    test("returns true for deadlock and savepoint errors", () => {
        expect(isTransientShopwareSyncError(DEADLOCK)).toBe(true);
        expect(
            isTransientShopwareSyncError(
                "SQLSTATE[42000]: Syntax error or access violation: 1305 SAVEPOINT DOCTRINE_2 does not exist"
            )
        ).toBe(true);
        expect(isTransientShopwareSyncError("Lock wait timeout exceeded")).toBe(true);
    });

    test("returns false for non-transient errors", () => {
        expect(isTransientShopwareSyncError("Validation failed: missing required field")).toBe(
            false
        );
    });
});

describe("syncWithRetry", () => {
    test("retries deadlocks until the sync succeeds", async () => {
        const { context, calls } = contextFailingWith([DEADLOCK, DEADLOCK]);

        const result = await syncWithRetry(context, "test", {}, { baseDelayMs: 0 });

        expect(result).toEqual({ ok: true, status: 200 });
        expect(calls()).toBe(3);
    });

    test("gives up after the last attempt", async () => {
        const { context, calls } = contextFailingWith([DEADLOCK, DEADLOCK, DEADLOCK]);

        const result = await syncWithRetry(context, "test", {}, { baseDelayMs: 0 });

        expect(result.ok).toBe(false);
        expect(result.errorText).toBe(DEADLOCK);
        expect(calls()).toBe(3);
    });

    test("does not retry other errors", async () => {
        const { context, calls } = contextFailingWith(["Validation failed"]);

        const result = await syncWithRetry(context, "test", {}, { baseDelayMs: 0 });

        expect(result).toEqual({ ok: false, status: 500, errorText: "Validation failed" });
        expect(calls()).toBe(1);
    });
});
