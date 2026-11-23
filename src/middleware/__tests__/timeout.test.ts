/**
 * Focused coverage for src/middleware/timeout.ts (`TimeoutOptions`,
 * `timeoutMiddleware`).
 *
 * The middleware arms a `setTimeout` per request and must be deterministic
 * about when it takes over the response and when it stands down:
 *  - it must call `next()` immediately and only respond once the budget elapses
 *  - it must use the configured default when no `timeoutMs` is supplied
 *  - it must never touch a response that already finished/closed/aborted, or
 *    whose headers were already sent
 *  - it must echo the incoming `x-request-id` and log the timeout
 *  - it must mark `res.locals.timedOut`, abort `req.abortSignal`, and ignore
 *    late writes without throwing
 *  - it must echo the validated request id and log the timeout
 *  - it must never echo or log an unvalidated `x-request-id` value
 *
 * The pino-backed logger is replaced so the suite asserts the log call without
 * pulling in the real logging stack.
 */

import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import type { Request, Response, NextFunction } from "express";

jest.unstable_mockModule("../../utils/logger.js", () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

let timeoutMiddleware: typeof import("../timeout.js").timeoutMiddleware;
let timeoutConfig: typeof import("../../config/timeouts.js").timeoutConfig;
let loggerWarn: jest.Mock;
let loggerDebug: jest.Mock;

beforeAll(async () => {
  const mod = await import("../timeout.js");
  const cfg = await import("../../config/timeouts.js");
  const log = await import("../../utils/logger.js");
  timeoutMiddleware = mod.timeoutMiddleware;
  timeoutConfig = cfg.timeoutConfig;
  loggerWarn = log.logger.warn as unknown as jest.Mock;
  loggerDebug = log.logger.debug as unknown as jest.Mock;
});

// ─── Express doubles ─────────────────────────────────────────────────────────

type Emitter = {
  on: (event: string, cb: (...args: unknown[]) => void) => unknown;
  emit: (event: string) => void;
};

function makeReq(
  headers: Record<string, string | string[] | undefined> = {},
  originalUrl = "/api/v1/checkout",
): Request & Emitter {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    headers,
    originalUrl,
    requestId: undefined,
    header: (name: string) => headers[name.toLowerCase()],
    on: (event: string, cb: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(cb);
      return undefined;
    },
    emit: (event: string) => {
      (listeners[event] ?? []).forEach((cb) => cb());
    },
  } as unknown as Request & Emitter;
}

function makeRes() {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const res = {
    locals: {} as Record<string, unknown>,
    headersSent: false,
    writableEnded: false,
    statusCode: 200 as number,
    body: undefined as unknown,
    sendCalls: 0,
    endCalls: 0,
    header: {} as Record<string, unknown>,
    setHeader(key: string, value: unknown) {
      res.header[key] = value;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      if (res.headersSent) {
        const err = new Error("Cannot set headers after they are sent to the client") as Error & { code?: string };
        err.code = "ERR_HTTP_HEADERS_SENT";
        throw err;
      }
      res.body = body;
      res.headersSent = true;
      return res;
    },
    send(body: unknown) {
      if (res.headersSent) {
        const err = new Error("Cannot set headers after they are sent to the client") as Error & { code?: string };
        err.code = "ERR_HTTP_HEADERS_SENT";
        throw err;
      }
      res.sendCalls += 1;
      res.body = body;
      res.headersSent = true;
      return res;
    },
    end() {
      res.endCalls += 1;
      res.writableEnded = true;
      return res;
    },
    on(event: string, cb: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(cb);
      return res;
    },
    emit(event: string) {
      (listeners[event] ?? []).forEach((cb) => cb());
    },
  };
  return res as unknown as Response & typeof res;
}

beforeEach(() => {
  jest.useFakeTimers();
  loggerWarn.mockClear();
  loggerDebug.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── Happy path ──────────────────────────────────────────────────────────────

describe("timeoutMiddleware — request proceeds", () => {
  it("calls next() immediately without responding and attaches abortSignal", () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    timeoutMiddleware({ timeoutMs: 100 })(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.abortSignal).toBeDefined();
    expect(req.abortSignal?.aborted).toBe(false);
    expect(res.locals.timedOut).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeUndefined();
  });

  it("does not respond once the budget elapses after the response finished", () => {
    const req = makeReq();
    const res = makeRes();
    timeoutMiddleware({ timeoutMs: 100 })(req, res, jest.fn() as unknown as NextFunction);

    res.emit("finish");
    jest.advanceTimersByTime(500);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBeUndefined();
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("does not respond after the connection closes", () => {
    const req = makeReq();
    const res = makeRes();
    timeoutMiddleware({ timeoutMs: 100 })(req, res, jest.fn() as unknown as NextFunction);

    res.emit("close");
    jest.advanceTimersByTime(500);

    expect(res.body).toBeUndefined();
  });

  it("does not respond after the request is aborted", () => {
    const req = makeReq();
    const res = makeRes();
    timeoutMiddleware({ timeoutMs: 100 })(req, res, jest.fn() as unknown as NextFunction);

    req.emit("aborted");
    jest.advanceTimersByTime(500);

    expect(res.body).toBeUndefined();
  });
});

// ─── Timeout path ────────────────────────────────────────────────────────────

describe("timeoutMiddleware — timeout", () => {
  it("responds 503 with the error envelope once the budget elapses", () => {
    const req = makeReq({}, "/api/v1/checkout");
    const res = makeRes();
    timeoutMiddleware({ timeoutMs: 100 })(req, res, jest.fn() as unknown as NextFunction);

    jest.advanceTimersByTime(99);
    expect(res.body).toBeUndefined();

    jest.advanceTimersByTime(1);
    expect(res.locals.timedOut).toBe(true);
    expect(req.abortSignal?.aborted).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: "Request timed out. Please try again later.",
    });
  });

  it("handles a handler resolving after timeout with one response, no error, and one debug log", async () => {
    const req = makeReq({ "x-request-id": "req-late-1" }, "/api/v1/bookings");
    const res = makeRes();

    let resolveHandler!: () => void;
    const handlerPromise = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    }).then(() => {
      res.status(200).json({ success: true, bookingId: "bk-1" });
      res.send({ success: true });
      res.end();
    });

    timeoutMiddleware({ timeoutMs: 100 })(req, res, jest.fn() as unknown as NextFunction);

    jest.advanceTimersByTime(100);
    expect(res.statusCode).toBe(503);
    expect(res.locals.timedOut).toBe(true);
    expect(req.abortSignal?.aborted).toBe(true);

    resolveHandler();
    await expect(handlerPromise).resolves.toBeUndefined();

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: "Request timed out. Please try again later.",
    });
    expect(res.sendCalls).toBe(0);
    expect(res.endCalls).toBe(0);
    expect(loggerDebug).toHaveBeenCalledTimes(1);
  });

  it("falls back to the configured default timeout when none is supplied", () => {
    const req = makeReq();
    const res = makeRes();
    timeoutMiddleware()(req, res, jest.fn() as unknown as NextFunction);

    jest.advanceTimersByTime(timeoutConfig.http.defaultMs - 1);
    expect(res.body).toBeUndefined();

    jest.advanceTimersByTime(1);
    expect(res.statusCode).toBe(503);
  });

  it("echoes the incoming x-request-id header", () => {
    const req = makeReq({ "x-request-id": "req-abc-123" });
    const res = makeRes();
    timeoutMiddleware({ timeoutMs: 50 })(req, res, jest.fn() as unknown as NextFunction);

    jest.advanceTimersByTime(50);

    expect(res.header["X-Request-Id"]).toBe("req-abc-123");
  });

  it("generates a request id when the header is absent", () => {
    const req = makeReq();
    const res = makeRes();
    timeoutMiddleware({ timeoutMs: 50 })(req, res, jest.fn() as unknown as NextFunction);

    jest.advanceTimersByTime(50);

    expect(String(res.header["X-Request-Id"])).toMatch(/^req_[0-9a-fA-F-]{36}$/);
  });

  it("prefers the id resolved by requestIdMiddleware", () => {
    const req = makeReq({ "x-request-id": "not a valid id" });
    req.requestId = "req_from_middleware_001";
    const res = makeRes();
    timeoutMiddleware({ timeoutMs: 50 })(req, res, jest.fn() as unknown as NextFunction);

    jest.advanceTimersByTime(50);

    expect(res.header["X-Request-Id"]).toBe("req_from_middleware_001");
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req_from_middleware_001" }),
      "request timed out",
    );
  });

  it("replaces a CRLF-injected header with a generated id in the response and log", () => {
    const req = makeReq({ "x-request-id": "req-abc-123\r\nX-Injected: yes" });
    const res = makeRes();
    timeoutMiddleware({ timeoutMs: 50 })(req, res, jest.fn() as unknown as NextFunction);

    jest.advanceTimersByTime(50);

    const echoed = String(res.header["X-Request-Id"]);
    expect(echoed).toMatch(/^req_[0-9a-fA-F-]{36}$/);
    expect(echoed).not.toContain("\r");
    expect(echoed).not.toContain("\n");
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: echoed }),
      "request timed out",
    );
  });

  it("replaces an oversize header with a generated id", () => {
    const req = makeReq({ "x-request-id": "a".repeat(256) });
    const res = makeRes();
    timeoutMiddleware({ timeoutMs: 50 })(req, res, jest.fn() as unknown as NextFunction);

    jest.advanceTimersByTime(50);

    expect(String(res.header["X-Request-Id"])).toMatch(/^req_[0-9a-fA-F-]{36}$/);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: String(res.header["X-Request-Id"]) }),
      "request timed out",
    );
  });

  it("replaces an array-valued header with a generated id", () => {
    const req = makeReq({ "x-request-id": ["req-abc-123", "req-def-456"] });
    const res = makeRes();
    timeoutMiddleware({ timeoutMs: 50 })(req, res, jest.fn() as unknown as NextFunction);

    jest.advanceTimersByTime(50);

    expect(String(res.header["X-Request-Id"])).toMatch(/^req_[0-9a-fA-F-]{36}$/);
  });

  it("logs a structured warning with requestId, route and duration", () => {
    const req = makeReq({ "x-request-id": "req-log-1" }, "/api/v1/slots");
    const res = makeRes();
    timeoutMiddleware({ timeoutMs: 75 })(req, res, jest.fn() as unknown as NextFunction);

    jest.advanceTimersByTime(75);

    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      { requestId: "req-log-1", route: "/api/v1/slots", durationMs: 75 },
      "request timed out",
    );
  });

  it("does nothing when the response headers were already sent", () => {
    const req = makeReq();
    const res = makeRes();
    res.headersSent = true;
    timeoutMiddleware({ timeoutMs: 50 })(req, res, jest.fn() as unknown as NextFunction);

    jest.advanceTimersByTime(50);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBeUndefined();
    expect(res.header["X-Request-Id"]).toBeUndefined();
    expect(loggerWarn).not.toHaveBeenCalled();
  });
});