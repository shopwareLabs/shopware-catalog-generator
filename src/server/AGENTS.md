# Server Module

HTTP server with background process management for long-running generation tasks.

## Overview

The server module provides:

- **Background Processing**: Long-running tasks (generation, hydration) run asynchronously
- **Process Management**: Track status, progress, and logs for each task
- **Status Streaming**: Poll status endpoint to monitor progress
- **Automatic Cleanup**: Completed processes expire after 30 minutes

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     HTTP Server (Bun.serve)                  │
├─────────────────────────────────────────────────────────────┤
│  POST /generate    │  GET /status/:id   │  GET /health      │
│  Start background  │  Poll for status,  │  Check server     │
│  generation task   │  progress, logs    │  uptime           │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                     ProcessManager                           │
├─────────────────────────────────────────────────────────────┤
│  • Spawns async tasks                                        │
│  • Tracks ProcessState (status, progress, logs, result)      │
│  • Provides ProcessContext for task logging                  │
│  • Cleans up expired processes (30 min retention)            │
└─────────────────────────────────────────────────────────────┘
```

## Files

| File                 | Description                          |
| -------------------- | ------------------------------------ |
| `index.ts`           | Exports types and singleton instance |
| `process-manager.ts` | ProcessManager class and types       |

## Usage

### Starting a Background Task

```typescript
import { processManager } from "./server/index.js";

const processId = processManager.start("Generate furniture", async (ctx) => {
    ctx.log("Starting generation...");
    ctx.setProgress("blueprint", 0, 3);

    // Phase 1: Blueprint
    const blueprint = createBlueprint();
    ctx.setProgress("blueprint", 1, 3);

    // Phase 2: Hydration
    ctx.log("Hydrating with AI...");
    const hydrated = await hydrate(blueprint);
    ctx.setProgress("blueprint", 2, 3);

    // Phase 3: Upload
    ctx.log("Uploading to Shopware...");
    await upload(hydrated);
    ctx.setProgress("blueprint", 3, 3);

    return { products: 90, categories: 52 };
});
```

### Checking Status

```typescript
const state = processManager.get(processId);
// {
//   id: "proc_xxx",
//   status: "running" | "completed" | "failed",
//   progress: { phase: "blueprint", current: 2, total: 3 },
//   logs: ["Starting...", "Hydrating..."],
//   result: { products: 90 },  // if completed
//   error: "Auth failed"       // if failed
// }
```

### Getting Logs with Offset

```typescript
// Get logs starting from index 10 (for pagination)
const newLogs = processManager.getLogs(processId, 10);
```

## Types

### ProcessStatus

```typescript
type ProcessStatus = "pending" | "running" | "completed" | "failed";
```

### ProcessProgress

```typescript
interface ProcessProgress {
    phase: string; // e.g., "blueprint", "hydration", "upload", "processors"
    current: number; // Current step
    total: number; // Total steps
}
```

### ProcessState

```typescript
interface ProcessState {
    id: string;
    name: string;
    status: ProcessStatus;
    startedAt: Date;
    completedAt?: Date;
    progress: ProcessProgress;
    logs: string[];
    result?: unknown;
    error?: string;
}
```

### ProcessContext

Passed to task functions for logging and progress updates:

```typescript
interface ProcessContext {
    id: string;
    log: (message: string) => void;
    setProgress: (phase: string, current: number, total: number) => void;
}
```

## Configuration

| Constant       | Value  | Description                      |
| -------------- | ------ | -------------------------------- |
| `MAX_LOGS`     | 1000   | Max log entries per process      |
| `RETENTION_MS` | 30 min | Time to keep completed processes |

## API Endpoints

### POST /generate

Start background generation.

**Request:**

```json
{
    "envPath": "http://localhost:8000",
    "salesChannel": "furniture",
    "description": "Wood furniture store",
    "productCount": 90,
    "shopwareUser": "admin",
    "shopwarePassword": "shopware",
    "skipProcessors": false
}
```

**Response:**

```json
{
    "processId": "proc_1234567890_abc123",
    "message": "Generation started in background",
    "salesChannel": "furniture",
    "statusUrl": "/status/proc_1234567890_abc123"
}
```

### GET /status/:id

Get process status and logs.

**Query params:**

- `from` (optional): Log offset for pagination

**Response:**

```json
{
    "id": "proc_xxx",
    "name": "Generate furniture",
    "status": "running",
    "progress": { "phase": "upload", "current": 2, "total": 4 },
    "startedAt": "2026-01-30T10:00:00.000Z",
    "logs": ["[10:00:01] Authenticating...", "[10:00:02] Success"],
    "logCount": 15
}
```

On completion, includes `result`:

```json
{
    "status": "completed",
    "result": {
        "salesChannelId": "abc123",
        "salesChannelName": "furniture",
        "categories": 52,
        "products": 90,
        "propertyGroups": 4,
        "processors": [
            { "name": "images", "processed": 90, "errors": [] },
            { "name": "reviews", "processed": 70, "errors": [] }
        ]
    }
}
```

### GET /health

Health check.

**Response:**

```json
{
    "status": "ok",
    "activeProcesses": 1,
    "totalProcesses": 3,
    "uptime": 3600.5
}
```

## Best Practices

### Progress Phases

Use consistent phase names across tasks:

- `auth` - Shopware authentication
- `blueprint` - Blueprint creation/loading (current: 0-2)
- `upload` - Shopware sync (current: 0-4 for categories, groups, products)
- `processors` - Post-processor execution (current: 0-N processors)

### Logging

Log significant milestones with timestamps:

```typescript
ctx.log("Hydrating blueprint with AI...");
ctx.log(`Found ${count} existing property groups`);
ctx.log(`Synced ${products.length} products`);
ctx.log("Process completed successfully");
```

### Error Handling

Errors are automatically caught and stored:

```typescript
const processId = processManager.start("Task", async (ctx) => {
    // If this throws, status becomes "failed" with error message
    throw new Error("Authentication failed");
});
```

## Extending

### Adding New Endpoints

1. Add route handler in `src/server.ts`
2. Use `processManager.start()` for long-running operations
3. Return process ID immediately for async polling
4. Update this AGENTS.md with new endpoint docs

### Adding Process Types

For different task types (e.g., cleanup, export):

```typescript
processManager.start("Cleanup furniture", async (ctx) => {
    ctx.setProgress("cleanup", 0, 3);
    // ... cleanup logic
});
```
