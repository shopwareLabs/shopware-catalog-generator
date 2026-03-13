/**
 * Currency resolution utilities for post-processors.
 *
 * Finds the system base currency (factor = 1) — the same currency that
 * ShopwareHydrator.getCurrencyId() defaults to and that product prices use.
 * This ensures variant and digital product prices pass Shopware's
 * PriceFieldSerializer validation ("No price for default currency defined").
 */

import type { ShopwareApi } from "../shopware/api-helpers.js";

import { logger } from "../utils/index.js";

/**
 * Resolve the primary currency ID for a SalesChannel.
 *
 * Matches the currency used by the main product sync (ShopwareHydrator.getCurrencyId):
 *
 *   1. System base currency (factor = 1) — what Shopware uses as the default for
 *      price validation; EUR in a standard installation
 *   2. The SalesChannel's own configured currency — last resort
 *
 * Note: USD is intentionally NOT prioritised here. Even though the SalesChannel
 * is created with USD as a secondary currency, product prices must be expressed
 * in the system base currency or Shopware will reject the sync with
 * "No price for default currency defined".
 */
export async function resolvePrimaryCurrencyId(
    api: ShopwareApi,
    salesChannelId: string
): Promise<string> {
    // Find the system base currency (factor = 1) — this is the default for product prices
    const baseCurrencies = await api
        .searchEntities<{ id: string }>(
            "currency",
            [{ type: "equals", field: "factor", value: 1 }],
            { limit: 1 }
        )
        .catch(() => []);

    if (baseCurrencies[0]?.id) return baseCurrencies[0].id;

    logger.warn("Base currency (factor=1) not found — falling back to SalesChannel currency");

    const [sc] = await api.searchEntities<{ currencyId: string }>(
        "sales_channel",
        [{ type: "equals", field: "id", value: salesChannelId }],
        { limit: 1 }
    );

    if (sc?.currencyId) return sc.currencyId;

    throw new Error("No currency found: base currency and SalesChannel lookup all failed");
}
