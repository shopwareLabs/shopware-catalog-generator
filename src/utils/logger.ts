/**
 * File-based logging utility for debugging
 * Writes detailed logs to file, keeps CLI clean
 */

import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
    timestamp: string;
    level: LogLevel;
    message: string;
    data?: unknown;
}

class Logger {
    private logDir: string;
    private logFile: string;
    private enabled: boolean = true;
    private minLevel: LogLevel = "debug";
    private verboseConsole: boolean = false;

    private readonly levelPriority: Record<LogLevel, number> = {
        debug: 0,
        info: 1,
        warn: 2,
        error: 3,
    };

    constructor() {
        this.logDir = path.join(process.cwd(), "logs");
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        this.logFile = path.join(this.logDir, `generator-${timestamp}.log`);
    }

    /**
     * Configure the logger
     */
    configure(options: {
        enabled?: boolean;
        minLevel?: LogLevel;
        verboseConsole?: boolean;
        logDir?: string;
    }): void {
        if (options.enabled !== undefined) this.enabled = options.enabled;
        if (options.minLevel) this.minLevel = options.minLevel;
        if (options.verboseConsole !== undefined) this.verboseConsole = options.verboseConsole;
        if (options.logDir) {
            this.logDir = options.logDir;
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            this.logFile = path.join(this.logDir, `generator-${timestamp}.log`);
        }
    }

    /**
     * Get the current log file path
     */
    getLogFile(): string {
        return this.logFile;
    }

    /**
     * Write a log entry to file
     */
    private writeToFile(entry: LogEntry): void {
        if (!this.enabled) return;

        // Ensure log directory exists
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }

        const levelStr = entry.level.toUpperCase().padEnd(5);
        let line = `[${entry.timestamp}] ${levelStr} ${entry.message}`;

        if (entry.data !== undefined) {
            const dataStr =
                typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data, null, 2);
            line += `\n${dataStr}`;
        }

        fs.appendFileSync(this.logFile, line + "\n");
    }

    /**
     * Check if a log level should be logged
     */
    private shouldLog(level: LogLevel): boolean {
        return this.levelPriority[level] >= this.levelPriority[this.minLevel];
    }

    /**
     * Log a debug message (file only)
     */
    debug(message: string, data?: unknown): void {
        if (!this.shouldLog("debug")) return;

        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: "debug",
            message,
            data,
        };

        this.writeToFile(entry);

        if (this.verboseConsole) {
            console.debug(`[DEBUG] ${message}`);
        }
    }

    /**
     * Log an info message (file only by default)
     */
    info(message: string, data?: unknown): void {
        if (!this.shouldLog("info")) return;

        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: "info",
            message,
            data,
        };

        this.writeToFile(entry);

        if (this.verboseConsole) {
            console.info(`[INFO] ${message}`);
        }
    }

    /**
     * Log a warning (file + console)
     */
    warn(message: string, data?: unknown): void {
        if (!this.shouldLog("warn")) return;

        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: "warn",
            message,
            data,
        };

        this.writeToFile(entry);
        console.warn(`[WARN] ${message}`);
    }

    /**
     * Log an error (file + brief console message)
     */
    error(message: string, data?: unknown): void {
        if (!this.shouldLog("error")) return;

        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: "error",
            message,
            data,
        };

        this.writeToFile(entry);

        // Only show brief message in console, full details in log file
        if (this.verboseConsole && data) {
            console.error(`[ERROR] ${message}`);
            console.error(typeof data === "string" ? data : JSON.stringify(data, null, 2));
        }
    }

    /**
     * Log an HTTP request/response for debugging
     */
    http(
        method: string,
        url: string,
        status: number,
        requestBody?: unknown,
        responseBody?: unknown
    ): void {
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: status >= 400 ? "error" : "debug",
            message: `HTTP ${method} ${url} -> ${status}`,
            data: {
                request: requestBody,
                response: responseBody,
            },
        };

        this.writeToFile(entry);
    }

    /**
     * Log Shopware API error with brief console message, full details in log file
     */
    apiError(endpoint: string, status: number, response: unknown): void {
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: "error",
            message: `[Shopware] API Error: ${endpoint} returned ${status}`,
            data: response,
        };

        this.writeToFile(entry);

        // Brief console message with hint to check log file
        console.error(
            `[Shopware] API Error: ${endpoint} returned ${status} (see log file for details)`
        );
    }

    /**
     * Log AI provider error with brief console message, full details in log file
     */
    aiError(provider: string, operation: string, error: unknown): void {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: "error",
            message: `[AI Provider: ${provider}] ${operation} failed: ${errorMessage}`,
            data: error,
        };

        this.writeToFile(entry);

        // Console message is handled by the provider for helpful tips
    }
}

// Export singleton instance
export const logger = new Logger();
