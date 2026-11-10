/**
 * Register an MCP tool from a shared command spec (src/services/commands.ts).
 *
 * The CLI runs the same spec, so parameters, defaults and validation cannot drift.
 */

import type { FastMCP } from "fastmcp";
import type { z } from "zod";

import type { CommandSpec, ExecuteCommandOptions } from "../../services/commands.js";

import { executeCommand, objectSchema } from "../../services/commands.js";

/** Run a command the way its MCP tool does (exported for the parity test) */
export async function executeCommandTool<Shape extends z.ZodRawShape>(
    spec: CommandSpec<Shape>,
    args: unknown,
    options: ExecuteCommandOptions = {}
): Promise<string> {
    const lines = await executeCommand(spec, args, options);
    return lines.join("\n");
}

export function registerCommandTool<Shape extends z.ZodRawShape>(
    server: FastMCP,
    spec: CommandSpec<Shape>
): void {
    server.addTool({
        name: spec.tool,
        description: spec.description,
        parameters: objectSchema(spec),
        execute: (args) => executeCommandTool(spec, args),
    });
}
