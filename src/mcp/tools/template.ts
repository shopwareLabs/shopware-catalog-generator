/**
 * Template Tools for MCP Server
 *
 * template_metadata is registered from the shared command spec (src/services/commands.ts).
 */

import type { FastMCP } from "fastmcp";

import { TEMPLATE_METADATA } from "../../services/commands.js";
import { registerCommandTool } from "./command-tool.js";

export function registerTemplateTools(server: FastMCP): void {
    registerCommandTool(server, TEMPLATE_METADATA);
}
