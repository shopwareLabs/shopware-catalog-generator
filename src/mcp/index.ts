/**
 * MCP Server for Shopware Catalog Generator
 *
 * Exposes CLI commands as MCP tools for Cursor AI integration.
 * This enables auto-discovery of available commands without grepping the codebase.
 *
 * Usage:
 *   npx fastmcp dev src/mcp/index.ts     # Interactive terminal testing
 *   npx fastmcp inspect src/mcp/index.ts # Web UI inspector
 */

import { FastMCP } from "fastmcp";

import { logger } from "../utils/index.js";

import {
    registerBlueprintTools,
    registerCacheTools,
    registerCleanupTools,
    registerGenerateTools,
} from "./tools/index.js";

// Enable MCP mode to suppress console output (prevents stdout pollution)
logger.setMcpMode(true);

/**
 * Create and configure the MCP server.
 * Exported for testing purposes.
 */
export function createMcpServer(): FastMCP {
    const server = new FastMCP({
        name: "catalog-generator",
        version: "1.0.0",
    });

    // Register all tool categories
    registerBlueprintTools(server);
    registerGenerateTools(server);
    registerCacheTools(server);
    registerCleanupTools(server);

    return server;
}

// Start server when run directly
const server = createMcpServer();
server.start({ transportType: "stdio" });
