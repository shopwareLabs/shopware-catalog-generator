/**
 * Currency resolution utilities for post-processors.
 *
 * Finds the system base currency — the same currency that
 * ShopwareHydrator.getCurrencyId() defaults to and that product prices use.
 * This ensures variant and digital product prices pass Shopware's
 * PriceFieldSerializer validation ("No price for default currency defined").
 */

import type { ShopwareApi } from "../shopware/api-helpers.js";

import { logger } from "../utils/index.js";

/**
 * Resolve the primary currency ID used for product prices.
 *
 * Must match the currency used by ShopwareHydrator.getCurrencyId() (defaults to EUR)
 * so that variant/digital-product prices are consistent with their parent products.
 *
 * Resolution order:
 *   1. System base currency (factor = 1) — EUR in a standard Shopware installation
 *   2. EUR by ISO code — fallback matching ShopwareHydrator.getCurrencyId() default
 *
 * The SalesChannel's configured currency is intentionally NOT used as a fallback:
 * SalesChannels are created with USD as their primary currency, but product prices
 * are always expressed in the system base currency (EUR). Using USD would cause
 * Shopware to reject variant syncs with "No price for default currency defined".
 */
export async function resolvePrimaryCurrencyId(api: ShopwareApi): Promise<string> {
    // Try system base currency first (factor = 1, typically EUR)
    const baseCurrencies = await api
        .searchEntities<{ id: string }>(
            "currency",
            [{ type: "equals", field: "factor", value: 1 }],
            { limit: 1 }
        )
        .catch(() => []);

    if (baseCurrencies[0]?.id) return baseCurrencies[0].id;

    // Fall back to EUR by ISO code — matches ShopwareHydrator.getCurrencyId() default
    logger.warn("Base currency (factor=1) not found — falling back to EUR");
    return api.getCurrencyId("EUR");
}
