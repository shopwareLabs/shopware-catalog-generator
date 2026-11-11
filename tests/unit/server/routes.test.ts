import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type { RunGenerate } from "../../../src/services/generate-service.js";

import { ProcessManager } from "../../../src/server/process-manager.js";
import { createRequestHandler, routeRequest } from "../../../src/server/routes.js";

const CONNECTION = {
    envPath: "http://shop.test",
    shopwareUser: "admin",
    shopwarePassword: "shopware",
};

const StatusSchema = z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    progress: z.object({ phase: z.string(), current: z.number(), total: z.number() }),
    startedAt: z.string(),
    completedAt: z.string().optional(),
    logs: z.array(z.string()),
    logCount: z.number(),
    result: z.unknown().optional(),
    error: z.string().optional(),
});

const StartedSchema = z.object({ processId: z.string() });

const noopGenerate: RunGenerate = async () => ({ lines: [] });

function deps(manager: ProcessManager, runGenerate: RunGenerate = noopGenerate) {
    return { runGenerate, processManager: manager, uptime: () => 42 };
}

function request(path: string, method = "GET", body?: unknown): Request {
    return new Request(`http://localhost${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function waitForProcess(manager: ProcessManager, id: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
        const status = manager.get(id)?.status;
        if (status === "completed" || status === "failed") return;
        await Bun.sleep(5);
    }
    throw new Error(`Process ${id} did not finish`);
}

async function finishedProcess(
    manager: ProcessManager,
    task: () => Promise<unknown>
): Promise<string> {
    const id = manager.start("Task", async (ctx) => {
        ctx.log("first");
        ctx.log("second");
        ctx.setProgress("upload", 2, 3);
        return task();
    });
    await waitForProcess(manager, id);
    return id;
}

describe("routeRequest", () => {
    test("returns 401 without the bearer token when SERVER_TOKEN is set", async () => {
        let started = false;
        const runGenerate: RunGenerate = async () => {
            started = true;
            return { lines: [] };
        };
        const guarded = { ...deps(new ProcessManager(), runGenerate), token: "s3cret" };

        const response = await routeRequest(
            request("/generate", "POST", { salesChannel: "music", ...CONNECTION }),
            guarded
        );

        expect(response.status).toBe(401);
        expect(started).toBe(false);
    });

    test("accepts requests with the bearer token", async () => {
        const guarded = { ...deps(new ProcessManager()), token: "s3cret" };
        const response = await routeRequest(
            new Request("http://localhost/health", { headers: { authorization: "Bearer s3cret" } }),
            guarded
        );

        expect(response.status).toBe(200);
    });

    test("GET /health returns process counts and uptime", async () => {
        const manager = new ProcessManager();
        await finishedProcess(manager, async () => "done");

        const response = await routeRequest(request("/health"), deps(manager));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            status: "ok",
            activeProcesses: 0,
            totalProcesses: 1,
            uptime: 42,
        });
    });

    test("GET /health defaults to the process uptime", async () => {
        const manager = new ProcessManager();
        const response = await routeRequest(request("/health"), {
            runGenerate: noopGenerate,
            processManager: manager,
        });

        const body = z.object({ uptime: z.number() }).parse(await response.json());
        expect(body.uptime).toBeGreaterThan(0);
    });

    test("GET /status/:id returns state, logs and the result of a completed process", async () => {
        const manager = new ProcessManager();
        const id = await finishedProcess(manager, async () => ({ products: 3 }));

        const response = await routeRequest(request(`/status/${id}`), deps(manager));
        const body = StatusSchema.parse(await response.json());

        expect(response.status).toBe(200);
        expect(body.id).toBe(id);
        expect(body.name).toBe("Task");
        expect(body.status).toBe("completed");
        expect(body.progress).toEqual({ phase: "upload", current: 2, total: 3 });
        expect(body.result).toEqual({ products: 3 });
        expect(body.error).toBeUndefined();
        expect(body.completedAt).toBeDefined();
        expect(new Date(body.startedAt).getTime()).not.toBeNaN();
        expect(body.logs.length).toBe(body.logCount);
        expect(body.logs.some((l) => l.includes("first"))).toBe(true);
    });

    test("GET /status/:id returns the error of a failed process and no result", async () => {
        const manager = new ProcessManager();
        const id = await finishedProcess(manager, async () => {
            throw new Error("Upload failed");
        });

        const body = StatusSchema.parse(
            await (await routeRequest(request(`/status/${id}`), deps(manager))).json()
        );

        expect(body.status).toBe("failed");
        expect(body.error).toBe("Upload failed");
        expect(body.result).toBeUndefined();
    });

    test("GET /status/:id omits the result while a process is running", async () => {
        const manager = new ProcessManager();
        let finish: () => void = () => {};
        const id = manager.start("Slow", () => new Promise<void>((resolve) => (finish = resolve)));

        const body = StatusSchema.parse(
            await (await routeRequest(request(`/status/${id}`), deps(manager))).json()
        );

        expect(body.status).not.toBe("completed");
        expect(body.result).toBeUndefined();
        expect(body.completedAt).toBeUndefined();
        finish();
        await waitForProcess(manager, id);
    });

    test("GET /status/:id?from=N returns the logs from that offset", async () => {
        const manager = new ProcessManager();
        const id = await finishedProcess(manager, async () => "done");
        const all = manager.getLogs(id);

        const body = StatusSchema.parse(
            await (await routeRequest(request(`/status/${id}?from=1`), deps(manager))).json()
        );

        expect(body.logs).toEqual(all.slice(1));
        expect(body.logCount).toBe(all.length);
    });

    test("GET /status/:id decodes the ID and returns 404 for unknown processes", async () => {
        const response = await routeRequest(
            request("/status/proc%20missing"),
            deps(new ProcessManager())
        );

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'Process "proc missing" not found' });
    });

    test("GET /status/ without an ID is not found", async () => {
        const response = await routeRequest(request("/status/"), deps(new ProcessManager()));

        expect(response.status).toBe(404);
        expect(await response.text()).toBe("Not Found");
    });

    test("POST /generate starts a background generation", async () => {
        const manager = new ProcessManager();
        const names: string[] = [];
        const recording: RunGenerate = async (name) => {
            names.push(name);
            return { lines: [] };
        };

        const response = await routeRequest(
            request("/generate", "POST", { ...CONNECTION, name: "garden" }),
            deps(manager, recording)
        );
        const { processId } = StartedSchema.parse(await response.json());
        await waitForProcess(manager, processId);

        expect(response.status).toBe(200);
        expect(names).toEqual(["garden"]);
    });

    test("returns 404 for unknown paths and wrong methods", async () => {
        const manager = new ProcessManager();
        const cases: Array<[string, string]> = [
            ["/unknown", "GET"],
            ["/generate", "GET"],
            ["/health", "POST"],
            ["/status/proc_1", "DELETE"],
        ];

        const statuses = await Promise.all(
            cases.map(async ([path, method]) => {
                const response = await routeRequest(request(path, method), deps(manager));
                return [response.status, await response.text()];
            })
        );

        expect(statuses).toEqual(cases.map(() => [404, "Not Found"]));
    });
});

describe("createRequestHandler", () => {
    test("returns a fetch handler that routes requests", async () => {
        const handler = createRequestHandler(deps(new ProcessManager()));

        const response = await handler(request("/health"));

        expect(response.status).toBe(200);
    });
});
