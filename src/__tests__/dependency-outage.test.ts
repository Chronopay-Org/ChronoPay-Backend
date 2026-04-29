/**
 * Tests for dependency outage handling (#116).
 *
 * Covers:
 *  - dependencyStatus: redis down, redis up, db down, db up
 *  - requireDependency middleware: 503 when down, passes through when up
 *  - idempotency middleware: fail-closed (503) when Redis is null
 *  - genericErrorHandler: consistent {success,code,error} envelope for AppError-shaped errors
 */

import { jest, describe, it, expect, afterEach } from "@jest/globals";
import type { Request, Response, NextFunction } from "express";
import express from "express";
import request from "supertest";

// ── dependency status ────────────────────────────────────────────────────────

import {
  isDependencyAvailable,
  _setRedisReadyProbe,
  _setDbReadyProbe,
} from "../middleware/dependencyStatus.js";

describe("isDependencyAvailable", () => {
  afterEach(() => {
    // Reset probes to defaults that return false (safe baseline)
    _setRedisReadyProbe(() => false);
    _setDbReadyProbe(async () => false);
  });

  describe("redis", () => {
    it("returns false when the redis probe returns false", async () => {
      _setRedisReadyProbe(() => false);
      await expect(isDependencyAvailable("redis")).resolves.toBe(false);
    });

    it("returns true when the redis probe returns true", async () => {
      _setRedisReadyProbe(() => true);
      await expect(isDependencyAvailable("redis")).resolves.toBe(true);
    });
  });

  describe("db", () => {
    it("returns false when the db probe returns false", async () => {
      _setDbReadyProbe(async () => false);
      await expect(isDependencyAvailable("db")).resolves.toBe(false);
    });

    it("returns true when the db probe returns true", async () => {
      _setDbReadyProbe(async () => true);
      await expect(isDependencyAvailable("db")).resolves.toBe(true);
    });
  });
});

// ── requireDependency middleware ─────────────────────────────────────────────

import { requireDependency } from "../middleware/requireDependency.js";

function makeMiddlewareApp(dep: "redis" | "db") {
  const app = express();
  app.use(express.json());
  app.get("/test", requireDependency(dep), (_req, res) => {
    res.json({ success: true });
  });
  return app;
}

describe("requireDependency middleware", () => {
  afterEach(() => {
    _setRedisReadyProbe(() => false);
    _setDbReadyProbe(async () => false);
  });

  describe("redis dependency", () => {
    it("returns 503 with DEPENDENCY_UNAVAILABLE when Redis is down", async () => {
      _setRedisReadyProbe(() => false);
      const res = await request(makeMiddlewareApp("redis")).get("/test");
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        success: false,
        code: "DEPENDENCY_UNAVAILABLE",
        error: "Redis is currently unavailable",
      });
    });

    it("passes through when Redis is up", async () => {
      _setRedisReadyProbe(() => true);
      const res = await request(makeMiddlewareApp("redis")).get("/test");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("db dependency", () => {
    it("returns 503 with DEPENDENCY_UNAVAILABLE when DB is down", async () => {
      _setDbReadyProbe(async () => false);
      const res = await request(makeMiddlewareApp("db")).get("/test");
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        success: false,
        code: "DEPENDENCY_UNAVAILABLE",
        error: "Database is currently unavailable",
      });
    });

    it("passes through when DB is up", async () => {
      _setDbReadyProbe(async () => true);
      const res = await request(makeMiddlewareApp("db")).get("/test");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("partial outage (redis down, db up)", () => {
    it("redis endpoint returns 503 while db endpoint returns 200", async () => {
      _setRedisReadyProbe(() => false);
      _setDbReadyProbe(async () => true);

      const redisRes = await request(makeMiddlewareApp("redis")).get("/test");
      const dbRes = await request(makeMiddlewareApp("db")).get("/test");

      expect(redisRes.status).toBe(503);
      expect(dbRes.status).toBe(200);
    });
  });
});

// ── idempotency middleware fail-closed ───────────────────────────────────────

import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { setRedisClient } from "../cache/redisClient.js";

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: "POST",
    originalUrl: "/api/v1/slots",
    body: {},
    header: jest.fn<(name: string) => string | undefined>().mockReturnValue("key-001"),
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const res = {
    status: jest.fn<Response["status"]>().mockReturnThis(),
    json: jest.fn<Response["json"]>().mockReturnThis(),
  } as unknown as Response;
  return res;
}

describe("idempotencyMiddleware — fail-closed on Redis outage", () => {
  afterEach(() => {
    setRedisClient(null);
  });

  it("returns 503 DEPENDENCY_UNAVAILABLE when Redis client is null", async () => {
    setRedisClient(null);
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;

    await idempotencyMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: "DEPENDENCY_UNAVAILABLE",
      error: "Redis is currently unavailable",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("does NOT call next() when Redis is down (fail-closed, not fail-open)", async () => {
    setRedisClient(null);
    const next = jest.fn() as unknown as NextFunction;
    await idempotencyMiddleware(mockReq(), mockRes(), next);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() when no Idempotency-Key header is present (opt-in)", async () => {
    setRedisClient(null);
    const req = mockReq({
      header: jest.fn<(name: string) => string | undefined>().mockReturnValue(undefined),
    });
    const next = jest.fn() as unknown as NextFunction;
    await idempotencyMiddleware(req, mockRes(), next);
    // No key → middleware is bypassed regardless of Redis state
    expect(next).toHaveBeenCalled();
  });
});

// ── genericErrorHandler consistent 503 envelope ──────────────────────────────

import {
  genericErrorHandler,
  notFoundHandler,
  jsonParseErrorHandler,
} from "../middleware/errorHandling.js";
import { ServiceUnavailableError } from "../errors/AppError.js";

function makeErrorApp(thrownError: unknown) {
  const app = express();
  app.get("/boom", (_req, _res, next) => next(thrownError));
  app.use(notFoundHandler);
  app.use(jsonParseErrorHandler);
  app.use(genericErrorHandler);
  return app;
}

describe("genericErrorHandler", () => {
  it("returns 503 with consistent envelope for ServiceUnavailableError", async () => {
    const err = new ServiceUnavailableError("Redis is currently unavailable");
    const res = await request(makeErrorApp(err)).get("/boom");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: false,
      code: "SERVICE_UNAVAILABLE",
      error: "Redis is currently unavailable",
    });
  });

  it("returns 503 for a generic AppError-shaped dependency error", async () => {
    const err = Object.assign(new Error("DB gone"), {
      statusCode: 503,
      code: "DEPENDENCY_UNAVAILABLE",
    });
    const res = await request(makeErrorApp(err)).get("/boom");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: false,
      code: "DEPENDENCY_UNAVAILABLE",
      error: "DB gone",
    });
  });

  it("returns 415 envelope for UNSUPPORTED_MEDIA_TYPE (regression)", async () => {
    const err = Object.assign(new Error("Unsupported Media Type"), {
      statusCode: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
    });
    const res = await request(makeErrorApp(err)).get("/boom");
    expect(res.status).toBe(415);
    expect(res.body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("returns 500 for plain Error (no statusCode/code)", async () => {
    const res = await request(makeErrorApp(new Error("boom"))).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
