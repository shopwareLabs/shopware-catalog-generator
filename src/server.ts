/**
 * HTTP Server for Shopware Catalog Generator
 *
 * Provides REST API for generating products with background processing.
 * Each generation runs in the background and can be monitored via status endpoint.
 */

import { handleGenerate } from "./server/generate-route.js";
import { processManager } from "./server/index.js";
import { runGenerate } from "./services/generate-service.js";

const port = Number(process.env.SERVER_PORT) || 3000;

function jsonResponse(data: unknown, status = 200): Response {
    return Response.json(data, { status });
}

function errorResponse(error: string, status = 500): Response {
    return Response.json({ error }, { status });
}

/** GET /status/:id - Get process status and logs */
function handleStatus(processId: string, request: Request): Response {
    const state = processManager.get(processId);

    if (!state) {
        return errorResponse(`Process "${processId}" not found`, 404);
    }

    // Check for log offset query param
    const url = new URL(request.url);
    const fromIndex = parseInt(url.searchParams.get("from") || "0", 10);
    const logs = processManager.getLogs(processId, fromIndex);

    return jsonResponse({
        id: state.id,
        name: state.name,
        status: state.status,
        progress: state.progress,
        startedAt: state.startedAt.toISOString(),
        completedAt: state.completedAt?.toISOString(),
        logs,
        logCount: state.logs.length,
        result: state.status === "completed" ? state.result : undefined,
        error: state.status === "failed" ? state.error : undefined,
    });
}

/** GET /health - Health check */
function handleHealth(): Response {
    const stats = processManager.getStats();

    return jsonResponse({
        status: "ok",
        activeProcesses: stats.active,
        totalProcesses: stats.total,
        uptime: process.uptime(),
    });
}

// =============================================================================
// Main Server
// =============================================================================

const server = Bun.serve({
    port,
    async fetch(request) {
        const url = new URL(request.url);
        const { pathname } = url;
        const method = request.method;

        // POST /generate - Start background generation
        if (pathname === "/generate" && method === "POST") {
            return await handleGenerate(request, { runGenerate, processManager });
        }

        // GET /status/:id - Get process status
        if (pathname.startsWith("/status/") && method === "GET") {
            const processId = decodeURIComponent(pathname.slice("/status/".length));
            if (processId) {
                return handleStatus(processId, request);
            }
        }

        // GET /health - Health check
        if (pathname === "/health" && method === "GET") {
            return handleHealth();
        }

        return new Response("Not Found", { status: 404 });
    },
});

console.log(`Server started on port ${server.port}`);
console.log(`Endpoints:`);
console.log(`  POST /generate     - Start generation (returns processId)`);
console.log(`  GET  /status/:id   - Get process status and logs`);
console.log(`  GET  /health       - Health check`);
