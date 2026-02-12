/**
 * Type helpers for the Shopware Admin API client.
 *
 * These types bridge gaps in the official @shopware/api-client generated types:
 * - SearchResult<T>: Narrows the JSON/JSON:API union to the JSON branch
 * - SyncOperation: Typed sync payload for the /_action/sync endpoint
 */

/** JSON response shape for admin API search endpoints (narrows JSON/JSON:API union) */
export type SearchResult<T> = { data?: T[]; total?: number };

/** Typed sync operation for the /_action/sync endpoint */
export interface SyncOperation {
    entity: string;
    action: "upsert" | "delete";
    payload: Array<Record<string, unknown>>;
}
