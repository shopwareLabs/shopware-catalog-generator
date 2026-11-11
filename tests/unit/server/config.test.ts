import { describe, expect, test } from "bun:test";

import { isAuthorized, resolveServerConfig } from "../../../src/server/config.js";

describe("resolveServerConfig", () => {
    test("listens on localhost without a token by default", () => {
        expect(resolveServerConfig({})).toEqual({
            port: 3000,
            hostname: "127.0.0.1",
            token: undefined,
        });
    });

    test("refuses a public host without SERVER_TOKEN", () => {
        expect(() => resolveServerConfig({ SERVER_HOST: "0.0.0.0" })).toThrow("SERVER_TOKEN");
    });

    test("allows a public host with SERVER_TOKEN", () => {
        expect(
            resolveServerConfig({
                SERVER_HOST: "0.0.0.0",
                SERVER_TOKEN: "s3cret",
                SERVER_PORT: "8080",
            })
        ).toEqual({ port: 8080, hostname: "0.0.0.0", token: "s3cret" });
    });
});

describe("isAuthorized", () => {
    const withHeader = (value?: string): Request =>
        new Request("http://localhost/health", {
            headers: value ? { authorization: value } : {},
        });

    test("passes every request when no token is configured", () => {
        expect(isAuthorized(withHeader(), undefined)).toBe(true);
    });

    test("needs the exact bearer token", () => {
        expect(isAuthorized(withHeader("Bearer s3cret"), "s3cret")).toBe(true);
        expect(isAuthorized(withHeader("Bearer wrong!"), "s3cret")).toBe(false);
        expect(isAuthorized(withHeader("Bearer s3cret-longer"), "s3cret")).toBe(false);
        expect(isAuthorized(withHeader(), "s3cret")).toBe(false);
    });
});
