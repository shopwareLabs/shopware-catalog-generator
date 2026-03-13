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
import { createApiHelpers, createShopwareAdminClient } from "../shopware/index.js";

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
