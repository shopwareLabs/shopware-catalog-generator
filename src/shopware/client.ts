import type { AdminApiClient, Schemas } from "./admin-client.js";
import type { SearchResult, SyncOperation } from "./api-types.js";

import {
    capitalizeString as capitalizeStringUtil,
    generateAccessKey as generateAccessKeyUtil,
    logger,
} from "../utils/index.js";
import { createShopwareAdminClient } from "./admin-client.js";

/**
 * Base Shopware API client using the official @shopware/api-client.
 *
 * Authentication is handled by the official client automatically.
 * Create via authenticateWithClientCredentials() or authenticateWithUserCredentials(),
 * or pass a pre-configured AdminApiClient to the constructor.
 *
 * Uses the frontends pattern for all API calls:
 *   const { data } = await this.getClient().invoke(operationName, { body });
 *   const response = data as SearchResult<Schemas["Entity"]>;
 */
export class ShopwareClient {
    protected client: AdminApiClient | null;
    public envPath: string | undefined;

    constructor(client?: AdminApiClient) {
        this.client = client ?? null;
    }

    /**
     * Get the underlying AdminApiClient.
     * Throws if not authenticated.
     */
    protected getClient(): AdminApiClient {
        if (!this.client) {
            throw new Error(
                "ShopwareClient is not authenticated. Call authenticateWithClientCredentials() or authenticateWithUserCredentials() first."
            );
        }
        return this.client;
    }

    /**
     * Public accessor for the AdminApiClient.
     * Useful for callers (e.g. E2E scripts) that need the raw client for
     * operations not covered by the higher-level API helpers.
     * Throws if not authenticated.
     */
    getAdminClient(): AdminApiClient {
        return this.getClient();
    }

    /**
     * Execute the sync endpoint with typed payload.
     * GenericRecord from @shopware/api-client omits boolean, but the Shopware API
     * fully supports it for fields like active, visible, private, etc.
     */
    protected async sync(ops: SyncOperation[]): Promise<void> {
        // @ts-expect-error GenericRecord omits boolean; Shopware API accepts it
        await this.getClient().invoke("sync post /_action/sync", { body: ops });
    }

    /** Capitalize first letter of string */
    capitalizeString(s: string): string {
        return capitalizeStringUtil(s);
    }

    /** Check if client is authenticated */
    isAuthenticated(): boolean {
        return this.client !== null;
    }

    /**
     * Get a fresh access token from the session.
     * The official client handles token refresh automatically.
     */
    async getAccessToken(): Promise<string> {
        if (!this.client) return "";
        return this.client.getSessionData().accessToken || "";
    }

    /**
     * Authenticate with client credentials (integration).
     * Creates an AdminApiClient configured for client_credentials grant.
     */
    async authenticateWithClientCredentials(
        envPath: string,
        clientId: string | undefined,
        clientSecret: string | undefined
    ): Promise<boolean> {
        this.envPath = envPath || "http://localhost:8000";

        try {
            this.client = createShopwareAdminClient({
                baseURL: this.envPath,
                clientId,
                clientSecret,
            });
            return true;
        } catch (error) {
            logger.error("Failed to create admin client:", { data: error });
            this.client = null;
            return false;
        }
    }

    /**
     * Authenticate with user credentials (admin user).
     * Creates an AdminApiClient configured for password grant.
     */
    async authenticateWithUserCredentials(
        envPath: string,
        userName: string,
        password: string
    ): Promise<boolean> {
        if (!userName || !password) {
            this.client = null;
            return false;
        }

        this.envPath = envPath || "http://localhost:8000";

        try {
            this.client = createShopwareAdminClient({
                baseURL: this.envPath,
                username: userName,
                password,
            });
            return true;
        } catch (error) {
            logger.error("Failed to create admin client:", { data: error });
            this.client = null;
            return false;
        }
    }

    // =========================================================================
    // Common lookup methods used by both hydrator and cleanup
    // =========================================================================

    /** Get currency ID by ISO code */
    async getCurrencyId(currency = "EUR"): Promise<string> {
        const { data } = await this.getClient().invoke("searchCurrency post /search/currency", {
            body: {
                limit: 1,
                filter: [{ type: "equals", field: "isoCode", value: currency }],
            },
        });
        const response = data as SearchResult<Schemas["Currency"]>;
        const currencyData = response.data?.[0];
        if (!currencyData) {
            throw new Error(`Currency "${currency}" not found`);
        }
        return currencyData.id;
    }

    /**
     * Get the system default currency ID (the currency Shopware validates product prices against).
     *
     * Resolution order:
     *   1. System base currency (factor = 1)
     *   2. EUR by ISO code (fallback for non-standard setups)
     */
    async getDefaultCurrencyId(): Promise<string> {
        try {
            const { data } = await this.getClient().invoke(
                "searchCurrency post /search/currency",
                {
                    body: {
                        limit: 1,
                        filter: [{ type: "equals", field: "factor", value: 1 }],
                    },
                }
            );
            const response = data as SearchResult<Schemas["Currency"]>;
            const baseCurrency = response.data?.[0];
            if (baseCurrency) {
                return baseCurrency.id;
            }
        } catch {
            // factor filter failed — fall through to EUR lookup
        }

        logger.warn("Base currency (factor=1) not found — falling back to EUR", { cli: true });
        return this.getCurrencyId("EUR");
    }

    /** Get language ID by locale code (e.g. "de-DE"), returns null if not installed */
    async getLanguageId(localeCode: string): Promise<string | null> {
        const { data } = await this.getClient().invoke("searchLanguage post /search/language", {
            body: {
                limit: 1,
                filter: [{ type: "equals", field: "locale.code", value: localeCode }],
                associations: { locale: {} },
            },
        });
        const response = data as SearchResult<Schemas["Language"]>;
        return response.data?.[0]?.id ?? null;
    }

    /** Get snippet set ID by ISO code (e.g. "de-DE"), returns null if not installed */
    async getSnippetSetId(iso: string): Promise<string | null> {
        const { data } = await this.getClient().invoke(
            "searchSnippetSet post /search/snippet-set",
            {
                body: {
                    limit: 1,
                    filter: [{ type: "equals", field: "iso", value: iso }],
                },
            }
        );
        const response = data as SearchResult<Schemas["SnippetSet"]>;
        return response.data?.[0]?.id ?? null;
    }

    /** Get standard tax ID */
    async getStandardTaxId(): Promise<string> {
        const { data } = await this.getClient().invoke("searchTax post /search/tax", {
            body: { limit: 1 },
        });
        const response = data as SearchResult<Schemas["Tax"]>;
        const taxData = response.data?.[0];
        if (!taxData) {
            throw new Error("No tax rate found");
        }
        return taxData.id;
    }

    /** Well-known Shopware Storefront sales channel type ID */
    static readonly STOREFRONT_TYPE_ID = "8a243080f92e4c719546314b577cf82b";

    /** Get sales channel by name, with fallback to any Storefront-type channel */
    async getStandardSalesChannel(salesChannelName: string = "Storefront"): Promise<{
        id: string;
        navigationCategoryId: string;
        currencyId?: string;
    }> {
        return this.findSalesChannel(salesChannelName);
    }

    /** Get full sales channel details for cloning, with fallback to any Storefront-type channel */
    async getFullSalesChannel(salesChannelName: string = "Storefront"): Promise<{
        id: string;
        name: string;
        typeId: string;
        languageId: string;
        currencyId: string;
        paymentMethodId: string;
        shippingMethodId: string;
        countryId: string;
        customerGroupId: string;
        navigationCategoryId: string;
        snippetSetId?: string;
    }> {
        const { data } = await this.getClient().invoke(
            "searchSalesChannel post /search/sales-channel",
            {
                body: {
                    limit: 1,
                    filter: [{ type: "equals", field: "name", value: salesChannelName }],
                    associations: { domains: {} },
                },
            }
        );
        const response = data as SearchResult<Schemas["SalesChannel"]>;

        let channel = response.data?.[0];

        if (!channel) {
            // Fallback: find any Storefront-type sales channel
            logger.warn(
                `Sales channel "${salesChannelName}" not found by name, falling back to Storefront type lookup`
            );

            const { data: fallbackData } = await this.getClient().invoke(
                "searchSalesChannel post /search/sales-channel",
                {
                    body: {
                        limit: 1,
                        filter: [
                            {
                                type: "equals",
                                field: "typeId",
                                value: ShopwareClient.STOREFRONT_TYPE_ID,
                            },
                        ],
                        associations: { domains: {} },
                    },
                }
            );
            const fallbackResponse = fallbackData as SearchResult<Schemas["SalesChannel"]>;

            channel = fallbackResponse.data?.[0];
            if (!channel) {
                throw new Error(
                    `No sales channel found: tried name "${salesChannelName}" and Storefront type ID "${ShopwareClient.STOREFRONT_TYPE_ID}". ` +
                        `Ensure at least one Storefront-type sales channel exists in Shopware.`
                );
            }

            logger.warn(
                `⚠ Using sales channel fallback (found Storefront-type channel instead of "${salesChannelName}")`,
                { cli: true }
            );
        }

        return {
            id: channel.id,
            name: channel.name ?? "",
            typeId: channel.typeId ?? "",
            languageId: channel.languageId ?? "",
            currencyId: channel.currencyId ?? "",
            paymentMethodId: channel.paymentMethodId ?? "",
            shippingMethodId: channel.shippingMethodId ?? "",
            countryId: channel.countryId ?? "",
            customerGroupId: channel.customerGroupId ?? "",
            navigationCategoryId: channel.navigationCategoryId ?? "",
            snippetSetId: channel.domains?.[0]?.snippetSetId,
        };
    }

    /**
     * Find a sales channel by name, with fallback to any Storefront-type channel.
     */
    private async findSalesChannel(salesChannelName: string): Promise<{
        id: string;
        navigationCategoryId: string;
        currencyId?: string;
    }> {
        // Step 1: Try exact name match
        const { data } = await this.getClient().invoke(
            "searchSalesChannel post /search/sales-channel",
            {
                body: {
                    limit: 1,
                    filter: [{ type: "equals", field: "name", value: salesChannelName }],
                },
            }
        );
        const response = data as SearchResult<Schemas["SalesChannel"]>;

        const salesChannel = response.data?.[0];
        if (salesChannel) {
            return {
                id: salesChannel.id,
                navigationCategoryId: salesChannel.navigationCategoryId ?? "",
                currencyId: salesChannel.currencyId,
            };
        }

        // Step 2: Fallback - find any Storefront-type sales channel
        logger.warn(
            `Sales channel "${salesChannelName}" not found by name, falling back to Storefront type lookup`
        );

        const { data: fallbackData } = await this.getClient().invoke(
            "searchSalesChannel post /search/sales-channel",
            {
                body: {
                    limit: 1,
                    filter: [
                        {
                            type: "equals",
                            field: "typeId",
                            value: ShopwareClient.STOREFRONT_TYPE_ID,
                        },
                    ],
                },
            }
        );
        const fallbackResponse = fallbackData as SearchResult<Schemas["SalesChannel"]>;

        const fallbackChannel = fallbackResponse.data?.[0];
        if (!fallbackChannel) {
            throw new Error(
                `No sales channel found: tried name "${salesChannelName}" and Storefront type ID "${ShopwareClient.STOREFRONT_TYPE_ID}". ` +
                    `Ensure at least one Storefront-type sales channel exists in Shopware.`
            );
        }

        logger.warn(
            `⚠ Using sales channel fallback (found Storefront-type channel instead of "${salesChannelName}")`,
            { cli: true }
        );
        return {
            id: fallbackChannel.id,
            navigationCategoryId: fallbackChannel.navigationCategoryId ?? "",
            currencyId: fallbackChannel.currencyId,
        };
    }

    /** Generate a random access key for a SalesChannel */
    generateAccessKey(): string {
        return generateAccessKeyUtil();
    }

    /** Cached Product Media folder ID */
    private productMediaFolderId: string | null | undefined = undefined;

    /**
     * Get the "Product Media" default folder ID (cached)
     */
    async getProductMediaFolderId(): Promise<string | null> {
        // Return cached value if available
        if (this.productMediaFolderId !== undefined) {
            return this.productMediaFolderId;
        }

        try {
            // First, find the default folder configuration for product media
            const { data: defaultFolderData } = await this.getClient().invoke(
                "searchMediaDefaultFolder post /search/media-default-folder",
                {
                    body: {
                        limit: 1,
                        filter: [{ type: "equals", field: "entity", value: "product" }],
                        associations: { folder: {} },
                    },
                }
            );
            const defaultFolderResponse = defaultFolderData as SearchResult<
                Schemas["MediaDefaultFolder"]
            >;

            const defaultFolder = defaultFolderResponse.data?.[0];
            if (defaultFolder?.folder?.id) {
                this.productMediaFolderId = defaultFolder.folder.id;
                return this.productMediaFolderId;
            }

            // Fallback: search for folder by name
            const { data: folderData } = await this.getClient().invoke(
                "searchMediaFolder post /search/media-folder",
                {
                    body: {
                        limit: 1,
                        filter: [{ type: "equals", field: "name", value: "Product Media" }],
                    },
                }
            );
            const folderResponse = folderData as SearchResult<Schemas["MediaFolder"]>;

            const folder = folderResponse.data?.[0];
            if (folder) {
                this.productMediaFolderId = folder.id;
                return this.productMediaFolderId;
            }

            this.productMediaFolderId = null;
            return null;
        } catch (error) {
            logger.warn("Failed to get Product Media folder:", { data: error });
            this.productMediaFolderId = null;
            return null;
        }
    }

    /**
     * Get the theme ID assigned to a SalesChannel.
     * Searches themes with salesChannels association to find the matching one.
     */
    async getThemeForSalesChannel(salesChannelId: string): Promise<string | null> {
        try {
            const { data } = await this.getClient().invoke("searchTheme post /search/theme", {
                body: {
                    limit: 50,
                    filter: [{ type: "equals", field: "active", value: true }],
                    associations: { salesChannels: {} },
                },
            });
            const response = data as SearchResult<Schemas["Theme"]>;

            // Find theme linked to the specific SalesChannel
            for (const theme of response.data ?? []) {
                if (theme.salesChannels?.some((sc) => sc.id === salesChannelId)) {
                    return theme.id;
                }
            }

            // Fallback: search for the default Storefront theme
            return await this.getDefaultStorefrontTheme();
        } catch {
            // Try fallback on error
            return await this.getDefaultStorefrontTheme();
        }
    }

    /**
     * Get the default Storefront theme ID.
     * Searches for a theme with technicalName "Storefront" or name containing "Storefront".
     */
    async getDefaultStorefrontTheme(): Promise<string | null> {
        try {
            const { data } = await this.getClient().invoke("searchTheme post /search/theme", {
                body: {
                    limit: 10,
                    filter: [{ type: "equals", field: "active", value: true }],
                },
            });
            const response = data as SearchResult<Schemas["Theme"]>;
            const themes = response.data ?? [];

            if (themes.length === 0) {
                return null;
            }

            // Look for "Storefront" theme by technicalName
            const storefrontTheme = themes.find(
                (t) => t.technicalName === "Storefront" || t.name === "Storefront"
            );

            if (storefrontTheme) {
                return storefrontTheme.id;
            }

            // Return first active theme as fallback
            return themes[0]?.id ?? null;
        } catch {
            return null;
        }
    }

    // =========================================================================
    // CMS Page Methods
    // =========================================================================

    /**
     * Find a CMS page by name
     * @param name - The CMS page name to search for
     * @returns The CMS page ID if found, null otherwise
     */
    async findCmsPageByName(name: string): Promise<string | null> {
        try {
            const { data } = await this.getClient().invoke("searchCmsPage post /search/cms-page", {
                body: {
                    filter: [{ type: "equals", field: "name", value: name }],
                    limit: 1,
                },
            });
            const response = data as SearchResult<Schemas["CmsPage"]>;

            return response.data?.[0]?.id ?? null;
        } catch (error) {
            logger.warn(`Failed to find CMS page "${name}":`, { data: error });
            return null;
        }
    }

    /**
     * Get a CMS page by ID with full associations (sections, blocks, slots).
     * Uses the official client with nested associations (JSON format).
     */
    async getCmsPageById(id: string): Promise<{
        id: string;
        name: string;
        type: string;
        sections: Array<{
            id: string;
            type: string;
            position: number;
            blocks: Array<{
                id: string;
                type: string;
                position: number;
                slots: Array<{
                    id: string;
                    type: string;
                    slot: string;
                    config: Record<string, unknown>;
                }>;
            }>;
        }>;
    } | null> {
        try {
            const { data } = await this.getClient().invoke("searchCmsPage post /search/cms-page", {
                body: {
                    ids: [id],
                    associations: {
                        sections: {
                            associations: {
                                blocks: {
                                    associations: {
                                        slots: {},
                                    },
                                },
                            },
                        },
                    },
                },
            });
            const response = data as SearchResult<Schemas["CmsPage"]>;

            const page = response.data?.[0];
            if (!page) {
                return null;
            }

            // Map sections with nested blocks and slots from JSON response
            const sections = (page.sections ?? [])
                .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                .map((section) => ({
                    id: section.id,
                    type: section.type ?? "default",
                    position: section.position ?? 0,
                    blocks: (section.blocks ?? [])
                        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                        .map((block) => ({
                            id: block.id,
                            type: block.type ?? "",
                            position: block.position ?? 0,
                            slots: (block.slots ?? []).map((slot) => ({
                                id: slot.id,
                                type: slot.type ?? "",
                                slot: slot.slot ?? "",
                                config: (slot.config as Record<string, unknown>) ?? {},
                            })),
                        })),
                }));

            return {
                id: page.id,
                name: page.name ?? "",
                type: page.type ?? "",
                sections,
            };
        } catch (error) {
            logger.warn(`Failed to get CMS page "${id}":`, { data: error });
            return null;
        }
    }

    /**
     * Find a category by name under a specific parent
     * @param name - The category name
     * @param parentId - The parent category ID
     * @returns The category ID if found, null otherwise
     */
    async findCategoryByName(name: string, parentId: string): Promise<string | null> {
        try {
            const { data } = await this.getClient().invoke("searchCategory post /search/category", {
                body: {
                    filter: [
                        { type: "equals", field: "name", value: name },
                        { type: "equals", field: "parentId", value: parentId },
                    ],
                    limit: 1,
                },
            });
            const response = data as SearchResult<Schemas["Category"]>;

            return response.data?.[0]?.id ?? null;
        } catch (error) {
            logger.warn(`Failed to find category "${name}":`, { data: error });
            return null;
        }
    }

    /**
     * Assign a theme to a SalesChannel
     */
    async assignThemeToSalesChannel(salesChannelId: string, themeId: string): Promise<boolean> {
        try {
            await this.getClient().invoke(
                "assignTheme post /_action/theme/{themeId}/assign/{salesChannelId}",
                {
                    pathParams: { themeId, salesChannelId },
                }
            );
            logger.info(`Theme assigned to SalesChannel`);
            return true;
        } catch (error) {
            logger.warn("Failed to assign theme to SalesChannel:", { data: error });
            return false;
        }
    }

    // =========================================================================
    // Low-level helpers for operations not fully covered by typed invoke()
    // =========================================================================

    /**
     * Upload a binary file to an existing media entity.
     * Uses raw fetch because the official client's typed invoke() doesn't
     * handle binary bodies well (typed as GenericRecord).
     */
    async uploadMediaBuffer(
        mediaId: string,
        buffer: Buffer | Uint8Array,
        fileName: string,
        extension: string
    ): Promise<void> {
        if (!this.client) {
            throw new Error("Client not authenticated");
        }

        const token = this.client.getSessionData().accessToken;
        const baseURL = this.envPath || "http://localhost:8000";

        const contentType =
            extension === "webp"
                ? "image/webp"
                : extension === "jpg" || extension === "jpeg"
                  ? "image/jpeg"
                  : extension === "png"
                    ? "image/png"
                    : extension === "svg"
                      ? "image/svg+xml"
                      : "application/octet-stream";

        const url = `${baseURL}/api/_action/media/${mediaId}/upload?extension=${extension}&fileName=${encodeURIComponent(fileName)}`;

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": contentType,
                Accept: "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: buffer,
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Media upload failed: ${response.status} - ${text}`);
        }
    }
}
