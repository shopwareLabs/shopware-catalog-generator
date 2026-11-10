/**
 * Shopware context factory — single place to create the API helpers and
 * AI providers needed to run post-processors.
 *
 * Replaces the repeated bootstrap block that appeared in generate-service,
 * image-fix-service, server, and MCP cleanup tools.
 */

import type { ShopwareApiHelpers, TokenGetter } from "../shopware/index.js";
import type { ImageProvider, TextProvider } from "../types/index.js";

import { createProvidersFromEnv } from "../providers/index.js";
import { createApiHelpers, createShopwareAdminClient, DataHydrator } from "../shopware/index.js";

export interface ProcessorDeps {
    apiHelpers: ShopwareApiHelpers;
    textProvider?: TextProvider;
    imageProvider?: ImageProvider;
}

export interface ProcessorDepsConfig {
    baseURL: string;
    getAccessToken: TokenGetter;
    clientId?: string;
    clientSecret?: string;
    username?: string;
    password?: string;
    /** Skip provider creation (e.g. for cleanup-only flows). */
    skipProviders?: boolean;
}

/**
 * How a service run reaches Shopware. CLI and MCP use the integration from the
 * environment, the HTTP server passes the admin user of the request.
 */
export interface ShopwareConnection {
    url: string;
    credentials:
        | { kind: "integration"; clientId?: string; clientSecret?: string }
        | { kind: "user"; username: string; password: string };
}

/** Connection from SW_ENV_URL / SW_CLIENT_ID / SW_CLIENT_SECRET; undefined without a URL */
export function shopwareConnectionFromEnv(
    env: Record<string, string | undefined> = process.env
): ShopwareConnection | undefined {
    if (!env.SW_ENV_URL) return undefined;
    return {
        url: env.SW_ENV_URL,
        credentials: {
            kind: "integration",
            clientId: env.SW_CLIENT_ID,
            clientSecret: env.SW_CLIENT_SECRET,
        },
    };
}

/** Authenticate a DataHydrator for the connection. Throws when Shopware rejects it. */
export async function connectShopware(connection: ShopwareConnection): Promise<DataHydrator> {
    const dataHydrator = new DataHydrator();
    const { credentials } = connection;
    const ok =
        credentials.kind === "user"
            ? await dataHydrator.authenticateWithUserCredentials(
                  connection.url,
                  credentials.username,
                  credentials.password
              )
            : await dataHydrator.authenticateWithClientCredentials(
                  connection.url,
                  credentials.clientId,
                  credentials.clientSecret
              );
    if (!ok) {
        throw new Error(`Authentication with Shopware failed (${connection.url})`);
    }
    return dataHydrator;
}

/** createProcessorDeps for an authenticated connection */
export function createProcessorDepsForConnection(
    connection: ShopwareConnection,
    dataHydrator: DataHydrator,
    options: { skipProviders?: boolean } = {}
): ProcessorDeps {
    const { credentials } = connection;
    return createProcessorDeps({
        baseURL: connection.url,
        getAccessToken: () => dataHydrator.getAccessToken(),
        ...(credentials.kind === "user"
            ? { username: credentials.username, password: credentials.password }
            : { clientId: credentials.clientId, clientSecret: credentials.clientSecret }),
        skipProviders: options.skipProviders,
    });
}

export function createProcessorDeps(config: ProcessorDepsConfig): ProcessorDeps {
    const adminClient = createShopwareAdminClient({
        baseURL: config.baseURL,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        username: config.username,
        password: config.password,
    });
    const apiHelpers = createApiHelpers(adminClient, config.baseURL, config.getAccessToken);

    if (config.skipProviders) {
        return { apiHelpers };
    }

    const { text: textProvider, image: imageProvider } = createProvidersFromEnv();
    return { apiHelpers, textProvider, imageProvider };
}
