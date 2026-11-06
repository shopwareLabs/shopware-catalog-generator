import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AdminApiClient } from "../../../src/shopware/admin-client.js";

import { ShopwareApiHelpers } from "../../../src/shopware/api-helpers.js";

interface SessionData {
    accessToken: string;
    expirationTime: number;
}

const BASE_URL = "http://shop.test";
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Fake AdminApiClient: invoke() simulates the official client's login by
 * storing a fresh session, or throws when login should fail.
 */
function createSessionClient(initial: SessionData, options: { loginFails?: boolean } = {}) {
    let session = { ...initial };
    const invoke = mock(async (_operation: string, _params: unknown) => {
        if (options.loginFails) throw new Error("invalid_client");
        session = { accessToken: "fresh-token", expirationTime: Date.now() + ONE_HOUR_MS };
        return { data: {} };
    });
    const client = {
        invoke,
        getSessionData: () => session,
    } as unknown as AdminApiClient;
    return { client, invoke };
}

describe("ShopwareApiHelpers session bootstrap", () => {
    const originalFetch = globalThis.fetch;
    let fetchMock: ReturnType<typeof mock>;

    beforeEach(() => {
        fetchMock = mock(async () => Response.json({ ok: true }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function sentAuthorization(): string | undefined {
        const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        return headers.Authorization;
    }

    test("logs in before the first raw request when there is no session", async () => {
        const { client, invoke } = createSessionClient({ accessToken: "", expirationTime: 0 });
        const api = new ShopwareApiHelpers(client, BASE_URL);

        await api.get("_info/version");

        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke.mock.calls[0]?.[0]).toBe("infoShopwareVersion get /_info/version");
        expect(sentAuthorization()).toBe("Bearer fresh-token");
    });

    test("reuses a valid session without logging in again", async () => {
        const { client, invoke } = createSessionClient({
            accessToken: "valid-token",
            expirationTime: Date.now() + ONE_HOUR_MS,
        });
        const api = new ShopwareApiHelpers(client, BASE_URL);

        await api.get("_info/version");

        expect(invoke).not.toHaveBeenCalled();
        expect(sentAuthorization()).toBe("Bearer valid-token");
    });

    test("refreshes a session that expires within the safety margin", async () => {
        const { client, invoke } = createSessionClient({
            accessToken: "expiring-token",
            expirationTime: Date.now() + 5_000,
        });
        const api = new ShopwareApiHelpers(client, BASE_URL);

        await api.get("_info/version");

        expect(invoke).toHaveBeenCalledTimes(1);
        expect(sentAuthorization()).toBe("Bearer fresh-token");
    });

    test("refreshes an already expired session", async () => {
        const { client, invoke } = createSessionClient({
            accessToken: "expired-token",
            expirationTime: Date.now() - 1_000,
        });
        const api = new ShopwareApiHelpers(client, BASE_URL);

        await api.get("_info/version");

        expect(invoke).toHaveBeenCalledTimes(1);
        expect(sentAuthorization()).toBe("Bearer fresh-token");
    });

    test("falls back to the custom token getter when login fails", async () => {
        const { client, invoke } = createSessionClient(
            { accessToken: "", expirationTime: 0 },
            { loginFails: true }
        );
        const api = new ShopwareApiHelpers(client, BASE_URL, async () => "custom-token");

        await api.get("_info/version");

        expect(invoke).toHaveBeenCalledTimes(1);
        expect(sentAuthorization()).toBe("Bearer custom-token");
    });

    test("sends no Authorization header when login fails and no token getter is set", async () => {
        const { client } = createSessionClient(
            { accessToken: "", expirationTime: 0 },
            { loginFails: true }
        );
        const api = new ShopwareApiHelpers(client, BASE_URL);

        await api.get("_info/version");

        expect(sentAuthorization()).toBeUndefined();
    });
});
