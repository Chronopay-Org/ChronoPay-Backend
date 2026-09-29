/**
 * Focused behavior coverage for `src/middleware/errorHandler.ts`.
 *
 * Exercises the public surface of the module:
 *   - `ErrorHandlerOptions` (logError / includeStackTrace / unknownErrorMessage)
 *   - `createErrorHandler` (defaults, overrides, captured-at-creation state)
 *   - `asyncErrorHandler` (resolution / rejection / synchronous-throw states)
 *   - `notFoundHandler` / `notFoundMiddleware` / `errorHandler` siblings
 *   - representative invalid inputs (non-Error throws, duck-typed errors,
 *     stack-less errors, empty request ids, custom status codes)
 *
 * No production code is modified: the assertions below pin the contract that
 * already ships, including the boundaries where the handler is intentionally
 * (or historically) permissive.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, jest } from "@jest/globals";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import request from "supertest";
import {
  asyncErrorHandler,
  createErrorHandler,
  errorHandler,
  notFoundHandler,
  notFoundMiddleware,
  type ErrorHandlerOptions,
} from "../errorHandler.js";
import {
  AppError,
  BadRequestError,
  ConflictError,
  DatabaseError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "../../errors/AppError.js";
import { ERROR_CODES } from "../../errors/errorCodes.js";
import { logger } from "../../utils/logger.js";
import { requestIdMiddleware } from "../requestId.js";

// ─── Test doubles ─────────────────────────────────────────────────────────────

interface EnvelopeBody {
  success: boolean;
  code?: string;
  message?: string;
  error?: string;
  timestamp?: string;
  requestId?: string;
  details?: unknown;
  stack?: string;
}

interface RecordedResponse extends Response {
  statusCode: number;
  body: EnvelopeBody | undefined;
  calls: string[];
}

function makeRes(order: string[] = []): RecordedResponse {
  const res = {
    statusCode: 200,
    body: undefined as EnvelopeBody | undefined,
    calls: [] as string[],
    status(code: number) {
      order.push(`status:${code}`);
      this.calls.push(`status:${code}`);
      this.statusCode = code;
      return this;
    },
    json(payload: EnvelopeBody) {
      order.push("json");
      this.calls.push("json");
      this.body = payload;
      return this;
    },
  };
  return res as unknown as RecordedResponse;
}

function makeReq(
  overrides: Partial<{
    requestId: string;
    id: string;
    method: string;
    url: string;
    originalUrl: string;
  }> = {},
): Request {
  return {
    method: "GET",
    url: "/api/v1/widgets",
    originalUrl: "/api/v1/widgets",
    ...overrides,
  } as unknown as Request;
}

const makeNext = () =>
  jest.fn() as unknown as NextFunction & jest.Mock<(...args: unknown[]) => unknown>;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Keys the unknown-error envelope must never carry. */
const UNKNOWN_ENVELOPE_ABSENT_KEYS = Object.freeze(["message", "details", "requestId", "stack"]);

function restoreNodeEnv(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }
}

// ─── Default logger spy ───────────────────────────────────────────────────────
// `defaultLogError` writes through the shared pino logger. The logger itself is
// left intact; only `error` is observed so the assertions can assert on the
// structured record without emitting test noise.

let loggerCalls: unknown[][] = [];
let loggerErrorSpy: { mockRestore: () => void };

beforeEach(() => {
  loggerCalls = [];
  loggerErrorSpy = jest.spyOn(logger, "error").mockImplementation(((...args: unknown[]) => {
    loggerCalls.push(args);
    return logger;
  }) as never) as unknown as { mockRestore: () => void };
});

afterAll(() => {
  loggerErrorSpy.mockRestore();
});

// ═════════════════════════════════════════════════════════════════════════════
// ErrorHandlerOptions
// ═════════════════════════════════════════════════════════════════════════════

describe("ErrorHandlerOptions", () => {
  it("exposes exactly the three documented, individually optional keys", () => {
    const empty: ErrorHandlerOptions = {};
    const full: ErrorHandlerOptions = {
      logError: () => {},
      includeStackTrace: true,
      unknownErrorMessage: "Something went wrong",
    };

    expect(empty).toEqual({});
    expect(Object.keys(full).sort()).toEqual([
      "includeStackTrace",
      "logError",
      "unknownErrorMessage",
    ]);
  });

  it("accepts an empty option bag and falls back to every default", () => {
    const handler = createErrorHandler({});
    const next = makeNext();
    const res = makeRes();
    const err = new Error("boom");

    handler(err, makeReq(), res, next);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      success: false,
      code: ERROR_CODES.INTERNAL_ERROR.code,
      error: "An unexpected error occurred",
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      ...(process.env.NODE_ENV !== "production" ? { stack: err.stack } : {}),
    });
    expect(loggerCalls).toHaveLength(1);
  });

  it("uses the supplied logError instead of the default logger", () => {
    const err = new NotFoundError("Booking not found");
    const req = makeReq({ requestId: "req_log" });
    const seen: Array<[unknown, Request]> = [];
    const handler = createErrorHandler({
      logError: (error, request_) => {
        seen.push([error, request_]);
      },
    });

    handler(err, req, makeRes(), makeNext());

    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe(err);
    expect(seen[0][1]).toBe(req);
    expect(loggerCalls).toHaveLength(0);
  });

  it("honours includeStackTrace: true for unknown errors", () => {
    const err = new Error("kaboom");
    const res = makeRes();

    createErrorHandler({ includeStackTrace: true })(err, makeReq(), res, makeNext());

    expect(res.body?.stack).toBe(err.stack);
    expect(res.body?.error).toBe("An unexpected error occurred");
  });

  it("honours includeStackTrace: false for unknown errors", () => {
    const res = makeRes();

    createErrorHandler({ includeStackTrace: false })(
      new Error("kaboom"),
      makeReq(),
      res,
      makeNext(),
    );

    expect(res.body).not.toHaveProperty("stack");
    expect(res.body?.error).toBe("An unexpected error occurred");
  });

  it("honours a custom unknownErrorMessage without leaking the original message", () => {
    const res = makeRes();

    createErrorHandler({
      unknownErrorMessage: "Something went wrong",
      includeStackTrace: false,
    })(new Error("postgres://user:hunter2@db.internal:5432/chronopay"), makeReq(), res, makeNext());

    expect(res.body?.error).toBe("Something went wrong");
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
    expect(JSON.stringify(res.body)).not.toContain("chronopay");
  });

  it("treats explicitly undefined overrides as absent", () => {
    const res = makeRes();

    createErrorHandler({
      logError: undefined,
      includeStackTrace: undefined,
      unknownErrorMessage: undefined,
    })(new Error("kaboom"), makeReq(), res, makeNext());

    expect(res.body?.error).toBe("An unexpected error occurred");
    // undefined logError => the default pino-backed logger is used.
    expect(loggerCalls).toHaveLength(1);
    const [context, message] = loggerCalls[0];
    expect(message).toBe("request error");
    expect(context).toMatchObject({ statusCode: 500, requestId: "unknown" });
    if (process.env.NODE_ENV !== "production") {
      expect(res.body).toHaveProperty("stack");
    } else {
      expect(res.body).not.toHaveProperty("stack");
    }
  });

  it("allows partial option bags to be combined without cross-talk", () => {
    const quiet = makeRes();
    const verbose = makeRes();

    createErrorHandler({ includeStackTrace: false })(new Error("a"), makeReq(), quiet, makeNext());
    createErrorHandler({ includeStackTrace: true })(new Error("b"), makeReq(), verbose, makeNext());

    expect(quiet.body).not.toHaveProperty("stack");
    expect(verbose.body?.stack).toContain("Error: b");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// createErrorHandler — shape, defaults and captured configuration state
// ═════════════════════════════════════════════════════════════════════════════

describe("createErrorHandler", () => {
  it("returns a 4-arity Express error middleware", () => {
    const handler = createErrorHandler();
    expect(typeof handler).toBe("function");
    // Express only treats a middleware as an error handler when arity === 4.
    expect(handler).toHaveLength(4);
  });

  it("exports a pre-built errorHandler singleton with the same shape", () => {
    const res = makeRes();
    const next = makeNext();

    errorHandler(new BadRequestError("bad field"), makeReq(), res, next);

    expect(errorHandler).toHaveLength(4);
    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns undefined and never delegates to next after writing the response", () => {
    const next = makeNext();
    const res = makeRes();

    const returned = createErrorHandler({ logError: () => {} })(
      new AppError("nope", 409, "CONFLICT", true),
      makeReq(),
      res,
      next,
    );

    expect(returned).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
    expect(res.calls).toEqual(["status:409", "json"]);
  });

  it("writes the status code before the JSON body", () => {
    const order: string[] = [];
    const res = makeRes(order);

    createErrorHandler({ logError: () => {} })(
      new ValidationError("Validation failed", { fields: ["email"] }),
      makeReq(),
      res,
      makeNext(),
    );

    expect(order).toEqual(["status:422", "json"]);
  });

  it("logs the request before the response is written", () => {
    const order: string[] = [];
    const res = makeRes(order);

    createErrorHandler({
      logError: () => {
        order.push("log");
      },
    })(new Error("boom"), makeReq(), res, makeNext());

    expect(order).toEqual(["log", "status:500", "json"]);
  });

  it("captures the option bag at creation time", () => {
    const options: ErrorHandlerOptions = { unknownErrorMessage: "frozen message" };
    const handler = createErrorHandler(options);
    options.unknownErrorMessage = "mutated after creation";

    const res = makeRes();
    handler(new Error("boom"), makeReq(), res, makeNext());

    expect(res.body?.error).toBe("frozen message");
  });

  it("captures NODE_ENV at creation time rather than per request", () => {
    const original = process.env.NODE_ENV;
    const handler = createErrorHandler();
    const err = new Error("boom");

    process.env.NODE_ENV = original === "production" ? "development" : "production";
    try {
      const res = makeRes();
      handler(err, makeReq(), res, makeNext());

      if (original === "production") {
        // Created while production => stack suppressed, and stays suppressed.
        expect(res.body).not.toHaveProperty("stack");
      } else {
        // Created outside production => stack stays included after the flip.
        expect(res.body?.stack).toBe(err.stack);
      }
    } finally {
      restoreNodeEnv(original);
    }
  });

  it("keeps instances independent of one another", () => {
    const first = makeRes();
    const second = makeRes();

    createErrorHandler({ unknownErrorMessage: "first" })(
      new Error("a"),
      makeReq(),
      first,
      makeNext(),
    );
    createErrorHandler()(new Error("b"), makeReq(), second, makeNext());

    expect(first.body?.error).toBe("first");
    expect(second.body?.error).toBe("An unexpected error occurred");
  });

  it("can be reused across requests without leaking per-request state", async () => {
    const logged: Error[] = [];
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/ok", (_req, res) => {
      res.status(200).json({ success: true });
    });
    app.get("/boom", () => {
      throw new ConflictError("Slot already booked");
    });
    app.get(
      "/bad",
      asyncErrorHandler(async () => {
        throw new DatabaseError("connection pool exhausted");
      }),
    );
    app.use(
      createErrorHandler({
        logError: (error) => {
          logged.push(error);
        },
      }),
    );

    const ok = await request(app).get("/ok").set("x-request-id", "req_reuse_ok_0001").expect(200);
    const conflict = await request(app)
      .get("/boom")
      .set("x-request-id", "req_reuse_conflict_1")
      .expect(409);
    const dbError = await request(app)
      .get("/bad")
      .set("x-request-id", "req_reuse_dberror_01")
      .expect(500);

    expect(ok.body).toEqual({ success: true });
    expect(conflict.body).toMatchObject({
      code: ERROR_CODES.CONFLICT.code,
      requestId: "req_reuse_conflict_1",
    });
    expect(conflict.body).not.toHaveProperty("stack");
    expect(dbError.body).toMatchObject({
      code: ERROR_CODES.DB_ERROR.code,
      requestId: "req_reuse_dberror_01",
    });
    // Each request carries its own correlation id; nothing is cached on the handler.
    expect(
      new Set([ok.headers["x-request-id"], conflict.body.requestId, dbError.body.requestId]).size,
    ).toBe(3);
    expect(logged.map((error) => error.message)).toEqual([
      "Slot already booked",
      "connection pool exhausted",
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Primary state transitions: thrown value -> HTTP status + canonical envelope
// ═════════════════════════════════════════════════════════════════════════════

describe("createErrorHandler — AppError transitions", () => {
  const cases: Array<[string, AppError, number, string]> = [
    ["BadRequestError", new BadRequestError("bad field"), 400, ERROR_CODES.BAD_REQUEST.code],
    [
      "ValidationError",
      new ValidationError("Validation failed"),
      422,
      ERROR_CODES.VALIDATION_ERROR.code,
    ],
    ["NotFoundError", new NotFoundError("Booking not found"), 404, ERROR_CODES.NOT_FOUND.code],
    ["ConflictError", new ConflictError("Slot already booked"), 409, ERROR_CODES.CONFLICT.code],
    [
      "ServiceUnavailableError",
      new ServiceUnavailableError("Upstream timeout"),
      503,
      ERROR_CODES.SERVICE_UNAVAILABLE.code,
    ],
    [
      "DatabaseError (non-operational)",
      new DatabaseError("connection pool exhausted"),
      500,
      ERROR_CODES.DB_ERROR.code,
    ],
  ];

  it.each(cases)("maps %s onto its taxonomy status and code", (_name, err, status, code) => {
    const res = makeRes();

    createErrorHandler({ logError: () => {} })(err, makeReq(), res, makeNext());

    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual({
      success: false,
      code,
      message: err.message,
      error: err.message,
      timestamp: err.timestamp,
    });
    expect(res.body?.success).toBe(false);
  });

  it("uses the error's own construction timestamp, not the response time", () => {
    const err = new AppError("stale", 400, ERROR_CODES.BAD_REQUEST.code, true);
    const res = makeRes();

    createErrorHandler({ logError: () => {} })(err, makeReq(), res, makeNext());

    expect(res.body?.timestamp).toBe(err.timestamp);
    expect(Date.parse(res.body?.timestamp ?? "")).toBeLessThanOrEqual(Date.now());
  });

  it("forwards structured details verbatim", () => {
    const details = { fields: ["email", "amount"], nested: { code: "currency" } };
    const res = makeRes();

    createErrorHandler({ logError: () => {} })(
      new ValidationError("Validation failed", details),
      makeReq(),
      res,
      makeNext(),
    );

    expect(res.body?.details).toEqual(details);
  });

  it("never leaks a stack trace for AppError even when asked to", () => {
    const err = new AppError("teapot", 418, "I_AM_A_TEAPOT", true);
    const res = makeRes();

    createErrorHandler({ logError: () => {}, includeStackTrace: true })(
      err,
      makeReq(),
      res,
      makeNext(),
    );

    expect(res.body).not.toHaveProperty("stack");
    expect(res.statusCode).toBe(418);
    expect(res.body?.code).toBe("I_AM_A_TEAPOT");
  });

  it("passes a non-standard status code through without clamping", () => {
    const res = makeRes();

    createErrorHandler({ logError: () => {} })(
      new AppError("uncommon", 599, "WEIRD_STATUS", true),
      makeReq(),
      res,
      makeNext(),
    );

    expect(res.statusCode).toBe(599);
    expect(res.body?.code).toBe("WEIRD_STATUS");
  });

  it("derives the logged status code from the error", () => {
    const res = makeRes();

    createErrorHandler()(new NotFoundError("Booking not found"), makeReq(), res, makeNext());

    expect(loggerCalls).toHaveLength(1);
    const [context, message] = loggerCalls[0];
    expect(message).toBe("request error");
    expect(context).toMatchObject({
      statusCode: 404,
      method: "GET",
      url: "/api/v1/widgets",
    });
  });
});

describe("createErrorHandler — unknown error transitions", () => {
  it("emits the canonical 500 envelope for a plain Error", () => {
    const err = new Error("kaboom");
    const res = makeRes();

    createErrorHandler({ includeStackTrace: false })(err, makeReq(), res, makeNext());

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      success: false,
      code: ERROR_CODES.INTERNAL_ERROR.code,
      error: "An unexpected error occurred",
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
    for (const key of UNKNOWN_ENVELOPE_ABSENT_KEYS) {
      expect(res.body).not.toHaveProperty(key);
    }
  });

  it("logs the unknown error at level error with a 500 status", () => {
    const err = new Error("kaboom");

    createErrorHandler()(err, makeReq({ requestId: "req_unknown" }), makeRes(), makeNext());

    expect(loggerCalls).toEqual([
      [
        { err, requestId: "req_unknown", method: "GET", url: "/api/v1/widgets", statusCode: 500 },
        "request error",
      ],
    ]);
  });

  it("includes the stack only for unknown errors and only when enabled", () => {
    const err = new Error("kaboom");
    const withStack = makeRes();
    const withoutStack = makeRes();

    createErrorHandler({ includeStackTrace: true })(err, makeReq(), withStack, makeNext());
    createErrorHandler({ includeStackTrace: false })(err, makeReq(), withoutStack, makeNext());

    expect(withStack.body?.stack).toBe(err.stack);
    expect(withoutStack.body).not.toHaveProperty("stack");
  });

  it("omits the stack when the thrown error carries none", () => {
    const err = new Error("stackless");
    Object.defineProperty(err, "stack", { value: undefined, configurable: true });
    const res = makeRes();

    createErrorHandler({ includeStackTrace: true })(err, makeReq(), res, makeNext());

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toHaveProperty("stack");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Request-id resolution
// ═════════════════════════════════════════════════════════════════════════════

describe("createErrorHandler — request id resolution", () => {
  it("prefers req.requestId over req.id", () => {
    const res = makeRes();

    createErrorHandler({ logError: () => {} })(
      new BadRequestError("bad field"),
      makeReq({ requestId: "req_primary", id: "secondary" }),
      res,
      makeNext(),
    );

    expect(res.body?.requestId).toBe("req_primary");
  });

  it("falls back to req.id when req.requestId is absent", () => {
    const res = makeRes();

    createErrorHandler({ logError: () => {} })(
      new BadRequestError("bad field"),
      makeReq({ id: "req_secondary" }),
      res,
      makeNext(),
    );

    expect(res.body?.requestId).toBe("req_secondary");
  });

  it("preserves an empty-string request id instead of substituting req.id", () => {
    const res = makeRes();

    createErrorHandler({ logError: () => {} })(
      new BadRequestError("bad field"),
      makeReq({ requestId: "", id: "req_secondary" }),
      res,
      makeNext(),
    );

    expect(res.body?.requestId).toBe("");
  });

  it("omits the requestId key when neither source is present", () => {
    const res = makeRes();

    createErrorHandler({ logError: () => {} })(
      new BadRequestError("bad field"),
      makeReq(),
      res,
      makeNext(),
    );

    expect(res.body).not.toHaveProperty("requestId");
  });

  it("falls back to the literal 'unknown' request id in the log record only", () => {
    const res = makeRes();

    createErrorHandler()(new Error("kaboom"), makeReq(), res, makeNext());

    expect(res.body).not.toHaveProperty("requestId");
    expect(loggerCalls[0][0]).toMatchObject({ requestId: "unknown" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Invalid / boundary inputs
// ═════════════════════════════════════════════════════════════════════════════

describe("createErrorHandler — invalid and boundary inputs", () => {
  it("treats a thrown string as an unknown error", () => {
    const logged: unknown[] = [];
    const res = makeRes();

    createErrorHandler({
      includeStackTrace: false,
      logError: (error) => {
        logged.push(error);
      },
    })("kaboom" as unknown as Error, makeReq(), res, makeNext());

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      success: false,
      code: ERROR_CODES.INTERNAL_ERROR.code,
      error: "An unexpected error occurred",
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
    expect(logged).toEqual(["kaboom"]);
  });

  it("treats a duck-typed status/code object as an unknown error", () => {
    const notAnError = { statusCode: 400, code: "BAD_REQUEST", isOperational: true };
    const res = makeRes();

    createErrorHandler({ includeStackTrace: false })(
      notAnError as unknown as Error,
      makeReq(),
      res,
      makeNext(),
    );

    // isAppError() requires `instanceof Error`, so the shape alone is not enough.
    expect(res.statusCode).toBe(500);
    expect(res.body?.code).toBe(ERROR_CODES.INTERNAL_ERROR.code);
  });

  it("treats an Error that only partially matches the AppError shape as unknown", () => {
    const partial = Object.assign(new Error("partial"), { statusCode: 400, code: "BAD_REQUEST" });
    const res = makeRes();

    createErrorHandler({ includeStackTrace: false })(partial, makeReq(), res, makeNext());

    expect(res.statusCode).toBe(500);
    expect(res.body?.code).toBe(ERROR_CODES.INTERNAL_ERROR.code);
  });

  it("serialises a duck-typed AppError that provides toJSON", () => {
    const timestamp = "2024-01-02T03:04:05.678Z";
    const duck = Object.assign(new Error("duck"), {
      statusCode: 418,
      code: "I_AM_A_TEAPOT",
      isOperational: true,
      toJSON: () => ({
        success: false as const,
        code: "I_AM_A_TEAPOT",
        message: "duck",
        error: "duck",
        timestamp,
      }),
    });
    const res = makeRes();

    createErrorHandler({ logError: () => {} })(duck, makeReq(), res, makeNext());

    expect(res.statusCode).toBe(418);
    expect(res.body).toEqual({
      success: false,
      code: "I_AM_A_TEAPOT",
      message: "duck",
      error: "duck",
      timestamp,
    });
  });

  it("propagates a TypeError when a duck-typed AppError omits toJSON", () => {
    const duck = Object.assign(new Error("duck"), {
      statusCode: 418,
      code: "I_AM_A_TEAPOT",
      isOperational: true,
    });
    const res = makeRes();

    expect(() =>
      createErrorHandler({ logError: () => {} })(duck, makeReq(), res, makeNext()),
    ).toThrow(TypeError);
    // Nothing is written to the wire when serialisation fails.
    expect(res.calls).toEqual([]);
  });

  it("handles a thrown null when stack exposure is disabled", () => {
    const res = makeRes();

    createErrorHandler({ includeStackTrace: false, logError: () => {} })(
      null as unknown as Error,
      makeReq(),
      res,
      makeNext(),
    );

    expect(res.statusCode).toBe(500);
    expect(res.body?.code).toBe(ERROR_CODES.INTERNAL_ERROR.code);
  });

  it("logs before failing when a non-Error value is thrown with stack exposure enabled", () => {
    const order: string[] = [];
    const res = makeRes(order);

    expect(() =>
      createErrorHandler({
        logError: () => {
          order.push("log");
        },
      })(null as unknown as Error, makeReq(), res, makeNext()),
    ).toThrow(TypeError);

    // Documented boundary: err.stack is dereferenced on non-Error throws, so
    // the response is never written and the failure is left to Express.
    expect(order).toEqual(["log"]);
    expect(res.calls).toEqual([]);
    expect(res.body).toBeUndefined();
  });

  it("does not swallow a throwing logError and leaves the response unwritten", () => {
    const res = makeRes();

    expect(() =>
      createErrorHandler({
        logError: () => {
          throw new Error("log sink unavailable");
        },
      })(new Error("kaboom"), makeReq(), res, makeNext()),
    ).toThrow("log sink unavailable");

    expect(res.calls).toEqual([]);
    expect(res.body).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// asyncErrorHandler
// ═════════════════════════════════════════════════════════════════════════════

describe("asyncErrorHandler", () => {
  it("returns a new 3-arity Express request handler", () => {
    const fn = jest.fn() as unknown as RequestHandler;
    const wrapped = asyncErrorHandler(fn);

    expect(wrapped).not.toBe(fn);
    expect(typeof wrapped).toBe("function");
    // Arity 3 keeps Express from treating the wrapper as an error handler.
    expect(wrapped).toHaveLength(3);
  });

  it("forwards req, res and next to the wrapped handler", async () => {
    const calls: unknown[][] = [];
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();
    const wrapped = asyncErrorHandler(((...args: unknown[]) => {
      calls.push(args);
    }) as unknown as RequestHandler);

    wrapped(req, res, next);
    await flush();

    expect(calls).toEqual([[req, res, next]]);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not call next when the wrapped handler resolves", async () => {
    const next = makeNext();
    const wrapped = asyncErrorHandler(async () => "resolved");

    wrapped(makeReq(), makeRes(), next);
    await flush();

    expect(next).not.toHaveBeenCalled();
  });

  it("supports synchronous handlers that return a non-promise value", async () => {
    const next = makeNext();
    const wrapped = asyncErrorHandler((() => undefined) as unknown as RequestHandler);

    wrapped(makeReq(), makeRes(), next);
    await flush();

    expect(next).not.toHaveBeenCalled();
  });

  it("forwards a rejected promise to next exactly once", async () => {
    const next = makeNext();
    const err = new NotFoundError("Booking not found");
    const wrapped = asyncErrorHandler(async () => {
      throw err;
    });

    wrapped(makeReq(), makeRes(), next);
    await flush();

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(err);
  });

  it("forwards the rejection asynchronously, never synchronously", () => {
    const next = makeNext();
    const wrapped = asyncErrorHandler(async () => {
      throw new BadRequestError("bad field");
    });

    wrapped(makeReq(), makeRes(), next);

    expect(next).not.toHaveBeenCalled();
  });

  it("forwards non-Error rejection values unchanged", async () => {
    const next = makeNext();
    const wrapped = asyncErrorHandler(async () => {
      throw "string failure";
    });

    wrapped(makeReq(), makeRes(), next);
    await flush();

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith("string failure");
  });

  it("forwards rejections raised by foreign thenables", async () => {
    const next = makeNext();
    const err = new Error("thenable failure");
    const thenable = {
      then(_onFulfilled: unknown, onRejected: (reason: unknown) => void) {
        onRejected(err);
      },
    };
    const wrapped = asyncErrorHandler((() => thenable) as unknown as RequestHandler);

    wrapped(makeReq(), makeRes(), next);
    await flush();

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(err);
  });

  it("leaves a synchronous throw to Express instead of routing it through next", () => {
    const next = makeNext();
    const wrapped = asyncErrorHandler((() => {
      throw new Error("sync failure");
    }) as unknown as RequestHandler);

    // Documented boundary: `fn(...)` is evaluated before Promise.resolve, so a
    // synchronous throw escapes the wrapper and is handled by the Express layer.
    expect(() => wrapped(makeReq(), makeRes(), next)).toThrow("sync failure");
    expect(next).not.toHaveBeenCalled();
  });

  it("preserves next calls issued by the wrapped handler itself", async () => {
    const next = makeNext();
    const wrapped = asyncErrorHandler(((...args: unknown[]) => {
      (args[2] as NextFunction)();
    }) as unknown as RequestHandler);

    wrapped(makeReq(), makeRes(), next);
    await flush();

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it("keeps repeated invocations independent", async () => {
    const next = makeNext();
    const wrapped = asyncErrorHandler(async () => {
      throw new ConflictError("Slot already booked");
    });

    wrapped(makeReq(), makeRes(), next);
    wrapped(makeReq(), makeRes(), next);
    await flush();

    expect(next).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenNthCalledWith(1, expect.objectContaining({ statusCode: 409 }));
    expect(next).toHaveBeenNthCalledWith(2, expect.objectContaining({ statusCode: 409 }));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// notFoundHandler / notFoundMiddleware
// ═════════════════════════════════════════════════════════════════════════════

describe("notFoundHandler", () => {
  it("is also exported as notFoundMiddleware", () => {
    expect(notFoundMiddleware).toBe(notFoundHandler);
  });

  it("delegates a 404 AppError to next instead of writing the response", () => {
    const next = makeNext();
    const res = makeRes();

    notFoundHandler(makeReq({ method: "GET", originalUrl: "/api/v1/missing?page=2" }), res, next);

    expect(res.calls).toEqual([]);
    expect(next).toHaveBeenCalledTimes(1);

    const err = (next as unknown as jest.Mock<(...args: unknown[]) => unknown>).mock
      .calls[0][0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(ERROR_CODES.NOT_FOUND.status);
    expect(err.code).toBe(ERROR_CODES.NOT_FOUND.code);
    expect(err.isOperational).toBe(true);
    expect(err.message).toBe("Route GET /api/v1/missing?page=2 not found");
    expect(err.details).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Express integration: unmatched route -> 404 -> canonical envelope
// ═════════════════════════════════════════════════════════════════════════════

function createHarness(options: ErrorHandlerOptions = {}): express.Express {
  const app = express();
  app.use(requestIdMiddleware);
  app.get("/ok", (_req, res) => {
    res.status(200).json({ success: true });
  });
  app.get(
    "/async-app-error",
    asyncErrorHandler(async () => {
      throw new NotFoundError("Booking not found");
    }),
  );
  app.get(
    "/async-unknown-error",
    asyncErrorHandler(async () => {
      throw new Error("postgres://chronopay:hunter2@db.internal:5432/chronopay");
    }),
  );
  app.get("/sync-app-error", () => {
    throw new ValidationError("Validation failed", { fields: ["amount"] });
  });
  app.use(notFoundMiddleware);
  app.use(createErrorHandler({ includeStackTrace: false, ...options }));
  return app;
}

describe("errorHandler + notFoundMiddleware over Express", () => {
  it("leaves successful responses untouched", async () => {
    const res = await request(createHarness()).get("/ok").expect(200);
    expect(res.body).toEqual({ success: true });
  });

  it("turns an unmatched route into a NOT_FOUND envelope carrying the request id", async () => {
    const res = await request(createHarness())
      .get("/api/v1/missing?page=2")
      .set("x-request-id", "req_integration_0001")
      .expect(404);

    expect(res.body).toEqual({
      success: false,
      code: ERROR_CODES.NOT_FOUND.code,
      message: "Route GET /api/v1/missing?page=2 not found",
      error: "Route GET /api/v1/missing?page=2 not found",
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      requestId: "req_integration_0001",
    });
    expect(res.headers["x-request-id"]).toBe("req_integration_0001");
  });

  it("forwards a rejected async handler into the error middleware", async () => {
    const res = await request(createHarness())
      .get("/async-app-error")
      .set("x-request-id", "req_integration_0002")
      .expect(404);

    expect(res.body).toMatchObject({
      success: false,
      code: ERROR_CODES.NOT_FOUND.code,
      error: "Booking not found",
      requestId: "req_integration_0002",
    });
    expect(res.body).not.toHaveProperty("stack");
  });

  it("forwards a synchronous throw into the error middleware", async () => {
    const res = await request(createHarness()).get("/sync-app-error").expect(422);

    expect(res.body).toMatchObject({
      success: false,
      code: ERROR_CODES.VALIDATION_ERROR.code,
      error: "Validation failed",
      details: { fields: ["amount"] },
    });
  });

  it("never leaks unknown error internals to the client", async () => {
    const res = await request(createHarness()).get("/async-unknown-error").expect(500);

    expect(res.body).toEqual({
      success: false,
      code: ERROR_CODES.INTERNAL_ERROR.code,
      error: "An unexpected error occurred",
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      requestId: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
    expect(res.body).not.toHaveProperty("stack");
  });

  it("includes a stack for unknown errors only when the caller opts in", async () => {
    const res = await request(createHarness({ includeStackTrace: true }))
      .get("/async-unknown-error")
      .expect(500);

    expect(res.body?.stack).toContain("Error:");
    expect(res.body?.error).toBe("An unexpected error occurred");
  });

  it("serves a generated request id when the client supplies none", async () => {
    const res = await request(createHarness()).get("/async-app-error").expect(404);

    expect(res.body?.requestId).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(res.headers["x-request-id"]).toBe(res.body?.requestId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Frozen-clock determinism
// ═════════════════════════════════════════════════════════════════════════════

describe("createErrorHandler — deterministic timestamps", () => {
  const FIXED = new Date("2024-01-02T03:04:05.678Z");
  const NOT_DATE = [
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "setImmediate",
    "clearImmediate",
    "nextTick",
    "queueMicrotask",
    "hrtime",
    "performance",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "requestIdleCallback",
    "cancelIdleCallback",
  ];

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: NOT_DATE });
    jest.setSystemTime(FIXED);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("stamps unknown errors with the frozen clock", () => {
    const res = makeRes();

    createErrorHandler({ includeStackTrace: false, logError: () => {} })(
      new Error("kaboom"),
      makeReq(),
      res,
      makeNext(),
    );

    expect(res.body).toEqual({
      success: false,
      code: ERROR_CODES.INTERNAL_ERROR.code,
      error: "An unexpected error occurred",
      timestamp: "2024-01-02T03:04:05.678Z",
    });
  });

  it("keeps the AppError construction timestamp even on a frozen clock", () => {
    const err = new AppError("frozen", 409, ERROR_CODES.CONFLICT.code, true);
    const res = makeRes();

    createErrorHandler({ logError: () => {} })(err, makeReq(), res, makeNext());

    expect(res.body?.timestamp).toBe(err.timestamp);
    expect(res.body?.timestamp).toBe("2024-01-02T03:04:05.678Z");
  });

  it("produces a byte-identical envelope for identical inputs", () => {
    const build = () => {
      const res = makeRes();
      createErrorHandler({ includeStackTrace: false, logError: () => {} })(
        new BadRequestError("bad field"),
        makeReq({ requestId: "req_stable" }),
        res,
        makeNext(),
      );
      return res;
    };

    expect(JSON.stringify(build().body)).toBe(JSON.stringify(build().body));
  });
});
