import { jest } from "@jest/globals";
import request from "supertest";
import { checkReadiness, checkDb, checkRedis } from "../health/readiness.js";

jest.mock("../middleware/rateLimiter.js", () => ({
  createAuthAwareRateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../middleware/featureFlags.js", () => ({
  featureFlagContextMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  initializeFeatureFlagsFromEnv: () => {},
}));

jest.mock("../routes/booking-intents.js", () => ({
  createBookingIntentsRouter: () => {
    const { Router } = require("express");
    return Router();
  },
}));

jest.mock("../routes/checkout.js", () => {
  const { Router } = require("express");
  return { default: Router() };
});

function mockPool(ok: boolean) {
  return {
    query: jest.fn<() => Promise<unknown>>().mockImplementation(() =>
      ok ? Promise.resolve({ rowCount: 1 }) : Promise.reject(new Error("DB down")),
    ),
  };
}

function mockRedis(ok: boolean) {
  return {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    keys: jest.fn(),
    ping: jest.fn<() => Promise<string>>().mockImplementation(() =>
      ok ? Promise.resolve("PONG") : Promise.reject(new Error("Redis down")),
    ),
    quit: jest.fn(),
  };
}

describe("checkReadiness", () => {
  it("returns both ok when DB and Redis are up", async () => {
    const result = await checkReadiness({
      pingDb: () => checkDb(mockPool(true)),
      pingRedis: () => checkRedis(mockRedis(true)),
    });
    expect(result).toEqual({ db: "ok", redis: "ok" });
  });

  it("returns db down when DB query fails", async () => {
    const result = await checkReadiness({
      pingDb: () => checkDb(mockPool(false)),
      pingRedis: () => checkRedis(mockRedis(true)),
    });
    expect(result).toEqual({ db: "down", redis: "ok" });
  });

  it("returns redis down when Redis ping fails", async () => {
    const result = await checkReadiness({
      pingDb: () => checkDb(mockPool(true)),
      pingRedis: () => checkRedis(mockRedis(false)),
    });
    expect(result).toEqual({ db: "ok", redis: "down" });
  });

  it("returns both down when both fail", async () => {
    const result = await checkReadiness({
      pingDb: () => checkDb(mockPool(false)),
      pingRedis: () => checkRedis(mockRedis(false)),
    });
    expect(result).toEqual({ db: "down", redis: "down" });
  });

  it("does not short-circuit when one fails — both checks run", async () => {
    const dbSpy = jest.fn(() => checkDb(mockPool(false)));
    const redisSpy = jest.fn(() => checkRedis(mockRedis(true)));
    const result = await checkReadiness({ pingDb: dbSpy, pingRedis: redisSpy });
    expect(result).toEqual({ db: "down", redis: "ok" });
    expect(dbSpy).toHaveBeenCalledTimes(1);
    expect(redisSpy).toHaveBeenCalledTimes(1);
  });
});

describe("GET /health/ready", () => {
  it("returns 200 when DB and Redis are up", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp({
      enableDocs: false,
      dbPool: mockPool(true),
      redisClient: mockRedis(true),
    });
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ db: "ok", redis: "ok" });
  });

  it("returns 503 when DB is down", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp({
      enableDocs: false,
      dbPool: mockPool(false),
      redisClient: mockRedis(true),
    });
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ db: "down", redis: "ok" });
  });

  it("returns 503 when Redis is down", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp({
      enableDocs: false,
      dbPool: mockPool(true),
      redisClient: mockRedis(false),
    });
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ db: "ok", redis: "down" });
  });

  it("returns 503 when both are down", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp({
      enableDocs: false,
      dbPool: mockPool(false),
      redisClient: mockRedis(false),
    });
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ db: "down", redis: "down" });
  });

  it("falls back to down when dbPool is null", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp({
      enableDocs: false,
      dbPool: null,
      redisClient: mockRedis(true),
    });
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ db: "down", redis: "ok" });
  });

  it("falls back to down when redisClient is null", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp({
      enableDocs: false,
      dbPool: mockPool(true),
      redisClient: null,
    });
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ db: "ok", redis: "down" });
  });
});

describe("checkDb", () => {
  it("returns true on successful query", async () => {
    const result = await checkDb(mockPool(true));
    expect(result).toBe(true);
  });

  it("returns false on query failure", async () => {
    const result = await checkDb(mockPool(false));
    expect(result).toBe(false);
  });
});

describe("checkRedis", () => {
  it("returns true on successful ping", async () => {
    const result = await checkRedis(mockRedis(true));
    expect(result).toBe(true);
  });

  it("returns false on ping failure", async () => {
    const result = await checkRedis(mockRedis(false));
    expect(result).toBe(false);
  });
});
