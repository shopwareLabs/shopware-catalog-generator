import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { logger } from "../../../src/utils/logger.js";

describe("Logger", () => {
    const testLogDir = path.join(process.cwd(), "test-logs");

    beforeEach(() => {
        // Configure logger to use test directory
        logger.configure({
            enabled: true,
            logDir: testLogDir,
            minLevel: "debug",
        });
    });

    afterEach(() => {
        // Clean up test log directory
        if (fs.existsSync(testLogDir)) {
            fs.rmSync(testLogDir, { recursive: true });
        }
    });

    describe("configure", () => {
        test("creates log directory when enabled", () => {
            logger.debug("test message");
            expect(fs.existsSync(testLogDir)).toBe(true);
        });

        test("getLogFile returns valid path", () => {
            const logFile = logger.getLogFile();
            expect(logFile).toContain("generator-");
            expect(logFile).toContain(".log");
        });
    });

    describe("debug", () => {
        test("writes debug message to file", () => {
            logger.debug("debug test message");

            const logFile = logger.getLogFile();
            const content = fs.readFileSync(logFile, "utf-8");

            expect(content).toContain("DEBUG");
            expect(content).toContain("debug test message");
        });

        test("includes data in log when provided", () => {
            logger.debug("message with data", { foo: "bar" });

            const logFile = logger.getLogFile();
            const content = fs.readFileSync(logFile, "utf-8");

            expect(content).toContain('"foo": "bar"');
        });
    });

    describe("info", () => {
        test("writes info message to file", () => {
            logger.info("info test message");

            const logFile = logger.getLogFile();
            const content = fs.readFileSync(logFile, "utf-8");

            expect(content).toContain("INFO");
            expect(content).toContain("info test message");
        });
    });

    describe("warn", () => {
        test("writes warn message to file", () => {
            // Mock console.warn to prevent output during test
            const originalWarn = console.warn;
            console.warn = mock(() => {});

            logger.warn("warn test message");

            const logFile = logger.getLogFile();
            const content = fs.readFileSync(logFile, "utf-8");

            expect(content).toContain("WARN");
            expect(content).toContain("warn test message");

            console.warn = originalWarn;
        });
    });

    describe("error", () => {
        test("writes error message to file", () => {
            logger.error("error test message");

            const logFile = logger.getLogFile();
            const content = fs.readFileSync(logFile, "utf-8");

            expect(content).toContain("ERROR");
            expect(content).toContain("error test message");
        });

        test("includes error data in file", () => {
            logger.error("error with data", { code: 500, details: "Something failed" });

            const logFile = logger.getLogFile();
            const content = fs.readFileSync(logFile, "utf-8");

            expect(content).toContain('"code": 500');
            expect(content).toContain("Something failed");
        });
    });

    describe("apiError", () => {
        test("writes Shopware API error to file with prefix", () => {
            // Mock console.error
            const originalError = console.error;
            console.error = mock(() => {});

            logger.apiError("_action/sync", 400, { message: "Bad request" });

            const logFile = logger.getLogFile();
            const content = fs.readFileSync(logFile, "utf-8");

            expect(content).toContain("[Shopware]");
            expect(content).toContain("API Error");
            expect(content).toContain("_action/sync");
            expect(content).toContain("400");

            console.error = originalError;
        });
    });

    describe("aiError", () => {
        test("writes AI provider error to file with prefix", () => {
            logger.aiError("pollinations", "text generation", new Error("API key invalid"));

            const logFile = logger.getLogFile();
            const content = fs.readFileSync(logFile, "utf-8");

            expect(content).toContain("[AI Provider: pollinations]");
            expect(content).toContain("text generation failed");
            expect(content).toContain("API key invalid");
        });

        test("handles string errors", () => {
            logger.aiError("openai", "image generation", "Rate limit exceeded");

            const logFile = logger.getLogFile();
            const content = fs.readFileSync(logFile, "utf-8");

            expect(content).toContain("[AI Provider: openai]");
            expect(content).toContain("Rate limit exceeded");
        });
    });

    describe("http", () => {
        test("logs successful HTTP request as debug", () => {
            logger.http("POST", "/api/products", 200, { id: "123" }, { success: true });

            const logFile = logger.getLogFile();
            const content = fs.readFileSync(logFile, "utf-8");

            expect(content).toContain("HTTP POST /api/products -> 200");
            expect(content).toContain("DEBUG");
        });

        test("logs failed HTTP request as error", () => {
            logger.http("POST", "/api/products", 500, { id: "123" }, { error: "Server error" });

            const logFile = logger.getLogFile();
            const content = fs.readFileSync(logFile, "utf-8");

            expect(content).toContain("HTTP POST /api/products -> 500");
            expect(content).toContain("ERROR");
        });
    });

    describe("minLevel filtering", () => {
        test("respects minLevel setting", () => {
            logger.configure({ minLevel: "warn" });

            logger.debug("should not appear");
            logger.info("should not appear");
            logger.warn("should appear");

            const logFile = logger.getLogFile();
            const content = fs.readFileSync(logFile, "utf-8");

            expect(content).not.toContain("should not appear");
            expect(content).toContain("should appear");
        });
    });

    describe("disabled logger", () => {
        test("does not write when disabled", () => {
            logger.configure({ enabled: false });

            logger.debug("test");
            logger.info("test");
            logger.error("test");

            // Log file should not exist since nothing was written
            const logFile = logger.getLogFile();
            expect(fs.existsSync(logFile)).toBe(false);
        });
    });

    describe("MCP mode", () => {
        afterEach(() => {
            // Reset MCP mode after each test
            logger.setMcpMode(false);
        });

        test("isMcpMode returns false by default", () => {
            expect(logger.isMcpMode()).toBe(false);
        });

        test("setMcpMode enables MCP mode", () => {
            logger.setMcpMode(true);
            expect(logger.isMcpMode()).toBe(true);
        });

        test("setMcpMode can disable MCP mode", () => {
            logger.setMcpMode(true);
            logger.setMcpMode(false);
            expect(logger.isMcpMode()).toBe(false);
        });
    });

    describe("cli", () => {
        afterEach(() => {
            logger.setMcpMode(false);
        });

        test("writes to log file with default info level", () => {
            const originalLog = console.log;
            console.log = mock(() => {});

            logger.cli("cli test message");

            const logFile = logger.getLogFile();
            const content = fs.readFileSync(logFile, "utf-8");

            expect(content).toContain("INFO");
            expect(content).toContain("cli test message");

            console.log = originalLog;
        });

        test("writes to log file with warn level", () => {
            const originalWarn = console.warn;
            console.warn = mock(() => {});

            logger.cli("cli warning", "warn");

            const logFile = logger.getLogFile();
            const content = fs.readFileSync(logFile, "utf-8");

            expect(content).toContain("WARN");
            expect(content).toContain("cli warning");

            console.warn = originalWarn;
        });

        test("writes to log file with error level", () => {
            const originalError = console.error;
            console.error = mock(() => {});

            logger.cli("cli error", "error");

            const logFile = logger.getLogFile();
            const content = fs.readFileSync(logFile, "utf-8");

            expect(content).toContain("ERROR");
            expect(content).toContain("cli error");

            console.error = originalError;
        });

        test("outputs to console.log for info level", () => {
            const mockLog = mock(() => {});
            const originalLog = console.log;
            console.log = mockLog;

            logger.cli("info message");

            expect(mockLog).toHaveBeenCalledWith("info message");

            console.log = originalLog;
        });

        test("outputs to console.warn for warn level", () => {
            const mockWarn = mock(() => {});
            const originalWarn = console.warn;
            console.warn = mockWarn;

            logger.cli("warn message", "warn");

            expect(mockWarn).toHaveBeenCalledWith("warn message");

            console.warn = originalWarn;
        });

        test("outputs to console.error for error level", () => {
            const mockError = mock(() => {});
            const originalError = console.error;
            console.error = mockError;

            logger.cli("error message", "error");

            expect(mockError).toHaveBeenCalledWith("error message");

            console.error = originalError;
        });

        test("suppresses console output in MCP mode", () => {
            const mockLog = mock(() => {});
            const originalLog = console.log;
            console.log = mockLog;

            logger.setMcpMode(true);
            logger.cli("mcp message");

            // Should NOT output to console
            expect(mockLog).not.toHaveBeenCalled();

            // Should still write to file
            const logFile = logger.getLogFile();
            const content = fs.readFileSync(logFile, "utf-8");
            expect(content).toContain("mcp message");

            console.log = originalLog;
        });

        test("includes data in log file", () => {
            const originalLog = console.log;
            console.log = mock(() => {});

            logger.cli("message with data", "info", { key: "value" });

            const logFile = logger.getLogFile();
            const content = fs.readFileSync(logFile, "utf-8");

            expect(content).toContain('"key": "value"');

            console.log = originalLog;
        });
    });

    describe("cleanup", () => {
        test("returns 0 when log directory does not exist", () => {
            // Use a non-existent directory
            const nonExistentDir = path.join(process.cwd(), "non-existent-logs");
            logger.configure({ logDir: nonExistentDir });

            const deleted = logger.cleanup(10);
            expect(deleted).toBe(0);
        });

        test("returns 0 when fewer files than keepCount", () => {
            // Create 3 log files
            fs.mkdirSync(testLogDir, { recursive: true });
            fs.writeFileSync(path.join(testLogDir, "generator-2024-01-01T10-00-00.log"), "log1");
            fs.writeFileSync(path.join(testLogDir, "generator-2024-01-02T10-00-00.log"), "log2");
            fs.writeFileSync(path.join(testLogDir, "generator-2024-01-03T10-00-00.log"), "log3");

            const deleted = logger.cleanup(5);
            expect(deleted).toBe(0);

            // All files should still exist
            expect(fs.readdirSync(testLogDir).length).toBe(3);
        });

        test("deletes oldest files when exceeding keepCount", () => {
            // Create 5 log files with different modification times
            fs.mkdirSync(testLogDir, { recursive: true });

            const files = [
                "generator-2024-01-01T10-00-00.log",
                "generator-2024-01-02T10-00-00.log",
                "generator-2024-01-03T10-00-00.log",
                "generator-2024-01-04T10-00-00.log",
                "generator-2024-01-05T10-00-00.log",
            ];

            // Create files with staggered mtimes
            for (let i = 0; i < files.length; i++) {
                const fileName = files[i];
                if (!fileName) continue;
                const filePath = path.join(testLogDir, fileName);
                fs.writeFileSync(filePath, `log${i + 1}`);
                // Set mtime to be increasingly recent
                const mtime = new Date(Date.now() - (files.length - i) * 1000);
                fs.utimesSync(filePath, mtime, mtime);
            }

            const deleted = logger.cleanup(2);
            expect(deleted).toBe(3);

            // Only 2 newest files should remain
            const remaining = fs.readdirSync(testLogDir);
            expect(remaining.length).toBe(2);
            expect(remaining).toContain("generator-2024-01-05T10-00-00.log");
            expect(remaining).toContain("generator-2024-01-04T10-00-00.log");
        });

        test("ignores non-log files", () => {
            fs.mkdirSync(testLogDir, { recursive: true });

            // Create log files and other files
            fs.writeFileSync(path.join(testLogDir, "generator-2024-01-01T10-00-00.log"), "log1");
            fs.writeFileSync(path.join(testLogDir, "generator-2024-01-02T10-00-00.log"), "log2");
            fs.writeFileSync(path.join(testLogDir, "other-file.txt"), "other");
            fs.writeFileSync(path.join(testLogDir, "readme.md"), "readme");

            const deleted = logger.cleanup(1);
            expect(deleted).toBe(1);

            // Non-log files should still exist
            const remaining = fs.readdirSync(testLogDir);
            expect(remaining).toContain("other-file.txt");
            expect(remaining).toContain("readme.md");
        });
    });
});
