import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { AuditLogger } from "../services/auditLogger.js";
import fs from "fs/promises";
import { createAuditEvent } from "../utils/auditEventValidator.js";

describe("AuditLogger", () => {
  let logger: AuditLogger;

  beforeEach(() => {
    logger = new AuditLogger({ filePath: "test.log" });
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should append a formatted JSONL entry and create directories using versioned format", async () => {
    const mkdirSpy = jest.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    const appendSpy = jest.spyOn(fs, "appendFile").mockResolvedValue(undefined as never);

    await logger.log(
      "TEST_ACTION",
      { method: "POST" },
      { actorIp: "127.0.0.1", status: 200 }
    );

    expect(mkdirSpy).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    expect(appendSpy).toHaveBeenCalledWith(
      "test.log",
      expect.stringContaining('"action":"TEST_ACTION"'),
      "utf8"
    );
    expect(appendSpy).toHaveBeenCalledWith(
      "test.log",
      expect.stringContaining('"version":"1.0.0"'),
      "utf8"
    );
  });

  it("should migrate legacy format to versioned format", async () => {
    const mkdirSpy = jest.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    const appendSpy = jest.spyOn(fs, "appendFile").mockResolvedValue(undefined as never);

    await logger.log({
      action: "LEGACY_ACTION",
      actorIp: "127.0.0.1",
      status: 200,
      metadata: { method: "POST", body: { username: "test", password: "secret" } },
    });

    expect(mkdirSpy).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    expect(appendSpy).toHaveBeenCalledWith(
      "test.log",
      expect.stringContaining('"action":"LEGACY_ACTION"'),
      "utf8"
    );
    expect(appendSpy).toHaveBeenCalledWith(
      "test.log",
      expect.stringContaining('"version":"1.0.0"'),
      "utf8"
    );
    // Password should be redacted
    expect(appendSpy).toHaveBeenCalledWith(
      "test.log",
      expect.stringContaining('"***REDACTED***"'),
      "utf8"
    );
  });

  it("should not throw on file system write failure", async () => {
    jest.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    jest.spyOn(fs, "appendFile").mockRejectedValue(new Error("Disk full") as never);

    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      logger.log("TEST_FAIL", {}, { status: 500 })
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith("Failed to write to audit log:", expect.any(Error));
    consoleSpy.mockRestore();
  });

  it("should use custom service and environment options", async () => {
    const customLogger = new AuditLogger({
      filePath: "custom.log",
      service: "custom-service",
      environment: "prod",
    });
    const mkdirSpy = jest.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    const appendSpy = jest.spyOn(fs, "appendFile").mockResolvedValue(undefined as never);

    await customLogger.log("TEST", {}, { status: 200 });

    expect(appendSpy).toHaveBeenCalledWith(
      "custom.log",
      expect.stringContaining('"service":"custom-service"'),
      "utf8"
    );
    expect(appendSpy).toHaveBeenCalledWith(
      "custom.log",
      expect.stringContaining('"environment":"prod"'),
      "utf8"
    );
  });

  it("should handle mkdir failure gracefully", async () => {
    jest.spyOn(fs, "mkdir").mockRejectedValue(new Error("Permission denied") as never);
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      logger.log("TEST", {}, { status: 200 })
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith("Failed to write to audit log:", expect.any(Error));
    consoleSpy.mockRestore();
  });

  it("should use default service and environment when not provided", async () => {
    const defaultLogger = new AuditLogger();
    const mkdirSpy = jest.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    const appendSpy = jest.spyOn(fs, "appendFile").mockResolvedValue(undefined as never);

    await defaultLogger.log("TEST", {}, { status: 200 });

    expect(appendSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"service":"chronopay-backend"'),
      "utf8"
    );
    expect(appendSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"environment":"dev"'),
      "utf8"
    );
  });

  it("should handle legacy entry without metadata", async () => {
    const mkdirSpy = jest.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    const appendSpy = jest.spyOn(fs, "appendFile").mockResolvedValue(undefined as never);

    await logger.log({
      action: "LEGACY_ACTION",
      status: 200,
    });

    expect(appendSpy).toHaveBeenCalledWith(
      "test.log",
      expect.stringContaining('"action":"LEGACY_ACTION"'),
      "utf8"
    );
    expect(appendSpy).toHaveBeenCalledWith(
      "test.log",
      expect.stringContaining('"version":"1.0.0"'),
      "utf8"
    );
  });

  it("should handle undefined data parameter", async () => {
    const mkdirSpy = jest.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    const appendSpy = jest.spyOn(fs, "appendFile").mockResolvedValue(undefined as never);

    await logger.log("TEST_ACTION", undefined as any, { status: 200 });

    expect(appendSpy).toHaveBeenCalledWith(
      "test.log",
      expect.stringContaining('"action":"TEST_ACTION"'),
      "utf8"
    );
  });

  it("should handle null data parameter", async () => {
    const mkdirSpy = jest.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    const appendSpy = jest.spyOn(fs, "appendFile").mockResolvedValue(undefined as never);

    await logger.log("TEST_ACTION", null as any, { status: 200 });

    expect(appendSpy).toHaveBeenCalledWith(
      "test.log",
      expect.stringContaining('"action":"TEST_ACTION"'),
      "utf8"
    );
  });
});
