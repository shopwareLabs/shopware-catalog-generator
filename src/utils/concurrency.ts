/**
 * Concurrency limiter for parallel task execution
 * Uses a semaphore pattern to limit concurrent operations
 */
export class ConcurrencyLimiter {
    private running = 0;
    private queue: Array<() => void> = [];

    /**
     * Create a concurrency limiter
     * @param maxConcurrency - Maximum number of concurrent operations (1 = sequential)
     */
    constructor(private readonly maxConcurrency: number) {
        if (maxConcurrency < 1) {
            throw new Error("maxConcurrency must be at least 1");
        }
    }

    /**
     * Schedule a task to run with concurrency limiting
     * @param fn - Async function to execute
     * @returns Promise that resolves with the function result
     */
    async schedule<T>(fn: () => Promise<T>): Promise<T> {
        // Wait for a slot if we're at capacity
        if (this.running >= this.maxConcurrency) {
            await new Promise<void>((resolve) => {
                this.queue.push(resolve);
            });
        }

        this.running++;

        try {
            return await fn();
        } finally {
            this.running--;
            // Release next waiting task if any
            const next = this.queue.shift();
            if (next) {
                next();
            }
        }
    }

    /**
     * Run multiple tasks with concurrency limiting
     * @param tasks - Array of async functions to execute
     * @returns Promise that resolves with all results in order
     */
    async all<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
        return Promise.all(tasks.map((task) => this.schedule(task)));
    }

    /**
     * Get the current number of running tasks
     */
    get runningCount(): number {
        return this.running;
    }

    /**
     * Get the number of tasks waiting in the queue
     */
    get queueLength(): number {
        return this.queue.length;
    }

    /**
     * Check if running sequentially (maxConcurrency = 1)
     */
    get isSequential(): boolean {
        return this.maxConcurrency === 1;
    }

    /**
     * Get the configured max concurrency
     */
    get limit(): number {
        return this.maxConcurrency;
    }
}
