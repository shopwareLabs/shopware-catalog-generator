/**
 * Image Fix Tool for MCP Server
 *
 * image_fix is registered from the shared command spec (src/services/commands.ts).
 */

import type { FastMCP } from "fastmcp";

import { IMAGE_FIX } from "../../services/commands.js";
import { THEME_MEDIA_KEYS } from "../../services/image-fix-service.js";
import { registerCommandTool } from "./command-tool.js";

/** @public Backwards-compatible export; the implementation lives in the service. */
export { THEME_MEDIA_KEYS };

export function registerImageFixTools(server: FastMCP): void {
    registerCommandTool(server, IMAGE_FIX);
}
