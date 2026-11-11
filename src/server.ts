/**
 * HTTP Server for Shopware Catalog Generator
 *
 * Provides REST API for generating products with background processing.
 * Each generation runs in the background and can be monitored via status endpoint.
 * The routes live in src/server/routes.ts.
 */

import { resolveServerConfig } from "./server/config.js";
import { processManager } from "./server/index.js";
import { createRequestHandler } from "./server/routes.js";
import { runGenerate } from "./services/generate-service.js";

const config = resolveServerConfig(process.env);

const server = Bun.serve({
    port: config.port,
    hostname: config.hostname,
    fetch: createRequestHandler({ runGenerate, processManager, token: config.token }),
});

console.log(`Server started on http://${config.hostname}:${server.port}`);
if (config.token) console.log(`Requests need: Authorization: Bearer <SERVER_TOKEN>`);
console.log(`Endpoints:`);
console.log(`  POST /generate     - Start generation (returns processId)`);
console.log(`  GET  /status/:id   - Get process status and logs`);
console.log(`  GET  /health       - Health check`);
