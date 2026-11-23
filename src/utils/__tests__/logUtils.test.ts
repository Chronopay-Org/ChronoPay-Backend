/**
 * Unit tests for src/utils/logUtils.ts (#1470)
 *
 * Every logger method used by the helpers is spied on with a no-op
 * implementation, so these tests never write real log output. The single
 * exception is the redaction test, which swaps the pino destination for an
 * in-memory stream to exercise the real sanitize/redact pipeline.
 */

import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

import {
  PerformanceTimer,
  conditionalLog,
  createScopedLogger,
  logApiCall,
  logBatch,
  logDbOperation,
  logExternalCall,
  logSecurityEvent,
  logSlowOperation,
  withPerformanceLogging,
} from "../logUtils.js";
import { logger, type LogLevel } from "../logger.js";

const LEVELS: LogLevel[] = ["info", "warn", "error", "debug", "fatal", "trace"];

type LevelSpies = Partial<Record<LogLevel, jest.SpyInstance>>;

let spies: LevelSpies;

const spyFor = (level: LogLevel): jest.SpyInstance => {
  const spy = spies[level];
  if (!spy) {
    throw new Error(`No spy registered for level ${level}`);
  }
  return spy;
};

const firstCall = (level: LogLevel): [Record<string, unknown>, string] => {
  const call = spyFor(level).mock.calls[0];
  if (!call) {
    throw new Error(`logger.${level} was never called`);
  }
  return call as [Record<string, unknown>, string];
};

beforeEach(() => {
  spies = {};
  for (const level of LEVELS) {
    spies[level] = jest
      .spyOn(logger, level)
      .mockImplementation((() => logger) as never) as jest.SpyInstance;
  }
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe("PerformanceTimer", () => {
  it("end() logs a non-negative numeric duration plus context at info level", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(1_000));

    const timer = new PerformanceTimer("charge", { requestId: "req-1" });
    jest.setSystemTime(new Date(1_123));
    timer.end();

    const [payload, message] = firstCall("info");
    expect(payload).toMatchObject({
      operation: "charge",
      requestId: "req-1",
      duration_ms: 123,
    });
    expect(typeof payload.duration_ms).toBe("number");
    expect(payload.duration_ms as number).toBeGreaterThanOrEqual(0);
    expect(message).toBe("Operation completed in 123ms");
  });

  it("end() accepts a custom completion message", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2_000));

    const timer = new PerformanceTimer("refund");
    jest.setSystemTime(new Date(2_050));
    timer.end("refund finished");

    const [payload, message] = firstCall("info");
    expect(payload.duration_ms).toBe(50);
    expect(message).toBe("refund finished in 50ms");
  });

  it("endWithError() logs duration and error details via logger.error", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(5_000));

    const error = new Error("gateway exploded");
    error.name = "GatewayError";

    const timer = new PerformanceTimer("settle", { intentId: "intent-9" });
    jest.setSystemTime(new Date(5_321));
    timer.endWithError(error);

    const [payload, message] = firstCall("error");
    expect(payload).toMatchObject({
      operation: "settle",
      intentId: "intent-9",
      duration_ms: 321,
      error: {
        name: "GatewayError",
        message: "gateway exploded",
        stack: error.stack,
      },
    });
    expect(message).toBe("Operation failed");
    expect(spyFor("info")).not.toHaveBeenCalled();
  });

  it("endWithError() accepts a custom failure message", () => {
    const timer = new PerformanceTimer("sweep");
    timer.endWithError(new Error("nope"), "sweep failed");

    const [, message] = firstCall("error");
    expect(message).toBe("sweep failed");
  });
});

describe("logApiCall", () => {
  it("logs 2xx responses at info level with the expected payload", () => {
    logApiCall("GET", "/v1/intents", 200, 12, { requestId: "req-200" });

    const [payload, message] = firstCall("info");
    expect(payload).toMatchObject({
      api_call: true,
      method: "GET",
      endpoint: "/v1/intents",
      status_code: 200,
      duration_ms: 12,
      requestId: "req-200",
    });
    expect(message).toBe("API GET /v1/intents [200]");
    expect(spyFor("warn")).not.toHaveBeenCalled();
    expect(spyFor("error")).not.toHaveBeenCalled();
  });

  it("logs 4xx responses at warn level", () => {
    logApiCall("POST", "/v1/intents", 404, 8);

    const [payload, message] = firstCall("warn");
    expect(payload).toMatchObject({
      api_call: true,
      method: "POST",
      endpoint: "/v1/intents",
      status_code: 404,
      duration_ms: 8,
    });
    expect(message).toBe("API POST /v1/intents [404]");
    expect(spyFor("info")).not.toHaveBeenCalled();
    expect(spyFor("error")).not.toHaveBeenCalled();
  });

  it("logs 5xx responses at error level", () => {
    logApiCall("DELETE", "/v1/orders/42", 500, 34);

    const [payload, message] = firstCall("error");
    expect(payload).toMatchObject({
      api_call: true,
      method: "DELETE",
      endpoint: "/v1/orders/42",
      status_code: 500,
      duration_ms: 34,
    });
    expect(message).toBe("API DELETE /v1/orders/42 [500]");
    expect(spyFor("info")).not.toHaveBeenCalled();
    expect(spyFor("warn")).not.toHaveBeenCalled();
  });

  it.each([
    [399, "info"],
    [400, "warn"],
    [499, "warn"],
    [599, "error"],
  ] as const)("maps status %i to logger.%s", (status, level) => {
    logApiCall("GET", "/boundary", status, 1);

    expect(spyFor(level)).toHaveBeenCalledTimes(1);
    for (const other of LEVELS) {
      if (other !== level) {
        expect(spyFor(other)).not.toHaveBeenCalled();
      }
    }
  });
});

describe("logDbOperation", () => {
  it("logs at debug level with row count and context", () => {
    logDbOperation("select", "intents", 4, 3, { requestId: "req-db" });

    const [payload, message] = firstCall("debug");
    expect(payload).toMatchObject({
      db_operation: true,
      operation: "select",
      table: "intents",
      duration_ms: 4,
      row_count: 3,
      requestId: "req-db",
    });
    expect(message).toBe("DB select on intents in 4ms");
    expect(spyFor("info")).not.toHaveBeenCalled();
  });

  it("omits row_count when not supplied", () => {
    logDbOperation("delete", "sessions", 2);

    const [payload] = firstCall("debug");
    expect(payload).toMatchObject({
      db_operation: true,
      operation: "delete",
      table: "sessions",
      duration_ms: 2,
    });
    expect(payload.row_count).toBeUndefined();
  });
});

describe("logExternalCall", () => {
  it("logs successful calls at info level", () => {
    logExternalCall("stellar", "/horizon", true, 55, 200);

    const [payload, message] = firstCall("info");
    expect(payload).toMatchObject({
      external_call: true,
      service_name: "stellar",
      endpoint: "/horizon",
      success: true,
      duration_ms: 55,
      status_code: 200,
    });
    expect(message).toBe("External call to stellar succeeded");
    expect(spyFor("error")).not.toHaveBeenCalled();
  });

  it("logs failed calls at error level with error details", () => {
    const error = new Error("timeout");
    error.name = "TimeoutError";

    logExternalCall("stellar", "/horizon", false, 10_000, 504, error);

    const [payload, message] = firstCall("error");
    expect(payload).toMatchObject({
      external_call: true,
      service_name: "stellar",
      endpoint: "/horizon",
      success: false,
      duration_ms: 10_000,
      status_code: 504,
      error: {
        name: "TimeoutError",
        message: "timeout",
        stack: error.stack,
      },
    });
    expect(message).toBe("External call to stellar failed");
    expect(spyFor("info")).not.toHaveBeenCalled();
  });

  it("logs failed calls without an error object", () => {
    logExternalCall("sendgrid", "/mail", false, 30);

    const [payload] = firstCall("error");
    expect(payload.success).toBe(false);
    expect(payload.error).toBeUndefined();
  });
});

describe("logSecurityEvent", () => {
  it("logs successful events at info level with standard fields", () => {
    logSecurityEvent("login", "user-7", true, { ip: "203.0.113.1" });

    const [payload, message] = firstCall("info");
    expect(payload).toMatchObject({
      security_event: true,
      event_type: "login",
      user_id: "user-7",
      success: true,
      ip: "203.0.113.1",
    });
    expect(typeof payload.timestamp).toBe("string");
    expect(new Date(payload.timestamp as string).toISOString()).toBe(
      payload.timestamp,
    );
    expect(message).toBe("Security event: login");
    expect(spyFor("warn")).not.toHaveBeenCalled();
  });

  it("logs failed events at warn level", () => {
    logSecurityEvent("login", "user-7", false);

    const [payload, message] = firstCall("warn");
    expect(payload).toMatchObject({
      security_event: true,
      event_type: "login",
      user_id: "user-7",
      success: false,
    });
    expect(message).toBe("Security event: login");
    expect(spyFor("info")).not.toHaveBeenCalled();
  });

  it("masks sensitive fields in the real logger output (no plaintext password)", async () => {
    // Use the real logger pipeline for this assertion: the redaction lives in
    // the pino formatters, not in logUtils. Restore the no-op spies first.
    jest.restoreAllMocks();

    const plaintextPassword = "SuperSecretPassword123";
    const plaintextToken = "token-abcdef-123456";

    const output = await captureLoggerOutput(() => {
      logSecurityEvent("login", "user-7", true, {
        password: plaintextPassword,
        token: plaintextToken,
      });
    });

    expect(output).not.toBe("");
    expect(output).not.toContain(plaintextPassword);
    expect(output).not.toContain(plaintextToken);
    expect(output).toContain("Su***23");
    expect(output).toContain("to***56");
    expect(output).toContain("login");
    expect(output).toContain("user-7");
  });
});

describe("logSlowOperation", () => {
  it("logs operations above the threshold with overage metrics", () => {
    logSlowOperation("reconcile", 1_500, 1_000, { requestId: "req-slow" });

    const [payload, message] = firstCall("warn");
    expect(payload).toMatchObject({
      slow_operation: true,
      operation: "reconcile",
      duration_ms: 1_500,
      threshold_ms: 1_000,
      exceeded_by_ms: 500,
      requestId: "req-slow",
    });
    expect(message).toBe(
      "Slow operation detected: reconcile took 1500ms (threshold: 1000ms)",
    );
  });

  it("uses the default 1000ms threshold", () => {
    logSlowOperation("reconcile", 1_001);

    const [payload] = firstCall("warn");
    expect(payload.threshold_ms).toBe(1_000);
    expect(payload.exceeded_by_ms).toBe(1);
  });

  it("does not log when duration equals or is below the threshold", () => {
    logSlowOperation("reconcile", 1_000, 1_000);
    logSlowOperation("reconcile", 999, 1_000);

    expect(spyFor("warn")).not.toHaveBeenCalled();
  });
});

describe("logBatch", () => {
  it("emits every entry at its own level with shared batch metadata", () => {
    logBatch([
      { level: "info", message: "first", context: { intentId: "i-1" } },
      { level: "warn", message: "second" },
      { level: "error", message: "third", context: { code: "E_BATCH" } },
    ]);

    const [infoPayload, infoMessage] = firstCall("info");
    const [warnPayload, warnMessage] = firstCall("warn");
    const [errorPayload, errorMessage] = firstCall("error");

    expect(infoMessage).toBe("first");
    expect(warnMessage).toBe("second");
    expect(errorMessage).toBe("third");

    expect(infoPayload).toMatchObject({
      batch_index: 0,
      batch_size: 3,
      intentId: "i-1",
    });
    expect(warnPayload).toMatchObject({ batch_index: 1, batch_size: 3 });
    expect(errorPayload).toMatchObject({
      batch_index: 2,
      batch_size: 3,
      code: "E_BATCH",
    });

    const batchId = infoPayload.batch_id as string;
    expect(batchId).toMatch(/^batch_\d+_[a-z0-9]+$/);
    expect(warnPayload.batch_id).toBe(batchId);
    expect(errorPayload.batch_id).toBe(batchId);
  });

  it("does not call the logger for an empty batch", () => {
    logBatch([]);

    for (const level of LEVELS) {
      expect(spyFor(level)).not.toHaveBeenCalled();
    }
  });
});

describe("withPerformanceLogging", () => {
  it("returns the wrapped result and logs duration on success", async () => {
    const result = await withPerformanceLogging(
      async () => "done",
      "reserve",
      { requestId: "req-perf" },
    );

    expect(result).toBe("done");
    const [payload, message] = firstCall("info");
    expect(payload).toMatchObject({
      operation: "reserve",
      requestId: "req-perf",
    });
    expect(typeof payload.duration_ms).toBe("number");
    expect(payload.duration_ms as number).toBeGreaterThanOrEqual(0);
    expect(message).toMatch(/^reserve completed successfully in \d+ms$/);
    expect(spyFor("error")).not.toHaveBeenCalled();
  });

  it("rethrows the exact original error and logs it with duration", async () => {
    const original = new Error("boom");
    original.name = "BoomError";

    const operation = withPerformanceLogging(async () => {
      throw original;
    }, "reserve");

    await expect(operation).rejects.toBe(original);

    const [payload, message] = firstCall("error");
    expect(payload).toMatchObject({
      operation: "reserve",
      error: {
        name: "BoomError",
        message: "boom",
        stack: original.stack,
      },
    });
    expect(typeof payload.duration_ms).toBe("number");
    expect(payload.duration_ms as number).toBeGreaterThanOrEqual(0);
    expect(message).toBe("reserve failed");
    expect(spyFor("info")).not.toHaveBeenCalled();
  });
});

describe("conditionalLog", () => {
  it("logs when the level is enabled", () => {
    jest.spyOn(logger, "isLevelEnabled").mockReturnValue(true);

    conditionalLog("info", "conditional message", { requestId: "req-c" });

    const [payload, message] = firstCall("info");
    expect(payload).toEqual({ requestId: "req-c" });
    expect(message).toBe("conditional message");
  });

  it("defaults to an empty context object", () => {
    jest.spyOn(logger, "isLevelEnabled").mockReturnValue(true);

    conditionalLog("warn", "no context");

    const [payload] = firstCall("warn");
    expect(payload).toEqual({});
  });

  it("does not call the logger when the level is disabled", () => {
    jest.spyOn(logger, "isLevelEnabled").mockReturnValue(false);

    conditionalLog("debug", "suppressed");

    for (const level of LEVELS) {
      expect(spyFor(level)).not.toHaveBeenCalled();
    }
  });

  it("checks isLevelEnabled for the requested level", () => {
    const isLevelEnabled = jest
      .spyOn(logger, "isLevelEnabled")
      .mockReturnValue(true);

    conditionalLog("trace", "traced");

    expect(isLevelEnabled).toHaveBeenCalledWith("trace");
  });
});

describe("createScopedLogger", () => {
  it("creates a child logger bound to the module and extra context", () => {
    const child = { __scoped: true };
    const childSpy = jest
      .spyOn(logger, "child")
      .mockReturnValue(child as never);

    const scoped = createScopedLogger("payments", { requestId: "req-scope" });

    expect(childSpy).toHaveBeenCalledWith({
      module: "payments",
      requestId: "req-scope",
    });
    expect(scoped).toBe(child);
  });

  it("omits additional context when none is supplied", () => {
    const childSpy = jest
      .spyOn(logger, "child")
      .mockReturnValue({} as never);

    createScopedLogger("ledger");

    expect(childSpy).toHaveBeenCalledWith({ module: "ledger" });
  });
});

/**
 * Redirects the production logger to an in-memory destination so the real pino
 * sanitize/redact pipeline can be asserted without emitting to stdout.
 */
async function captureLoggerOutput(run: () => void): Promise<string> {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });

  const target = logger as unknown as Record<symbol, unknown>;
  const originalStream = target[pino.symbols.streamSym];
  const originalLevel = logger.level;

  target[pino.symbols.streamSym] = destination;
  logger.level = "trace";

  try {
    run();
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 1_000;
      const poll = () => {
        if (chunks.length > 0 || Date.now() > deadline) {
          resolve();
          return;
        }
        setTimeout(poll, 5);
      };
      poll();
    });
  } finally {
    logger.level = originalLevel;
    target[pino.symbols.streamSym] = originalStream;
  }

  return chunks.join("");
}
