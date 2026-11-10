/**
 * Blueprint Tools for MCP Server
 *
 * Registered from the shared command specs (src/services/commands.ts), like the CLI commands.
 */

import type { FastMCP } from "fastmcp";

import {
    BLUEPRINT_CREATE,
    BLUEPRINT_ESTIMATE,
    BLUEPRINT_FIX,
    BLUEPRINT_HYDRATE,
    BLUEPRINT_INSPIRE,
    BLUEPRINT_TRANSLATE,
} from "../../services/commands.js";
import { registerCommandTool } from "./command-tool.js";

export function registerBlueprintTools(server: FastMCP): void {
    registerCommandTool(server, BLUEPRINT_INSPIRE);
    registerCommandTool(server, BLUEPRINT_CREATE);
    registerCommandTool(server, BLUEPRINT_ESTIMATE);
    registerCommandTool(server, BLUEPRINT_TRANSLATE);
    registerCommandTool(server, BLUEPRINT_HYDRATE);
    registerCommandTool(server, BLUEPRINT_FIX);
}
