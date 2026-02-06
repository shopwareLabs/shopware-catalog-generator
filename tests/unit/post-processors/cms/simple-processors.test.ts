/**
 * Tests for simple CMS processors that only inherit from BaseCmsProcessor
 * without custom logic: TextProcessor, VideoProcessor, TextImagesProcessor, FormProcessor
 */
import { describe, expect, mock, test } from "bun:test";

import type { PostProcessorContext } from "../../../../src/post-processors/index.js";

import { FormProcessor } from "../../../../src/post-processors/cms/form-processor.js";
import { TextImagesProcessor } from "../../../../src/post-processors/cms/text-images-processor.js";
import { TextProcessor } from "../../../../src/post-processors/cms/text-processor.js";
import { VideoProcessor } from "../../../../src/post-processors/cms/video-processor.js";

// Helper to create mock cache
function createMockCache() {
    return {
        getSalesChannelDir: mock(() => "/tmp/test-cache"),
        loadProductMetadata: mock(() => null),
    };
}

// Helper to create mock context
function createMockContext(
    options: {
        dryRun?: boolean;
        fetchResponses?: Map<string, { ok: boolean; data: unknown }>;
    } = {}
): { context: PostProcessorContext; fetchCalls: Array<{ url: string; method: string }> } {
    const fetchCalls: Array<{ url: string; method: string }> = [];
    const responses = options.fetchResponses || new Map();

    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method || "GET";

        fetchCalls.push({ url, method });

        for (const [pattern, response] of responses.entries()) {
            if (url.includes(pattern)) {
                return {
                    ok: response.ok,
                    status: response.ok ? 200 : 500,
                    json: async () => response.data,
                    text: async () => JSON.stringify(response.data),
                } as Response;
            }
        }

        return {
            ok: true,
            status: 200,
            json: async () => ({ data: [] }),
            text: async () => "{}",
        } as Response;
    }) as unknown as typeof fetch;

    const context: PostProcessorContext = {
        salesChannelId: "sc-123",
        salesChannelName: "test-store",
        blueprint: {
            version: "1.0",
            salesChannel: { name: "test-store", description: "Test store" },
            categories: [],
            products: [],
            propertyGroups: [],
            createdAt: new Date().toISOString(),
            hydratedAt: new Date().toISOString(),
        },
        cache: createMockCache() as unknown as PostProcessorContext["cache"],
        shopwareUrl: "https://test.shopware.com",
        getAccessToken: async () => "test-token",
        options: {
            batchSize: 5,
            dryRun: options.dryRun || false,
        },
    };

    return { context, fetchCalls };
}

describe("TextProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(TextProcessor.name).toBe("cms-text");
        });

        test("has description", () => {
            expect(TextProcessor.description).toBeDefined();
            expect(TextProcessor.description).toContain("Text");
        });

        test("has no dependencies", () => {
            expect(TextProcessor.dependsOn).toEqual([]);
        });

        test("has page fixture with correct name", () => {
            expect(TextProcessor.pageFixture.name).toBe("Text Elements");
        });

        test("page fixture has text blocks", () => {
            const blocks = TextProcessor.pageFixture.sections.flatMap((s) => s.blocks);
            expect(blocks.length).toBeGreaterThan(0);
            expect(blocks.some((b) => b.type === "text" || b.type === "text-hero")).toBe(true);
        });
    });

    describe("process", () => {
        test("dry run logs without API calls", async () => {
            const { context, fetchCalls } = createMockContext({ dryRun: true });

            const result = await TextProcessor.process(context);

            expect(result.name).toBe("cms-text");
            expect(result.processed).toBe(1);
            expect(result.errors).toEqual([]);
            expect(fetchCalls.length).toBe(0);
        });
    });
});

describe("VideoProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(VideoProcessor.name).toBe("cms-video");
        });

        test("has description", () => {
            expect(VideoProcessor.description).toBeDefined();
            expect(VideoProcessor.description).toContain("Video");
        });

        test("has no dependencies", () => {
            expect(VideoProcessor.dependsOn).toEqual([]);
        });

        test("has page fixture with correct name", () => {
            expect(VideoProcessor.pageFixture.name).toBe("Video Elements");
        });

        test("page fixture has video blocks", () => {
            const blocks = VideoProcessor.pageFixture.sections.flatMap((s) => s.blocks);
            expect(blocks.length).toBeGreaterThan(0);
            expect(blocks.some((b) => b.type === "youtube-video" || b.type === "vimeo-video")).toBe(
                true
            );
        });
    });

    describe("process", () => {
        test("dry run logs without API calls", async () => {
            const { context, fetchCalls } = createMockContext({ dryRun: true });

            const result = await VideoProcessor.process(context);

            expect(result.name).toBe("cms-video");
            expect(result.processed).toBe(1);
            expect(result.errors).toEqual([]);
            expect(fetchCalls.length).toBe(0);
        });
    });
});

describe("TextImagesProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(TextImagesProcessor.name).toBe("cms-text-images");
        });

        test("has description", () => {
            expect(TextImagesProcessor.description).toBeDefined();
        });

        test("has no dependencies", () => {
            expect(TextImagesProcessor.dependsOn).toEqual([]);
        });

        test("has page fixture with correct name", () => {
            expect(TextImagesProcessor.pageFixture.name).toBe("Text & Images");
        });

        test("page fixture has text-image blocks", () => {
            const blocks = TextImagesProcessor.pageFixture.sections.flatMap((s) => s.blocks);
            expect(blocks.length).toBeGreaterThan(0);
        });
    });

    describe("process", () => {
        test("dry run logs without API calls", async () => {
            const { context, fetchCalls } = createMockContext({ dryRun: true });

            const result = await TextImagesProcessor.process(context);

            expect(result.name).toBe("cms-text-images");
            expect(result.processed).toBe(1);
            expect(result.errors).toEqual([]);
            expect(fetchCalls.length).toBe(0);
        });
    });
});

describe("FormProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(FormProcessor.name).toBe("cms-form");
        });

        test("has description", () => {
            expect(FormProcessor.description).toBeDefined();
            expect(FormProcessor.description).toContain("Form");
        });

        test("has no dependencies", () => {
            expect(FormProcessor.dependsOn).toEqual([]);
        });

        test("has page fixture with correct name", () => {
            expect(FormProcessor.pageFixture.name).toBe("Form Elements");
        });

        test("page fixture has form blocks", () => {
            const blocks = FormProcessor.pageFixture.sections.flatMap((s) => s.blocks);
            expect(blocks.length).toBeGreaterThan(0);
            expect(blocks.some((b) => b.type === "form")).toBe(true);
        });
    });

    describe("process", () => {
        test("dry run logs without API calls", async () => {
            const { context, fetchCalls } = createMockContext({ dryRun: true });

            const result = await FormProcessor.process(context);

            expect(result.name).toBe("cms-form");
            expect(result.processed).toBe(1);
            expect(result.errors).toEqual([]);
            expect(fetchCalls.length).toBe(0);
        });
    });
});
