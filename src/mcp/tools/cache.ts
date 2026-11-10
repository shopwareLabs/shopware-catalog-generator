/**
 * Cache Tools for MCP Server
 *
 * The tools come from the shared command specs (src/services/commands.ts), so the cache
 * CLI behaves the same.
 */

import type { FastMCP } from "fastmcp";

import {
    CACHE_CLEAR,
    CACHE_EMPTY_TRASH,
    CACHE_LIST,
    CACHE_RESTORE,
    CACHE_TRASH,
} from "../../services/commands.js";
import { registerCommandTool } from "./command-tool.js";

export function registerCacheTools(server: FastMCP): void {
    registerCommandTool(server, CACHE_LIST);
    registerCommandTool(server, CACHE_CLEAR);
    registerCommandTool(server, CACHE_TRASH);
    registerCommandTool(server, CACHE_RESTORE);
    registerCommandTool(server, CACHE_EMPTY_TRASH);
}
