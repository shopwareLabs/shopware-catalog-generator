/**
 * Shared PostProcessorContext factory for tests.
 *
 * Returns a fully typed context with no `as unknown as` casts. Each test only
 * provides overrides for the fields it cares about.
 */

import type {
    PostProcessorContext,
    PostProcessorOptions,
} from "../../src/post-processors/index.js";
import type { ImageProvider, ProductMetadata } from "../../src/types/index.js";
import type { HydratedBlueprint } from "../../src/types/index.js";
import type { MockApiHelpers } from "../mocks/index.js";

import { createMockApiHelpers, createMockDataCache, MockDataCache } from "../mocks/index.js";
import { createTestBlueprint } from "./blueprint-factory.js";

export interface TestContextOptions {
    dryRun?: boolean;
    salesChannelId?: string;
    salesChannelName?: string;
    blueprint?: HydratedBlueprint;
    metadataMap?: Map<string, Partial<ProductMetadata>>;
    cachedImages?: Set<string>;
    staleImages?: Set<string>;
    imageProvider?: ImageProvider;
    activeProcessors?: string[];
    options?: Partial<PostProcessorOptions>;
    mockApi?: MockApiHelpers;
}

export interface TestContextResult {
    context: PostProcessorContext;
    mockApi: MockApiHelpers;
    mockCache: MockDataCache;
}

export function createTestContext(opts: TestContextOptions = {}): TestContextResult {
    const mockApi = opts.mockApi ?? createMockApiHelpers();
    const mockCache = createMockDataCache({
        metadataMap: opts.metadataMap,
        cachedImages: opts.cachedImages,
        staleImages: opts.staleImages,
    });

    const context: PostProcessorContext = {
        salesChannelId: opts.salesChannelId ?? "sc-123",
        salesChannelName: opts.salesChannelName ?? "test-store",
        blueprint: opts.blueprint ?? createTestBlueprint(),
        cache: mockCache,
        api: mockApi,
        imageProvider: opts.imageProvider,
        options: {
            batchSize: 5,
            dryRun: opts.dryRun ?? false,
            activeProcessors: opts.activeProcessors,
            ...opts.options,
        },
    };

    return { context, mockApi, mockCache };
}
