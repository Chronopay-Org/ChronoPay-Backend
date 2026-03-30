import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { AuditLogger } from "../services/auditLogger.js";
import fs from "fs/promises";

describe("AuditLogger", () => {
  let logger: AuditLogger;

  beforeEach(() => {
    logger = new AuditLogger("test.log");
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should append a formatted JSONL entry and create directories", async () => {
    const mkdirSpy = jest.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    const appendSpy = jest.spyOn(fs, "appendFile").mockResolvedValue(undefined as never);

    await logger.log({
      action: "TEST_ACTION",
      actorIp: "127.0.0.1",
      status: 200,
    });

    expect(mkdirSpy).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    expect(appendSpy).toHaveBeenCalledWith(
      "test.log",
      expect.stringContaining('"action":"TEST_ACTION"'),
      "utf8"
    );
  });

  it("should not throw on file system write failure", async () => {
    jest.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    jest.spyOn(fs, "appendFile").mockRejectedValue(new Error("Disk full") as never);

    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      logger.log({ action: "TEST_FAIL", status: 500 })
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith("Failed to write to audit log:", expect.any(Error));
    consoleSpy.mockRestore();
  });
});
