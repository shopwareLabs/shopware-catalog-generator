import {
    capitalizeString as capitalizeStringUtil,
    generateAccessKey as generateAccessKeyUtil,
} from "../utils/index.js";

/**
 * Response wrapper to match axios-like interface
 */
interface ApiResponse<T = unknown> {
    data: T;
    status: number;
    ok: boolean;
}

/**
 * Simple fetch-based API client
 */
class FetchClient {
    private baseURL: string = "";
    private headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
    };

    setBaseURL(url: string): void {
        this.baseURL = url.endsWith("/") ? url : `${url}/`;
    }

    setAuthHeader(token: string): void {
        this.headers.Authorization = `Bearer ${token}`;
    }

    clearAuthHeader(): void {
        delete this.headers.Authorization;
    }

    private async request<T>(
        method: string,
        endpoint: string,
        body?: unknown,
        customHeaders?: Record<string, string>
    ): Promise<ApiResponse<T>> {
        const url = `${this.baseURL}${endpoint}`;
        const headers = { ...this.headers, ...customHeaders };

        const options: RequestInit = {
            method,
            headers,
        };

        if (body !== undefined) {
            if (body instanceof Buffer || body instanceof Uint8Array) {
                options.body = body;
            } else {
                options.body = JSON.stringify(body);
            }
        }

        const response = await fetch(url, options);

        let data: T;
        const contentType = response.headers.get("content-type") || "";

        if (contentType.includes("application/json")) {
            data = (await response.json()) as T;
        } else {
            data = (await response.text()) as unknown as T;
        }

        return {
            data,
            status: response.status,
            ok: response.ok,
        };
    }

    async post<T = unknown>(
        endpoint: string,
        body?: unknown,
        options?: { headers?: Record<string, string> }
    ): Promise<ApiResponse<T>> {
        return this.request<T>("POST", endpoint, body, options?.headers);
    }

    async get<T = unknown>(endpoint: string): Promise<ApiResponse<T>> {
        return this.request<T>("GET", endpoint);
    }

    async delete<T = unknown>(endpoint: string): Promise<ApiResponse<T>> {
        return this.request<T>("DELETE", endpoint);
    }

    async patch<T = unknown>(endpoint: string, body?: unknown): Promise<ApiResponse<T>> {
        return this.request<T>("PATCH", endpoint, body);
    }
}

/**
 * Base Shopware API client with authentication
 */
export class ShopwareClient {
    public apiClient: FetchClient;
    public envPath: string | undefined;
    public authenticationType: string | undefined;

    private apiClientId: string | undefined;
    private apiClientSecret: string | undefined;
    protected apiClientAccessToken: string | null | undefined;

    /** User credentials for token refresh (user auth only) */
    private userCredentials: { username: string; password: string } | undefined;

    /** Token expiration timestamp (in milliseconds since epoch) */
    private tokenExpiresAt: number = 0;

    /** Buffer time before expiration to refresh (5 minutes) */
    private static readonly TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

    constructor() {
        this.apiClient = new FetchClient();
    }

    /** Capitalize first letter of string */
    capitalizeString(s: string): string {
        return capitalizeStringUtil(s);
    }

    /** Check if client is authenticated */
    isAuthenticated(): boolean {
        return !!this.apiClientAccessToken;
    }

    /**
     * Get a fresh access token, refreshing if needed
     * This should be called before each API request in long-running operations
     */
    async getAccessToken(): Promise<string> {
        // Check if token is expired or about to expire
        if (this.isTokenExpired()) {
            console.log("    Token expired or expiring soon, refreshing...");
            await this.refreshToken();
        }
        return this.apiClientAccessToken || "";
    }

    /**
     * Check if the token is expired or will expire soon
     */
    private isTokenExpired(): boolean {
        if (!this.apiClientAccessToken) {
            return true;
        }
        const now = Date.now();
        return now >= this.tokenExpiresAt - ShopwareClient.TOKEN_REFRESH_BUFFER_MS;
    }

    /**
     * Refresh the authentication token.
     * Re-authenticates using the same method and credentials used initially.
     */
    private async refreshToken(): Promise<boolean> {
        const envPath = this.envPath || "http://localhost:8000";

        if (this.authenticationType === "client") {
            // Re-authenticate with client credentials (or dev fallback if none stored)
            return this.authenticateWithClientCredentials(
                envPath,
                this.apiClientId,
                this.apiClientSecret
            );
        }

        if (this.authenticationType === "user" && this.userCredentials) {
            return this.authenticateWithUserCredentials(
                envPath,
                this.userCredentials.username,
                this.userCredentials.password
            );
        }

        console.warn("Cannot refresh token: authentication method not supported for refresh");
        return false;
    }

    /**
     * Authenticate with client credentials (integration)
     */
    async authenticateWithClientCredentials(
        envPath: string,
        clientId: string | undefined,
        clientSecret: string | undefined
    ): Promise<boolean> {
        this.envPath = envPath || "http://localhost:8000";
        this.apiClientId = clientId;
        this.apiClientSecret = clientSecret;
        this.authenticationType = "client";

        this.apiClient = new FetchClient();
        this.apiClient.setBaseURL(`${this.envPath}/api/`);

        let authPayload: Record<string, string>;

        if (this.apiClientId && this.apiClientSecret) {
            authPayload = {
                grant_type: "client_credentials",
                client_id: this.apiClientId,
                client_secret: this.apiClientSecret,
                scope: "write",
            };
        } else {
            // Fallback for dev mode to standard admin user
            authPayload = {
                client_id: "administration",
                grant_type: "password",
                username: "admin",
                password: "shopware",
                scope: "write",
            };
        }

        const authResponse = await this.apiClient.post<{
            access_token?: string;
            expires_in?: number;
        }>("oauth/token", authPayload);

        if (!authResponse.data.access_token) {
            console.error("Authentication failed.");
            console.log(authResponse);
            this.apiClientAccessToken = null;
            this.tokenExpiresAt = 0;
            return false;
        }

        this.apiClientAccessToken = authResponse.data.access_token;
        this.apiClient.setAuthHeader(this.apiClientAccessToken);

        // Store token expiration time (default to 10 minutes if not provided)
        const expiresIn = authResponse.data.expires_in || 600;
        this.tokenExpiresAt = Date.now() + expiresIn * 1000;

        return true;
    }

    /**
     * Authenticate with user credentials (admin user)
     */
    async authenticateWithUserCredentials(
        envPath: string,
        userName: string,
        password: string
    ): Promise<boolean> {
        if (!userName || !password) {
            this.apiClientAccessToken = null;
            return false;
        }

        this.envPath = envPath || "http://localhost:8000";
        this.authenticationType = "user";

        // Store credentials for token refresh
        this.userCredentials = { username: userName, password: password };

        this.apiClient = new FetchClient();
        this.apiClient.setBaseURL(`${this.envPath}/api/`);

        const authResponse = await this.apiClient.post<{
            access_token?: string;
            expires_in?: number;
        }>("oauth/token", {
            client_id: "administration",
            grant_type: "password",
            username: userName,
            password: password,
            scope: "write",
        });

        if (!authResponse.data.access_token) {
            this.apiClientAccessToken = null;
            this.tokenExpiresAt = 0;
            return false;
        }

        this.apiClientAccessToken = authResponse.data.access_token;
        this.apiClient.setAuthHeader(this.apiClientAccessToken);

        // Store token expiration time (default to 10 minutes if not provided)
        const expiresIn = authResponse.data.expires_in || 600;
        this.tokenExpiresAt = Date.now() + expiresIn * 1000;

        return true;
    }

    // =========================================================================
    // Common lookup methods used by both hydrator and cleanup
    // =========================================================================

    /** Get currency ID by ISO code */
    async getCurrencyId(currency = "EUR"): Promise<string> {
        const currencyResponse = await this.apiClient.post<{
            data: { id: string }[];
        }>("search/currency", {
            limit: 1,
            filter: [{ type: "equals", field: "isoCode", value: currency }],
        });
        const currencyData = currencyResponse.data.data[0];
        if (!currencyData) {
            throw new Error(`Currency "${currency}" not found`);
        }
        return currencyData.id;
    }

    /** Get standard tax ID */
    async getStandardTaxId(): Promise<string> {
        const taxResponse = await this.apiClient.post<{
            data: { id: string }[];
        }>("search/tax", { limit: 1 });

        if (!taxResponse.ok) {
            throw new Error(`Failed to search tax: ${JSON.stringify(taxResponse.data)}`);
        }

        const taxData = taxResponse.data?.data?.[0];
        if (!taxData) {
            throw new Error(`No tax rate found. Response: ${JSON.stringify(taxResponse.data)}`);
        }
        return taxData.id;
    }

    /** Get sales channel by name */
    async getStandardSalesChannel(salesChannelName: string = "Storefront"): Promise<{
        id: string;
        navigationCategoryId: string;
        currencyId?: string;
    }> {
        const salesChannelResponse = await this.apiClient.post<{
            data: { id: string; navigationCategoryId: string; currencyId?: string }[];
        }>("search/sales-channel", {
            limit: 1,
            filter: [{ type: "equals", field: "name", value: salesChannelName }],
        });

        if (!salesChannelResponse.ok) {
            throw new Error(
                `Failed to search sales channel: ${JSON.stringify(salesChannelResponse.data)}`
            );
        }

        const salesChannel = salesChannelResponse.data?.data?.[0];
        if (!salesChannel) {
            throw new Error(
                `Sales channel "${salesChannelName}" not found. Response: ${JSON.stringify(salesChannelResponse.data)}`
            );
        }
        return salesChannel;
    }

    /** Get full sales channel details for cloning */
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
        interface SalesChannelSearchItem {
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
            domains?: Array<{ snippetSetId: string }>;
        }

        const response = await this.apiClient.post<{ data: SalesChannelSearchItem[] }>(
            "search/sales-channel",
            {
                limit: 1,
                filter: [{ type: "equals", field: "name", value: salesChannelName }],
                associations: { domains: {} },
            }
        );

        if (!response.ok) {
            throw new Error(`Failed to search sales channel: ${JSON.stringify(response.data)}`);
        }

        const salesChannel = response.data?.data?.[0];
        if (!salesChannel) {
            throw new Error(
                `Sales channel "${salesChannelName}" not found. Response: ${JSON.stringify(response.data)}`
            );
        }

        return {
            ...salesChannel,
            snippetSetId: salesChannel.domains?.[0]?.snippetSetId,
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
            const defaultFolderResponse = await this.apiClient.post<{
                total: number;
                data: { folder?: { id: string; name: string } }[];
            }>("search/media-default-folder", {
                limit: 1,
                filter: [{ type: "equals", field: "entity", value: "product" }],
                associations: { folder: {} },
            });

            if (
                defaultFolderResponse.data.total > 0 &&
                defaultFolderResponse.data.data[0]?.folder?.id
            ) {
                this.productMediaFolderId = defaultFolderResponse.data.data[0].folder.id;
                return this.productMediaFolderId;
            }

            // Fallback: search for folder by name
            const folderResponse = await this.apiClient.post<{
                total: number;
                data: { id: string }[];
            }>("search/media-folder", {
                limit: 1,
                filter: [{ type: "equals", field: "name", value: "Product Media" }],
            });

            const folder = folderResponse.data.data[0];
            if (folderResponse.data.total > 0 && folder) {
                this.productMediaFolderId = folder.id;
                return this.productMediaFolderId;
            }

            this.productMediaFolderId = null;
            return null;
        } catch (error) {
            console.warn("Failed to get Product Media folder:", error);
            this.productMediaFolderId = null;
            return null;
        }
    }

    /**
     * Get the theme ID assigned to a SalesChannel
     * @param salesChannelId - The SalesChannel ID
     * @returns The theme ID or null if no theme is assigned
     */
    async getThemeForSalesChannel(salesChannelId: string): Promise<string | null> {
        try {
            // First try to get theme from theme-sales-channel relationship
            const response = await this.apiClient.post<{
                total: number;
                data: Array<{ id: string; themeId: string }>;
            }>("search/theme-sales-channel", {
                limit: 1,
                filter: [{ type: "equals", field: "salesChannelId", value: salesChannelId }],
            });

            if (response.ok && response.data.total > 0) {
                return response.data.data[0]?.themeId ?? null;
            }

            // Fallback: search for the default Storefront theme
            return await this.getDefaultStorefrontTheme();
        } catch {
            // Try fallback on error
            return await this.getDefaultStorefrontTheme();
        }
    }

    /**
     * Get the default Storefront theme ID
     * Searches for a theme with technicalName "Storefront" or name containing "Storefront"
     */
    async getDefaultStorefrontTheme(): Promise<string | null> {
        try {
            // Search for active themes
            const response = await this.apiClient.post<{
                total: number;
                data: Array<{ id: string; technicalName: string; name: string }>;
            }>("search/theme", {
                limit: 10,
                filter: [{ type: "equals", field: "active", value: true }],
            });

            if (!response.ok || response.data.total === 0) {
                return null;
            }

            // Look for "Storefront" theme by technicalName
            const storefrontTheme = response.data.data.find(
                (t) => t.technicalName === "Storefront" || t.name === "Storefront"
            );

            if (storefrontTheme) {
                return storefrontTheme.id;
            }

            // Return first active theme as fallback
            return response.data.data[0]?.id ?? null;
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
            const response = await this.apiClient.post<{
                data?: Array<{ id: string }>;
            }>("search/cms-page", {
                filter: [{ type: "equals", field: "name", value: name }],
                limit: 1,
            });

            if (response.ok && response.data?.data?.[0]) {
                return response.data.data[0].id;
            }
        } catch (error) {
            console.warn(`Failed to find CMS page "${name}":`, error);
        }

        return null;
    }

    /**
     * Get a CMS page by ID with full associations (sections, blocks, slots)
     * @param id - The CMS page ID
     * @returns The full CMS page data or null if not found
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
            interface CmsPageResponse {
                data?: Array<{
                    id: string;
                    attributes?: {
                        name?: string;
                        type?: string;
                    };
                    name?: string;
                    type?: string;
                }>;
                included?: Array<{
                    id: string;
                    type: string;
                    attributes?: Record<string, unknown>;
                }>;
            }

            const response = await this.apiClient.post<CmsPageResponse>("search/cms-page", {
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
            });

            if (!response.ok || !response.data?.data?.[0]) {
                return null;
            }

            const pageData = response.data.data[0];
            const included = response.data.included || [];

            // Parse the included data to build the full structure
            const sectionsMap = new Map<
                string,
                {
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
                }
            >();

            const blocksMap = new Map<
                string,
                {
                    id: string;
                    type: string;
                    position: number;
                    sectionId: string;
                    slots: Array<{
                        id: string;
                        type: string;
                        slot: string;
                        config: Record<string, unknown>;
                    }>;
                }
            >();

            // First pass: collect all items
            for (const item of included) {
                const attrs = item.attributes || {};
                if (item.type === "cms_section") {
                    sectionsMap.set(item.id, {
                        id: item.id,
                        type: (attrs.type as string) || "default",
                        position: (attrs.position as number) || 0,
                        blocks: [],
                    });
                } else if (item.type === "cms_block") {
                    blocksMap.set(item.id, {
                        id: item.id,
                        type: (attrs.type as string) || "",
                        position: (attrs.position as number) || 0,
                        sectionId: (attrs.sectionId as string) || "",
                        slots: [],
                    });
                } else if (item.type === "cms_slot") {
                    const blockId = (attrs.blockId as string) || "";
                    const block = blocksMap.get(blockId);
                    if (block) {
                        block.slots.push({
                            id: item.id,
                            type: (attrs.type as string) || "",
                            slot: (attrs.slot as string) || "",
                            config: (attrs.config as Record<string, unknown>) || {},
                        });
                    }
                }
            }

            // Second pass: link blocks to sections
            for (const block of blocksMap.values()) {
                const section = sectionsMap.get(block.sectionId);
                if (section) {
                    section.blocks.push({
                        id: block.id,
                        type: block.type,
                        position: block.position,
                        slots: block.slots,
                    });
                }
            }

            // Sort sections and blocks by position
            const sections = Array.from(sectionsMap.values())
                .sort((a, b) => a.position - b.position)
                .map((section) => ({
                    ...section,
                    blocks: section.blocks.sort((a, b) => a.position - b.position),
                }));

            const attrs = pageData.attributes || pageData;
            return {
                id: pageData.id,
                name: (attrs.name as string) || "",
                type: (attrs.type as string) || "",
                sections,
            };
        } catch (error) {
            console.warn(`Failed to get CMS page "${id}":`, error);
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
            const response = await this.apiClient.post<{
                data?: Array<{ id: string }>;
            }>("search/category", {
                filter: [
                    { type: "equals", field: "name", value: name },
                    { type: "equals", field: "parentId", value: parentId },
                ],
                limit: 1,
            });

            if (response.ok && response.data?.data?.[0]) {
                return response.data.data[0].id;
            }
        } catch (error) {
            console.warn(`Failed to find category "${name}":`, error);
        }

        return null;
    }

    /**
     * Assign a theme to a SalesChannel
     * @param salesChannelId - The SalesChannel ID
     * @param themeId - The theme ID to assign
     */
    async assignThemeToSalesChannel(salesChannelId: string, themeId: string): Promise<boolean> {
        try {
            // Use the theme API action to assign the theme
            const response = await this.apiClient.post(
                `_action/theme/${themeId}/assign/${salesChannelId}`,
                {}
            );

            if (response.ok) {
                console.log(`Theme assigned to SalesChannel`);
                return true;
            }

            // Fallback: try creating a direct entry
            await this.apiClient.post("theme-sales-channel", {
                themeId,
                salesChannelId,
            });

            console.log(`Theme assigned to SalesChannel (via direct entry)`);
            return true;
        } catch (error) {
            console.warn("Failed to assign theme to SalesChannel:", error);
            return false;
        }
    }
}
