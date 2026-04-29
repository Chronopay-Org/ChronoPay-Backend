/**
 * Taxonomy-level coverage for ChronoPay error codes.
 *
 * Verifies:
 *   1. The canonical envelope shape from sendErrorResponse / AppError.toJSON.
 *   2. Each AppError subclass binds to the right (status, code) pair from
 *      ERROR_CODES.
 *   3. The global handlers in errorHandler.ts and errorHandling.ts emit the
 *      same envelope for the same input.
 *   4. Stack traces are NEVER returned in production for unknown errors.
 */

import express, { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import {
  AppError,
  BadRequestError,
  ConfigurationError,
  ConflictError,
  DatabaseError,
  ForbiddenError,
  IdempotencyError,
  InternalServerError,
  MalformedJsonError,
  MissingRequiredFieldError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  UnauthorizedError,
  UnprocessableEntityError,
  ValidationError,
} from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import { sendErrorResponse } from "../errors/sendError.js";
import { createErrorHandler } from "../middleware/errorHandler.js";
import {
  genericErrorHandler,
  jsonParseErrorHandler,
} from "../middleware/errorHandling.js";

describe("ERROR_CODES taxonomy", () => {
  it("each entry pairs a status with a matching code string", () => {
    for (const [key, entry] of Object.entries(ERROR_CODES)) {
      expect(entry.code).toBe(key);
      expect(typeof entry.status).toBe("number");
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status).toBeLessThan(600);
    }
  });

  it("contains every code referenced by the issue", () => {
    const required = [
      "VALIDATION_ERROR",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "RATE_LIMITED",
      "FEATURE_DISABLED",
      "IDEMPOTENCY_KEY_INVALID",
      "IDEMPOTENCY_IN_PROGRESS",
      "IDEMPOTENCY_KEY_MISMATCH",
      "DB_ERROR",
      "MALFORMED_JSON",
      "INTERNAL_ERROR",
    ];
    for (const code of required) {
      expect(ERROR_CODES).toHaveProperty(code);
    }
  });
});

describe("AppError subclasses", () => {
  const cases: Array<[AppError, number, string]> = [
    [new BadRequestError("x"), 400, "BAD_REQUEST"],
    [new ValidationError("x"), 422, "VALIDATION_ERROR"],
    [new MissingRequiredFieldError("amount"), 400, "MISSING_REQUIRED_FIELD"],
    [new MalformedJsonError(), 400, "MALFORMED_JSON"],
    [new UnauthorizedError(), 401, "UNAUTHORIZED"],
    [new ForbiddenError(), 403, "FORBIDDEN"],
    [new NotFoundError(), 404, "NOT_FOUND"],
    [new ConflictError(), 409, "CONFLICT"],
    [new UnprocessableEntityError(), 422, "UNPROCESSABLE_ENTITY"],
    [new RateLimitError(), 429, "RATE_LIMITED"],
    [
      new IdempotencyError("dup", ERROR_CODES.IDEMPOTENCY_KEY_INVALID.code),
      400,
      "IDEMPOTENCY_KEY_INVALID",
    ],
    [
      new IdempotencyError("busy", ERROR_CODES.IDEMPOTENCY_IN_PROGRESS.code),
      409,
      "IDEMPOTENCY_IN_PROGRESS",
    ],
    [
      new IdempotencyError("hash", ERROR_CODES.IDEMPOTENCY_KEY_MISMATCH.code),
      422,
      "IDEMPOTENCY_KEY_MISMATCH",
    ],
    [new DatabaseError("boom"), 500, "DB_ERROR"],
    [new InternalServerError(), 500, "INTERNAL_ERROR"],
    [new ServiceUnavailableError(), 503, "SERVICE_UNAVAILABLE"],
    [new ConfigurationError("missing"), 503, "CONFIGURATION_ERROR"],
  ];

  it.each(cases)("$0 has matching status/code", (err, status, code) => {
    expect(err.statusCode).toBe(status);
    expect(err.code).toBe(code);
    const env = err.toJSON();
    expect(env).toEqual(
      expect.objectContaining({
        success: false,
        code,
        error: err.message,
        timestamp: expect.any(String),
      }),
    );
  });

  it("MissingRequiredFieldError attaches the field name as details", () => {
    const err = new MissingRequiredFieldError("startTime");
    expect(err.toJSON()).toEqual(
      expect.objectContaining({
        code: "MISSING_REQUIRED_FIELD",
        details: { field: "startTime" },
      }),
    );
  });

  it("UnauthorizedError accepts a more specific code from the taxonomy", () => {
    const err = new UnauthorizedError("bad token", ERROR_CODES.INVALID_TOKEN.code);
    expect(err.code).toBe("INVALID_TOKEN");
    expect(err.statusCode).toBe(401);
  });
});

describe("sendErrorResponse helper", () => {
  it("emits the canonical envelope and copies requestId from the request", () => {
    const captured: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(body: unknown) {
        captured.body = body;
        return this;
      },
    } as unknown as Response;
    const req = { requestId: "req_abc" } as unknown as Request;

    sendErrorResponse(res, new BadRequestError("nope"), req);

    expect(captured.status).toBe(400);
    expect(captured.body).toEqual(
      expect.objectContaining({
        success: false,
        code: "BAD_REQUEST",
        error: "nope",
        timestamp: expect.any(String),
        requestId: "req_abc",
      }),
    );
  });
});

describe("global handlers emit the canonical envelope", () => {
  function buildApp(register: (app: Express) => void): Express {
    const app = express();
    app.use(express.json());
    register(app);
    return app;
  }

  it("createErrorHandler emits the canonical envelope for AppError", async () => {
    const app = buildApp((a) => {
      a.get("/x", (_req, _res, next) => next(new ForbiddenError("denied")));
      a.use(createErrorHandler());
    });

    const res = await request(app).get("/x");
    expect(res.status).toBe(403);
    expect(res.body).toEqual(
      expect.objectContaining({
        success: false,
        code: "FORBIDDEN",
        error: "denied",
        timestamp: expect.any(String),
      }),
    );
  });

  it("genericErrorHandler emits the canonical envelope for AppError", async () => {
    const app = buildApp((a) => {
      a.get("/x", (_req, _res, next) => next(new NotFoundError("absent")));
      a.use(genericErrorHandler);
    });

    const res = await request(app).get("/x");
    expect(res.status).toBe(404);
    expect(res.body).toEqual(
      expect.objectContaining({
        success: false,
        code: "NOT_FOUND",
        error: "absent",
        timestamp: expect.any(String),
      }),
    );
  });

  it("genericErrorHandler maps unknown errors to INTERNAL_ERROR with a safe message", async () => {
    const app = buildApp((a) => {
      a.get("/x", (_req, _res, next) =>
        next(new Error("DB password leaked here")),
      );
      a.use(genericErrorHandler);
    });

    const res = await request(app).get("/x");
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_ERROR");
    expect(res.body.error).not.toContain("password");
  });

  it("jsonParseErrorHandler emits MALFORMED_JSON", async () => {
    const app = buildApp((a) => {
      a.post("/x", (_req, res) => res.status(200).json({ ok: true }));
      a.use(jsonParseErrorHandler);
    });

    const res = await request(app)
      .post("/x")
      .set("content-type", "application/json")
      .send("{not json");

    expect(res.status).toBe(400);
    expect(res.body).toEqual(
      expect.objectContaining({
        success: false,
        code: "MALFORMED_JSON",
        error: "Malformed JSON payload",
      }),
    );
  });

  it("never includes stack traces in production responses", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const app = buildApp((a) => {
        a.get("/x", (_req, _res, next) => next(new Error("internal")));
        a.use(createErrorHandler());
      });

      const res = await request(app).get("/x");
      expect(res.body.stack).toBeUndefined();
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});

describe("AppError -> envelope round trip via Express", () => {
  it("includes details payload when provided", async () => {
    const app = express();
    app.use(express.json());
    app.get("/x", (_req: Request, _res: Response, next: NextFunction) =>
      next(new MissingRequiredFieldError("startTime")),
    );
    app.use(genericErrorHandler);

    const res = await request(app).get("/x");
    expect(res.status).toBe(400);
    expect(res.body).toEqual(
      expect.objectContaining({
        success: false,
        code: "MISSING_REQUIRED_FIELD",
        error: "Missing required field: startTime",
        details: { field: "startTime" },
      }),
    );
  });
});
