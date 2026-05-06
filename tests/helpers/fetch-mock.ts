export type FetchMockImpl = (
    input: string | URL | Request,
    init?: RequestInit
) => Promise<{
    ok: boolean;
    text?: () => Promise<string>;
    arrayBuffer?: () => Promise<ArrayBuffer | SharedArrayBuffer>;
    headers: { get: (name: string) => string | null };
}>;

export function mockFetch(impl: FetchMockImpl): void {
    globalThis.fetch = impl as unknown as typeof fetch;
}
