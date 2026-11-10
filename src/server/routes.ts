/**
 * HTTP routes of the server: POST /generate, GET /status/:id and GET /health.
 *
 * `server.ts` only starts Bun.serve with `createRequestHandler()`. The process manager and
 * the generate pipeline are injected, so the routes can be tested without a server.
 */

import type { RunGenerate } from "../services/generate-service.js";
import type { ProcessManager } from "./process-manager.js";

import { handleGenerate } from "./generate-route.js";

export interface ServerDeps {
    runGenerate: RunGenerate;
    processManager: Pick<ProcessManager, "start" | "get" | "getLogs" | "getStats">;
    /** Seconds since the server process started (default: process.uptime) */
    uptime?: () => number;
}

const STATUS_PREFIX = "/status/";

function errorResponse(error: string, status = 500): Response {
    return Response.json({ error }, { status });
}

/** Log offset from `?from=`, 0 when missing */
function logOffset(request: Request): number {
    const from = new URL(request.url).searchParams.get("from");
    return parseInt(from || "0", 10);
}

/** GET /status/:id - Get process status and logs */
export function handleStatus(
    processId: string,
    request: Request,
    processManager: ServerDeps["processManager"]
): Response {
    const state = processManager.get(processId);
    if (!state) {
        return errorResponse(`Process "${processId}" not found`, 404);
    }

    return Response.json({
        id: state.id,
        name: state.name,
        status: state.status,
        progress: state.progress,
        startedAt: state.startedAt.toISOString(),
        completedAt: state.completedAt?.toISOString(),
        logs: processManager.getLogs(processId, logOffset(request)),
        logCount: state.logs.length,
        result: state.status === "completed" ? state.result : undefined,
        error: state.status === "failed" ? state.error : undefined,
    });
}

/** GET /health - Health check */
export function handleHealth(deps: ServerDeps): Response {
    const stats = deps.processManager.getStats();
    const uptime = deps.uptime ?? process.uptime;

    return Response.json({
        status: "ok",
        activeProcesses: stats.active,
        totalProcesses: stats.total,
        uptime: uptime(),
    });
}

/** Process ID of a `GET /status/:id` path, or null for any other path or an empty ID */
function statusProcessId(pathname: string): string | null {
    if (!pathname.startsWith(STATUS_PREFIX)) return null;
    return decodeURIComponent(pathname.slice(STATUS_PREFIX.length)) || null;
}

/** Route one request. Unknown paths and methods return 404. */
export function routeRequest(request: Request, deps: ServerDeps): Response | Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (method === "POST" && pathname === "/generate") {
        return handleGenerate(request, deps);
    }
    if (method !== "GET") {
        return new Response("Not Found", { status: 404 });
    }

    const processId = statusProcessId(pathname);
    if (processId) {
        return handleStatus(processId, request, deps.processManager);
    }
    if (pathname === "/health") {
        return handleHealth(deps);
    }
    return new Response("Not Found", { status: 404 });
}

/** The `fetch` handler for Bun.serve */
export function createRequestHandler(deps: ServerDeps): (request: Request) => Promise<Response> {
    return async (request) => routeRequest(request, deps);
}
