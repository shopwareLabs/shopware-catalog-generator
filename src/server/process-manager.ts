/**
 * Process Manager for Background Task Execution
 *
 * Manages background processes for the HTTP server, tracking status,
 * progress, and logs for each running task.
 */

// =============================================================================
// Types
// =============================================================================

/** Process status */
export type ProcessStatus = "pending" | "running" | "completed" | "failed";

/** Progress information */
export interface ProcessProgress {
    /** Current phase (e.g., "blueprint", "hydration", "upload") */
    phase: string;
    /** Current step within phase */
    current: number;
    /** Total steps in phase */
    total: number;
}

/** Process state stored in the manager */
export interface ProcessState {
    /** Unique process ID */
    id: string;
    /** Process name/description */
    name: string;
    /** Current status */
    status: ProcessStatus;
    /** When process started */
    startedAt: Date;
    /** When process completed (if finished) */
    completedAt?: Date;
    /** Progress information */
    progress: ProcessProgress;
    /** Log messages */
    logs: string[];
    /** Result data (on success) */
    result?: unknown;
    /** Error message (on failure) */
    error?: string;
}

/** Task function type */
export type ProcessTask = (context: ProcessContext) => Promise<unknown>;

/** Context passed to task functions */
export interface ProcessContext {
    /** Process ID */
    id: string;
    /** Log a message */
    log: (message: string) => void;
    /** Update progress */
    setProgress: (phase: string, current: number, total: number) => void;
}

// =============================================================================
// ProcessManager Class
// =============================================================================

/**
 * Manages background processes for the HTTP server.
 *
 * Features:
 * - Start async tasks in background
 * - Track progress and status
 * - Collect logs for streaming
 * - Retrieve results after completion
 */
export class ProcessManager {
    private processes: Map<string, ProcessState> = new Map();

    /** Maximum number of logs to keep per process */
    private static readonly MAX_LOGS = 1000;

    /** How long to keep completed processes (ms) */
    private static readonly RETENTION_MS = 30 * 60 * 1000; // 30 minutes

    /**
     * Generate a unique process ID
     */
    generateId(): string {
        return `proc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    /**
     * Start a new background process
     *
     * @param name - Display name for the process
     * @param task - Async function to execute
     * @returns Process ID
     */
    start(name: string, task: ProcessTask): string {
        const id = this.generateId();

        const state: ProcessState = {
            id,
            name,
            status: "pending",
            startedAt: new Date(),
            progress: { phase: "initializing", current: 0, total: 0 },
            logs: [],
        };

        this.processes.set(id, state);

        // Create context for the task
        const context: ProcessContext = {
            id,
            log: (message: string) => this.log(id, message),
            setProgress: (phase: string, current: number, total: number) =>
                this.setProgress(id, phase, current, total),
        };

        // Run task in background
        this.runTask(id, task, context);

        // Schedule cleanup of old processes
        this.scheduleCleanup();

        return id;
    }

    /**
     * Get process state by ID
     */
    get(id: string): ProcessState | undefined {
        return this.processes.get(id);
    }

    /**
     * Get all active (running) processes
     */
    getActive(): ProcessState[] {
        return Array.from(this.processes.values()).filter(
            (p) => p.status === "pending" || p.status === "running"
        );
    }

    /**
     * Get logs for a process, optionally from a specific index
     */
    getLogs(id: string, fromIndex = 0): string[] {
        const state = this.processes.get(id);
        if (!state) return [];
        return state.logs.slice(fromIndex);
    }

    /**
     * Check if a process exists
     */
    has(id: string): boolean {
        return this.processes.has(id);
    }

    /**
     * Log a message to a process
     */
    private log(id: string, message: string): void {
        const state = this.processes.get(id);
        if (!state) return;

        const timestamp = new Date().toISOString().slice(11, 19);
        const logEntry = `[${timestamp}] ${message}`;

        state.logs.push(logEntry);

        // Trim logs if too long
        if (state.logs.length > ProcessManager.MAX_LOGS) {
            state.logs = state.logs.slice(-ProcessManager.MAX_LOGS);
        }
    }

    /**
     * Update progress for a process
     */
    private setProgress(id: string, phase: string, current: number, total: number): void {
        const state = this.processes.get(id);
        if (!state) return;

        state.progress = { phase, current, total };
    }

    /**
     * Run the task and update state accordingly
     */
    private async runTask(id: string, task: ProcessTask, context: ProcessContext): Promise<void> {
        const state = this.processes.get(id);
        if (!state) return;

        state.status = "running";
        this.log(id, `Starting process: ${state.name}`);

        try {
            const result = await task(context);
            state.status = "completed";
            state.completedAt = new Date();
            state.result = result;
            this.log(id, `Process completed successfully`);
        } catch (error) {
            state.status = "failed";
            state.completedAt = new Date();
            state.error = error instanceof Error ? error.message : String(error);
            this.log(id, `Process failed: ${state.error}`);
        }
    }

    /**
     * Clean up old completed processes
     */
    private scheduleCleanup(): void {
        // Run cleanup after retention period
        setTimeout(() => {
            const now = Date.now();
            for (const [id, state] of this.processes) {
                if (state.completedAt) {
                    const age = now - state.completedAt.getTime();
                    if (age > ProcessManager.RETENTION_MS) {
                        this.processes.delete(id);
                    }
                }
            }
        }, ProcessManager.RETENTION_MS);
    }

    /**
     * Get summary statistics
     */
    getStats(): { total: number; active: number; completed: number; failed: number } {
        let active = 0;
        let completed = 0;
        let failed = 0;

        for (const state of this.processes.values()) {
            if (state.status === "pending" || state.status === "running") {
                active++;
            } else if (state.status === "completed") {
                completed++;
            } else if (state.status === "failed") {
                failed++;
            }
        }

        return { total: this.processes.size, active, completed, failed };
    }
}

// Singleton instance for the server
export const processManager = new ProcessManager();
