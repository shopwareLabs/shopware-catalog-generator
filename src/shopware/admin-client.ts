/**
 * Shopware Admin API Client wrapper using official @shopware/api-client
 *
 * This module provides a thin wrapper around the official Shopware Admin API client,
 * handling authentication and providing a consistent interface for the rest of the application.
 */

import type { operations } from "@shopware/api-client/admin-api-types";

import { createAdminAPIClient } from "@shopware/api-client";

/** Re-export official types so the rest of the codebase imports them from here */
export type { operations, Schemas } from "@shopware/api-client/admin-api-types";

/** Configuration for creating the admin client */
export interface AdminClientConfig {
    /** Base URL of the Shopware instance (e.g., "http://localhost:8000") */
    baseURL: string;
    /** Client ID for client_credentials grant (optional) */
    clientId?: string;
    /** Client secret for client_credentials grant (optional) */
    clientSecret?: string;
    /** Username for password grant (optional, fallback) */
    username?: string;
    /** Password for password grant (optional, fallback) */
    password?: string;
}

/** Type for the admin API client instance */
export type AdminApiClient = ReturnType<typeof createAdminAPIClient<operations>>;

/**
 * Create a Shopware Admin API client with authentication
 *
 * If clientId and clientSecret are provided, uses client_credentials grant.
 * Otherwise, falls back to password grant with admin credentials.
 *
 * @param config - Client configuration
 * @returns Configured admin API client
 */
export function createShopwareAdminClient(config: AdminClientConfig): AdminApiClient {
    const credentials =
        config.clientId && config.clientSecret
            ? {
                  grant_type: "client_credentials" as const,
                  client_id: config.clientId,
                  client_secret: config.clientSecret,
              }
            : {
                  grant_type: "password" as const,
                  client_id: "administration" as const,
                  username: config.username || "admin",
                  password: config.password || "shopware",
                  scopes: "write" as const,
              };

    const client = createAdminAPIClient<operations>({
        baseURL: `${config.baseURL}/api`,
        credentials,
        defaultHeaders: { Accept: "application/json" },
    });

    return client;
}
