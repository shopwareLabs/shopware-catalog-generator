/**
 * Storefront domain checks - request every SalesChannel domain and expect HTTP 200.
 *
 * Pure functions with an injectable fetch so the logic is unit-testable without a shop.
 * Used by the E2E verifier (tests/e2e/verify.ts).
 */

export interface StorefrontDomainCheck {
    url: string;
    /** HTTP status, or null when the request itself failed (network error, timeout) */
    status: number | null;
    error?: string;
}

export interface StorefrontVerification {
    checks: StorefrontDomainCheck[];
    errors: string[];
}

export interface StorefrontCheckOptions {
    /** Fetch implementation, defaults to the global fetch */
    fetchFn?: typeof fetch;
    /** Per-request timeout in milliseconds (default 60s, the first request may warm the theme cache) */
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Pick the usable URLs from a SalesChannel domain search result */
export function collectDomainUrls(domains: ReadonlyArray<{ url?: string | null }>): string[] {
    return domains
        .map((domain) => domain.url)
        .filter((url): url is string => typeof url === "string" && url.length > 0);
}

/** Request a single storefront URL and report its status without throwing */
export async function checkStorefrontUrl(
    url: string,
    options: StorefrontCheckOptions = {}
): Promise<StorefrontDomainCheck> {
    const fetchFn = options.fetchFn ?? fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
        const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
        await response.body?.cancel();
        return { url, status: response.status };
    } catch (error) {
        return {
            url,
            status: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/** Human-readable reason for a failed check (undefined when the check passed) */
export function describeStorefrontFailure(check: StorefrontDomainCheck): string | undefined {
    if (check.status === 200) {
        return undefined;
    }
    return check.error ?? `HTTP ${check.status}`;
}

/**
 * Check every domain URL sequentially (the first request may warm up theme and HTTP cache)
 * and collect one error per failing domain. No domains at all is an error too.
 */
export async function verifyStorefrontDomains(
    urls: string[],
    options: StorefrontCheckOptions = {}
): Promise<StorefrontVerification> {
    if (urls.length === 0) {
        return { checks: [], errors: ["SalesChannel has no domains"] };
    }

    const checks: StorefrontDomainCheck[] = [];
    for (const url of urls) {
        checks.push(await checkStorefrontUrl(url, options));
    }

    const errors = checks
        .map((check) => ({ check, reason: describeStorefrontFailure(check) }))
        .filter(
            (entry): entry is { check: StorefrontDomainCheck; reason: string } => !!entry.reason
        )
        .map(({ check, reason }) => `Storefront domain ${check.url} failed: ${reason}`);

    return { checks, errors };
}
