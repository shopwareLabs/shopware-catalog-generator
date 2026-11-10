/**
 * POST /generate - thin wrapper around runGenerate(), like the CLI and MCP commands.
 *
 * The body uses the same generate parameters as the MCP tool (generateRequestParams),
 * plus the server-only fields: Shopware URL and admin user, cache clearing, inspiration
 * crawl and skipping post-processors. Older field names (salesChannel, productCount,
 * skipTemplate) are still accepted.
 */

import { z } from "zod";

import type { GenerateRequest } from "../services/generate-request.js";
import type { GenerateOptions, RunGenerate } from "../services/generate-service.js";
import type { ProcessContext, ProcessManager } from "./process-manager.js";

import {
    buildGenerateRequest,
    generateInputFromParams,
    generateRequestParams,
} from "../services/generate-request.js";

const DEFAULT_NAME = "demo-store";

export const generateBodySchema = z.object({
    ...generateRequestParams,
    name: generateRequestParams.name.optional(),
    /** @deprecated alias of name */
    salesChannel: z.string().optional(),
    /** @deprecated alias of products */
    productCount: z.number().optional(),
    /** @deprecated alias of noTemplate */
    skipTemplate: z.boolean().optional(),
    envPath: z.string().min(1),
    shopwareUser: z.string().min(1),
    shopwarePassword: z.string().min(1),
    cache: z.object({ clearFirst: z.boolean().optional() }).optional(),
    skipProcessors: z.boolean().optional(),
    inspirationUrl: z.string().optional(),
});

export interface ServerGenerateRequest {
    request: GenerateRequest;
    /** Server-only options (connection, cache, inspiration, processors) */
    serverOptions: GenerateOptions;
}

export interface GenerateRouteDeps {
    runGenerate: RunGenerate;
    processManager: Pick<ProcessManager, "start">;
}

export function deriveNameFromUrl(url: string): string | null {
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, "");
        const sld = hostname.split(".")[0];
        return sld && sld.length > 0 ? sld : null;
    } catch {
        return null;
    }
}

/** Validate a POST /generate body. Returns an "Error: ..." line for invalid input. */
export function parseGenerateBody(
    body: unknown,
    env: Record<string, string | undefined> = process.env
): ServerGenerateRequest | { error: string } {
    const parsed = generateBodySchema.safeParse(body);
    if (!parsed.success) {
        const issues = parsed.error.issues.map(
            (i) => `${i.path.join(".") || "body"}: ${i.message}`
        );
        return { error: `Error: Invalid request - ${issues.join("; ")}` };
    }
    const data = parsed.data;
    const inspirationName = data.inspirationUrl ? deriveNameFromUrl(data.inspirationUrl) : null;

    const built = buildGenerateRequest(
        generateInputFromParams({
            ...data,
            name: data.name || data.salesChannel || inspirationName || DEFAULT_NAME,
            products: data.products ?? data.productCount,
            noTemplate: data.noTemplate ?? data.skipTemplate,
        }),
        env
    );
    if ("error" in built) return built;

    return {
        request: built.request,
        serverOptions: {
            connection: {
                url: data.envPath,
                credentials: {
                    kind: "user",
                    username: data.shopwareUser,
                    password: data.shopwarePassword,
                },
            },
            clearCache: data.cache?.clearFirst === true,
            inspirationUrl: data.inspirationUrl,
            skipProcessors: data.skipProcessors === true,
        },
    };
}

/** Background task: the result is the run summary, a run without one fails the process */
export async function runGenerateTask(
    parsed: ServerGenerateRequest,
    ctx: Pick<ProcessContext, "log" | "setProgress">,
    run: RunGenerate
): Promise<unknown> {
    const { salesChannelName, description, options } = parsed.request;
    const result = await run(salesChannelName, description, {
        ...options,
        ...parsed.serverOptions,
        hooks: { onLine: ctx.log, onProgress: ctx.setProgress },
    });

    const errors = result.lines.filter((line) => line.startsWith("Error:"));
    if (!result.summary) {
        throw new Error(errors[0]?.slice("Error: ".length) ?? "Generation did not finish");
    }
    return { ...result.summary, errors };
}

export async function handleGenerate(request: Request, deps: GenerateRouteDeps): Promise<Response> {
    const body: unknown = await request.json().catch(() => ({}));
    const parsed = parseGenerateBody(body);
    if ("error" in parsed) {
        return Response.json({ error: parsed.error.slice("Error: ".length) }, { status: 400 });
    }

    const { salesChannelName } = parsed.request;
    const processId = deps.processManager.start(`Generate ${salesChannelName}`, (ctx) =>
        runGenerateTask(parsed, ctx, deps.runGenerate)
    );

    return Response.json({
        processId,
        message: "Generation started in background",
        salesChannel: salesChannelName,
        statusUrl: `/status/${processId}`,
    });
}
