/**
 * File-based logging utility with MCP-safe console output
 *
 * ## MCP Mode
 *
 * When running as an MCP server, console output is suppressed to avoid
 * corrupting the stdio JSON-RPC transport. Call `logger.setMcpMode(true)`
 * at the start of the MCP server. All methods still write to log file.
 *
 * ## Logging Methods
 *
 * `logger.debug(message, options?)` - Verbose debugging info
 * `logger.info(message, options?)` - Informational events
 * `logger.warn(message, options?)` - Warnings (recoverable issues)
 * `logger.error(message, options?)` - Errors (operation failures)
 *
 * Pass `{ cli: true }` in options to also output to console (suppressed in MCP mode).
 * Pass `{ data: ... }` to attach diagnostic data to the log file entry.
 *
 * ### Special methods
 *
 * `logger.apiError(endpoint, status, response)` - Shopware API errors (file + console)
 * `logger.aiError(provider, operation, error)` - AI provider errors (file only)
 * `logger.http(method, url, status, req?, res?)` - HTTP request logging (file only)
 */

import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Options for log methods */
export interface LogOptions {
    /** Diagnostic data to attach to the log file entry */
    data?: unknown;
    /** Also output message to console (suppressed in MCP mode) */
    cli?: boolean;
}

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
    private mcpMode: boolean = false;
    private cleanupDone: boolean = false;

    private readonly levelPriority: Record<LogLevel, number> = {
        debug: 0,
        info: 1,
        warn: 2,
        error: 3,
    };

    constructor() {
        this.logDir = path.join(process.cwd(), "logs");
        this.logFile = path.join(this.logDir, `generator-${this.formatTimestamp()}.log`);
    }

    /**
     * Format current timestamp for log filename (e.g., "2024-01-15T10-30-00")
     */
    private formatTimestamp(): string {
        return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    }

    /**
     * Configure the logger
     */
    configure(options: { enabled?: boolean; minLevel?: LogLevel; logDir?: string }): void {
        if (options.enabled !== undefined) this.enabled = options.enabled;
        if (options.minLevel) this.minLevel = options.minLevel;
        if (options.logDir) {
            this.logDir = options.logDir;
            this.logFile = path.join(this.logDir, `generator-${this.formatTimestamp()}.log`);
        }
    }

    /**
     * Enable MCP mode - suppresses ALL console output to avoid corrupting stdio transport.
     * Call this at the start of MCP server.
     */
    setMcpMode(enabled: boolean): void {
        this.mcpMode = enabled;
    }

    /**
     * Check if MCP mode is enabled
     */
    isMcpMode(): boolean {
        return this.mcpMode;
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

        // Auto-cleanup old logs on first write (keeps last 10)
        if (!this.cleanupDone) {
            this.cleanupDone = true;
            try {
                this.cleanup(10);
            } catch {
                // Ignore cleanup errors
            }
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
     * Output a message to console based on level (suppressed in MCP mode)
     */
    private writeToConsole(level: LogLevel, message: string): void {
        if (this.mcpMode) return;

        switch (level) {
            case "error":
                console.error(message);
                break;
            case "warn":
                console.warn(message);
                break;
            default:
                console.log(message);
        }
    }

    /**
     * Check if a log level should be logged
     */
    private shouldLog(level: LogLevel): boolean {
        return this.levelPriority[level] >= this.levelPriority[this.minLevel];
    }

    /**
     * Core log method used by all level methods
     */
    private log(level: LogLevel, message: string, options?: LogOptions): void {
        if (!this.shouldLog(level)) return;

        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            data: options?.data,
        };

        this.writeToFile(entry);

        if (options?.cli) {
            this.writeToConsole(level, message);
        }
    }

    /**
     * Log a debug message
     */
    debug(message: string, options?: LogOptions): void {
        this.log("debug", message, options);
    }

    /**
     * Log an info message
     */
    info(message: string, options?: LogOptions): void {
        this.log("info", message, options);
    }

    /**
     * Log a warning
     */
    warn(message: string, options?: LogOptions): void {
        this.log("warn", message, options);
    }

    /**
     * Log an error
     */
    error(message: string, options?: LogOptions): void {
        this.log("error", message, options);
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

        // Brief console message with hint to check log file (not in MCP mode)
        this.writeToConsole(
            "error",
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

    /**
     * Clean up old log files, keeping only the most recent ones.
     * @param keepCount - Number of log files to keep (default: 10)
     * @returns Number of deleted files
     */
    cleanup(keepCount: number = 10): number {
        if (!fs.existsSync(this.logDir)) {
            return 0;
        }

        const logFiles = fs
            .readdirSync(this.logDir)
            .filter((f) => f.startsWith("generator-") && f.endsWith(".log"))
            .map((f) => ({
                name: f,
                path: path.join(this.logDir, f),
                mtime: fs.statSync(path.join(this.logDir, f)).mtime.getTime(),
            }))
            .sort((a, b) => b.mtime - a.mtime); // newest first

        if (logFiles.length <= keepCount) {
            return 0;
        }

        const toDelete = logFiles.slice(keepCount);
        for (const file of toDelete) {
            fs.unlinkSync(file.path);
        }

        return toDelete.length;
    }

    /**
     * Get the log directory path
     */
    getLogDir(): string {
        return this.logDir;
    }
}

// Export singleton instance
export const logger = new Logger();
