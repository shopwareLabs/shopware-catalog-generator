/**
 * Currency resolution utilities for post-processors.
 *
 * Mirrors the fallback logic used by createSalesChannel() in hydrator.ts:
 * USD → EUR → SalesChannel's own currency. Each lookup is independent
 * so a missing USD does not prevent the EUR lookup from running.
 */

import type { ShopwareApi } from "../shopware/api-helpers.js";

import { logger } from "../utils/index.js";

/**
 * Resolve the primary currency ID for a SalesChannel.
 *
 * Fallback order:
 *   1. USD (matches the project's multi-currency model)
 *   2. EUR
 *   3. The SalesChannel's own configured currency
 *
 * Each lookup is independent — a missing currency does not short-circuit
 * subsequent attempts (unlike a single try/catch around sequential awaits).
 */
export async function resolvePrimaryCurrencyId(
    api: ShopwareApi,
    salesChannelId: string
): Promise<string> {
    const [usdId, eurId] = await Promise.all([
        api.getCurrencyId("USD").catch(() => null),
        api.getCurrencyId("EUR").catch(() => null),
    ]);

    if (usdId) return usdId;
    if (eurId) return eurId;

    logger.warn("Neither USD nor EUR found — falling back to SalesChannel currency");

    const [sc] = await api.searchEntities<{ currencyId: string }>(
        "sales_channel",
        [{ type: "equals", field: "id", value: salesChannelId }],
        { limit: 1 }
    );

    if (sc?.currencyId) return sc.currencyId;

    throw new Error("No currency found: USD, EUR, and SalesChannel lookup all failed");
}
