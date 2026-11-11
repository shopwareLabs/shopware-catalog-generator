/**
 * Server settings from the environment.
 *
 * The server spends the operator's AI keys, so it listens on localhost by default.
 * Listening on another interface requires SERVER_TOKEN; every request then needs
 * `Authorization: Bearer <token>`.
 */

import { timingSafeEqual } from "node:crypto";

export interface ServerConfig {
    port: number;
    hostname: string;
    /** Bearer token every request must send; undefined = no auth (localhost only) */
    token?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Read SERVER_PORT, SERVER_HOST and SERVER_TOKEN. Throws when a public host has no token. */
export function resolveServerConfig(env: Record<string, string | undefined>): ServerConfig {
    const port = Number(env.SERVER_PORT) || 3000;
    const hostname = env.SERVER_HOST?.trim() || "127.0.0.1";
    const token = env.SERVER_TOKEN?.trim() || undefined;
    if (!token && !LOOPBACK_HOSTS.has(hostname)) {
        throw new Error(
            `SERVER_HOST=${hostname} makes the server reachable from other machines. ` +
                "Set SERVER_TOKEN so requests must authenticate."
        );
    }
    return { port, hostname, token };
}

/** True when the request carries the expected bearer token (or no token is configured) */
export function isAuthorized(request: Request, token: string | undefined): boolean {
    if (!token) return true;
    const header = request.headers.get("authorization") ?? "";
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
