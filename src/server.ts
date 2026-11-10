/**
 * HTTP Server for Shopware Catalog Generator
 *
 * Provides REST API for generating products with background processing.
 * Each generation runs in the background and can be monitored via status endpoint.
 * The routes live in src/server/routes.ts.
 */

import { processManager } from "./server/index.js";
import { createRequestHandler } from "./server/routes.js";
import { runGenerate } from "./services/generate-service.js";

const port = Number(process.env.SERVER_PORT) || 3000;

const server = Bun.serve({
    port,
    fetch: createRequestHandler({ runGenerate, processManager }),
});

console.log(`Server started on port ${server.port}`);
console.log(`Endpoints:`);
console.log(`  POST /generate     - Start generation (returns processId)`);
console.log(`  GET  /status/:id   - Get process status and logs`);
console.log(`  GET  /health       - Health check`);
