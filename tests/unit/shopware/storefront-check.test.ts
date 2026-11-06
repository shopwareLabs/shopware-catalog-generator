import { describe, expect, test } from "bun:test";

import {
    checkStorefrontUrl,
    collectDomainUrls,
    describeStorefrontFailure,
    verifyStorefrontDomains,
} from "../../../src/shopware/storefront-check.js";

/** Build a fetch stub that answers with the given status per URL (missing URL → throws) */
function fetchWithStatuses(statuses: Record<string, number>): typeof fetch {
    const stub = async (input: string | URL | Request): Promise<Response> => {
        const url = input.toString();
        const status = statuses[url];
        if (status === undefined) {
            throw new Error(`fetch failed: ${url}`);
        }
        return new Response("<html></html>", { status });
    };
    return stub as typeof fetch;
}

describe("collectDomainUrls", () => {
    test("keeps non-empty string urls in order", () => {
        const urls = collectDomainUrls([
            { url: "http://shop.localhost" },
            { url: "http://shop-de.localhost" },
        ]);
        expect(urls).toEqual(["http://shop.localhost", "http://shop-de.localhost"]);
    });

    test("drops missing, null and empty urls", () => {
        const urls = collectDomainUrls([{}, { url: null }, { url: "" }, { url: "http://a" }]);
        expect(urls).toEqual(["http://a"]);
    });

    test("returns empty array for no domains", () => {
        expect(collectDomainUrls([])).toEqual([]);
    });
});

describe("checkStorefrontUrl", () => {
    test("reports the HTTP status of a successful response", async () => {
        const check = await checkStorefrontUrl("http://shop.localhost", {
            fetchFn: fetchWithStatuses({ "http://shop.localhost": 200 }),
        });
        expect(check).toEqual({ url: "http://shop.localhost", status: 200 });
    });

    test("reports a non-200 status without throwing", async () => {
        const check = await checkStorefrontUrl("http://shop.localhost", {
            fetchFn: fetchWithStatuses({ "http://shop.localhost": 503 }),
        });
        expect(check.status).toBe(503);
        expect(check.error).toBeUndefined();
    });

    test("captures fetch failures as null status with the error message", async () => {
        const check = await checkStorefrontUrl("http://down.localhost", {
            fetchFn: fetchWithStatuses({}),
        });
        expect(check.status).toBeNull();
        expect(check.error).toBe("fetch failed: http://down.localhost");
    });

    test("passes a timeout signal to fetch", async () => {
        let receivedSignal: AbortSignal | null | undefined;
        const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
            receivedSignal = init?.signal;
            return new Response("", { status: 200 });
        }) as typeof fetch;

        await checkStorefrontUrl("http://shop.localhost", { fetchFn, timeoutMs: 5 });
        expect(receivedSignal).toBeInstanceOf(AbortSignal);
    });

    test("reports a timed out request as a failure", async () => {
        const fetchFn = ((_input: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            })) as typeof fetch;

        const check = await checkStorefrontUrl("http://slow.localhost", { fetchFn, timeoutMs: 5 });
        expect(check.status).toBeNull();
        expect(check.error).toContain("timed out");
    });
});

describe("describeStorefrontFailure", () => {
    test("returns undefined for a 200 response", () => {
        expect(describeStorefrontFailure({ url: "http://a", status: 200 })).toBeUndefined();
    });

    test("describes a non-200 status", () => {
        expect(describeStorefrontFailure({ url: "http://a", status: 404 })).toBe("HTTP 404");
    });

    test("prefers the error message over the status", () => {
        const reason = describeStorefrontFailure({ url: "http://a", status: null, error: "boom" });
        expect(reason).toBe("boom");
    });
});

describe("verifyStorefrontDomains", () => {
    test("passes when every domain answers 200", async () => {
        const result = await verifyStorefrontDomains(
            ["http://en.localhost", "http://de.localhost"],
            {
                fetchFn: fetchWithStatuses({
                    "http://en.localhost": 200,
                    "http://de.localhost": 200,
                }),
            }
        );
        expect(result.errors).toEqual([]);
        expect(result.checks.map((c) => c.status)).toEqual([200, 200]);
    });

    test("reports an error for each failing domain and keeps checking the rest", async () => {
        const result = await verifyStorefrontDomains(
            ["http://en.localhost", "http://de.localhost", "http://fr.localhost"],
            {
                fetchFn: fetchWithStatuses({
                    "http://en.localhost": 500,
                    "http://fr.localhost": 200,
                }),
            }
        );
        expect(result.checks).toHaveLength(3);
        expect(result.errors).toEqual([
            "Storefront domain http://en.localhost failed: HTTP 500",
            "Storefront domain http://de.localhost failed: fetch failed: http://de.localhost",
        ]);
    });

    test("fails when the SalesChannel has no domains", async () => {
        const result = await verifyStorefrontDomains([], { fetchFn: fetchWithStatuses({}) });
        expect(result.checks).toEqual([]);
        expect(result.errors).toEqual(["SalesChannel has no domains"]);
    });

    test("checks domains sequentially", async () => {
        const order: string[] = [];
        const fetchFn = (async (input: string | URL | Request) => {
            const url = input.toString();
            order.push(`start ${url}`);
            await new Promise((resolve) => setTimeout(resolve, 1));
            order.push(`end ${url}`);
            return new Response("", { status: 200 });
        }) as typeof fetch;

        await verifyStorefrontDomains(["http://a", "http://b"], { fetchFn });
        expect(order).toEqual(["start http://a", "end http://a", "start http://b", "end http://b"]);
    });
});
