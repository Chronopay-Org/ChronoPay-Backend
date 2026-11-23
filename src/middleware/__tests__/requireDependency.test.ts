import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { Request, Response, NextFunction } from "express";
import {
  _setRedisReadyProbe,
  _setDbReadyProbe,
  isDependencyAvailable,
} from "../dependencyStatus.js";
import { requireDependency } from "../requireDependency.js";

// Minimal Express mock helpers
function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

const next: NextFunction = jest.fn() as unknown as NextFunction;

beforeEach(() => {
  (next as jest.Mock).mockClear();
});

// ─── isDependencyAvailable ────────────────────────────────────────────────────

describe("isDependencyAvailable", () => {
  it("returns true for redis when probe returns true", async () => {
    _setRedisReadyProbe(() => true);
    expect(await isDependencyAvailable("redis")).toBe(true);
  });

  it("returns false for redis when probe returns false", async () => {
    _setRedisReadyProbe(() => false);
    expect(await isDependencyAvailable("redis")).toBe(false);
  });

  it("returns true for db when probe resolves true", async () => {
    _setDbReadyProbe(async () => true);
    expect(await isDependencyAvailable("db")).toBe(true);
  });

  it("returns false for db when probe resolves false", async () => {
    _setDbReadyProbe(async () => false);
    expect(await isDependencyAvailable("db")).toBe(false);
  });
});

// ─── requireDependency — redis ────────────────────────────────────────────────

describe("requireDependency('redis')", () => {
  it("calls next() when redis is healthy", async () => {
    _setRedisReadyProbe(() => true);
    const res = makeRes();
    await requireDependency("redis")({} as Request, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it("returns 503 with correct envelope when redis is down", async () => {
    _setRedisReadyProbe(() => false);
    const res = makeRes();
    await requireDependency("redis")({} as Request, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      success: false,
      code: "DEPENDENCY_UNAVAILABLE",
      error: "Redis is currently unavailable",
    });
  });

  it("does not leak connection details in the 503 error message", async () => {
    _setRedisReadyProbe(() => false);
    const res = makeRes();
    await requireDependency("redis")({} as Request, res, next);
    const body = res.body as { error: string };
    expect(body.error).not.toMatch(/redis:\/\//i);
    expect(body.error).not.toMatch(/localhost/i);
  });
});

// ─── requireDependency — db ───────────────────────────────────────────────────

describe("requireDependency('db')", () => {
  it("calls next() when db is healthy", async () => {
    _setDbReadyProbe(async () => true);
    const res = makeRes();
    await requireDependency("db")({} as Request, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it("returns 503 with correct envelope when db is down", async () => {
    _setDbReadyProbe(async () => false);
    const res = makeRes();
    await requireDependency("db")({} as Request, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      success: false,
      code: "DEPENDENCY_UNAVAILABLE",
      error: "Database is currently unavailable",
    });
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("dependency recovers: second call passes after first fails", async () => {
    _setRedisReadyProbe(() => false);
    const res1 = makeRes();
    await requireDependency("redis")({} as Request, res1, next);
    expect(res1.statusCode).toBe(503);

    // Dependency comes back up
    _setRedisReadyProbe(() => true);
    const res2 = makeRes();
    await requireDependency("redis")({} as Request, res2, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res2.statusCode).toBe(200);
  });

  it("multiple independent middleware instances gate independently", async () => {
    _setRedisReadyProbe(() => false);
    _setDbReadyProbe(async () => true);

    const resRedis = makeRes();
    await requireDependency("redis")({} as Request, resRedis, next);
    expect(resRedis.statusCode).toBe(503);

    const resDb = makeRes();
    await requireDependency("db")({} as Request, resDb, next);
    expect(next).toHaveBeenCalledTimes(1); // only db passed
    expect(resDb.statusCode).toBe(200);
  });
});
