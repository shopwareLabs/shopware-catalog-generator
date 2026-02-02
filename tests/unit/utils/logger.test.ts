import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
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
            verboseConsole: false,
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
});
