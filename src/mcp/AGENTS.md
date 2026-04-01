# MCP Server Documentation

Internal documentation for AI agents working on the MCP server module.

## Overview

The MCP (Model Context Protocol) server exposes all CLI commands as typed tools for Cursor AI integration. This enables auto-discovery of available commands without grepping the codebase.

## Module Structure

```
mcp/
├── index.ts              # Server entry point (FastMCP, stdio transport)
└── tools/                # Tool definitions by category
    ├── index.ts          # Re-exports all registration functions
    ├── blueprint.ts      # blueprint_create, blueprint_hydrate, blueprint_fix
    ├── generate.ts       # generate, process
    ├── image-fix.ts      # image_fix
    ├── cache.ts          # cache_list, cache_clear, cache_trash, cache_restore, cache_empty_trash
    └── cleanup.ts        # cleanup, cleanup_media, cleanup_unused_props
```

## Available Tools

| Tool                   | CLI Equivalent                  |
| ---------------------- | ------------------------------- |
| `generate`             | `bun run generate --name=...`   |
| `process`              | `bun run process --name=...`    |
| `blueprint_create`     | `bun run blueprint create ...`  |
| `blueprint_hydrate`    | `bun run blueprint hydrate ...` |
| `blueprint_fix`        | `bun run blueprint fix ...`     |
| `image_fix`            | `bun run image fix ...`         |
| `cleanup`              | `bun run cleanup -- ...`        |
| `cleanup_media`        | `bun run cleanup:media`         |
| `cleanup_unused_props` | `bun run cleanup:props`         |
| `cache_list`           | `bun run cache:list`            |
| `cache_clear`          | `bun run cache:clear`           |
| `cache_trash`          | `bun run cache:trash`           |
| `cache_restore`        | `bun run cache:restore`         |
| `cache_empty_trash`    | `bun run cache:empty-trash`     |
| `list_saleschannels`   | (lookup only)                   |
| `list_processors`      | (lookup only)                   |

## Architecture: Shared Services Layer

MCP tools and CLI handlers are **thin wrappers** around `src/services/`. All application logic lives in the service layer, which returns `string[]` for output. This ensures CLI and MCP tools always stay in sync:

```
src/services/blueprint-service.ts    ← shared logic
       ↑                       ↑
src/cli/blueprint.ts       src/mcp/tools/blueprint.ts
(prints string[] lines)    (joins string[] lines, returns text)
```

## Adding a New Tool

1. Implement the logic in `src/services/<category>-service.ts` (returns `string[]`)
2. Create or update the tool file in `src/mcp/tools/`
3. Use Zod schemas matching the CLI parameters
4. Import and call the service function — do NOT duplicate logic
5. Register via `server.addTool()` in the registration function
6. Export the registration function from `src/mcp/tools/index.ts`
7. Call it in `src/mcp/index.ts` if it's a new category

```typescript
// src/services/my-service.ts
export async function doSomething(args: MyArgs): Promise<string[]> {
    const output: string[] = [];
    output.push(`✓ Done with ${args.name}`);
    return output;
}

// src/mcp/tools/my-tools.ts
export function registerMyTools(server: FastMCP): void {
    server.addTool({
        name: "my_tool",
        description: "Description for AI discovery",
        parameters: z.object({
            name: z.string().describe("SalesChannel name"),
        }),
        execute: async (args) => {
            const lines = await doSomething(args);
            return lines.join("\n");
        },
    });
}
```

## Restarting the MCP Server

Cursor does **not** auto-restart MCP servers. After code changes to any `src/mcp/` file (or modules they import like singletons), you must manually restart:

1. Open Cursor Settings (`Cmd+,`)
2. Go to the MCP section
3. Click the restart button on `catalog-generator`

⚠ Without a restart, the server continues running **old code in memory**.

## Important: MCP Mode

The MCP server sets `logger.setMcpMode(true)` to suppress `console.*` output. All stdout must be reserved for the MCP protocol (JSON-RPC over stdio). Use `logger.info("msg")` (without `cli: true`) for diagnostics.

## Testing

```bash
bun run mcp:dev       # Interactive terminal testing (mcp-cli)
bun run mcp:inspect   # Web UI inspector (FastMCP)
```
