import { jest } from "@jest/globals";
import request from "supertest";
import {
  checkReadiness,
  checkDb,
  checkRedis,
  getReadinessTimeoutMs,
  withTimeout,
} from "../health/readiness.js";

afterEach(() => {
  delete process.env.READINESS_TIMEOUT_MS;
  jest.useRealTimers();
});

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
      // @ts-expect-error - Auto-fixed by script
      pingDb: () => checkDb(mockPool(true)),
      // @ts-expect-error - Auto-fixed by script
      pingRedis: () => checkRedis(mockRedis(true)),
    });
    expect(result).toEqual({ db: "ok", redis: "ok" });
  });

  it("returns db down when DB query fails", async () => {
    const result = await checkReadiness({
      // @ts-expect-error - Auto-fixed by script
      pingDb: () => checkDb(mockPool(false)),
      // @ts-expect-error - Auto-fixed by script
      pingRedis: () => checkRedis(mockRedis(true)),
    });
    expect(result).toEqual({ db: "down", redis: "ok" });
  });

  it("returns redis down when Redis ping fails", async () => {
    const result = await checkReadiness({
      // @ts-expect-error - Auto-fixed by script
      pingDb: () => checkDb(mockPool(true)),
      // @ts-expect-error - Auto-fixed by script
      pingRedis: () => checkRedis(mockRedis(false)),
    });
    expect(result).toEqual({ db: "ok", redis: "down" });
  });

  it("returns both down when both fail", async () => {
    const result = await checkReadiness({
      // @ts-expect-error - Auto-fixed by script
      pingDb: () => checkDb(mockPool(false)),
      // @ts-expect-error - Auto-fixed by script
      pingRedis: () => checkRedis(mockRedis(false)),
    });
    expect(result).toEqual({ db: "down", redis: "down" });
  });

  it("does not short-circuit when one fails — both checks run", async () => {
    // @ts-expect-error - Auto-fixed by script
    const dbSpy = jest.fn(() => checkDb(mockPool(false)));
    // @ts-expect-error - Auto-fixed by script
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
      // @ts-expect-error - Auto-fixed by script
      dbPool: mockPool(true),
      // @ts-expect-error - Auto-fixed by script
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
      // @ts-expect-error - Auto-fixed by script
      dbPool: mockPool(false),
      // @ts-expect-error - Auto-fixed by script
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
      // @ts-expect-error - Auto-fixed by script
      dbPool: mockPool(true),
      // @ts-expect-error - Auto-fixed by script
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
      // @ts-expect-error - Auto-fixed by script
      dbPool: mockPool(false),
      // @ts-expect-error - Auto-fixed by script
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
      // @ts-expect-error - Auto-fixed by script
      redisClient: mockRedis(true),
    });
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ db: "down", redis: "ok" });
  });

  it("returns 503 within the timeout when DB hangs", async () => {
    process.env.READINESS_TIMEOUT_MS = "50";
    const { createApp } = await import("../app.js");
    const app = createApp({
      enableDocs: false,
      // @ts-expect-error - never-resolving query simulates a stalled pool
      dbPool: { query: () => new Promise(() => {}) },
      // @ts-expect-error - Auto-fixed by script
      redisClient: mockRedis(true),
    });
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ db: "down", redis: "ok" });
  });

  it("returns 503 when the DB pinger throws synchronously", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp({
      enableDocs: false,
      dbPool: {
        query: () => {
          throw new Error("pool unavailable");
        },
      } as unknown as Parameters<typeof createApp>[0]["dbPool"],
      // @ts-expect-error - Auto-fixed by script
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
      // @ts-expect-error - Auto-fixed by script
      dbPool: mockPool(true),
      redisClient: null,
    });
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ db: "ok", redis: "down" });
  });
});

describe("withTimeout", () => {
  it("resolves with the value when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 100)).resolves.toBe("ok");
  });

  it("rejects when the promise never settles", async () => {
    jest.useFakeTimers();
    const pending = withTimeout(new Promise(() => {}), 100);
    const assertion = expect(pending).rejects.toThrow("Readiness check timed out after 100ms");

    await jest.advanceTimersByTimeAsync(100);

    await assertion;
  });
});

describe("getReadinessTimeoutMs", () => {
  it("defaults to 2000ms", () => {
    expect(getReadinessTimeoutMs()).toBe(2000);
  });

  it("uses READINESS_TIMEOUT_MS when it is a positive integer", () => {
    process.env.READINESS_TIMEOUT_MS = "250";
    expect(getReadinessTimeoutMs()).toBe(250);
  });

  it("falls back to the default for invalid values", () => {
    process.env.READINESS_TIMEOUT_MS = "not-a-number";
    expect(getReadinessTimeoutMs()).toBe(2000);
  });
});

describe("checkReadiness — timeout and exception safety", () => {
  it("returns down for a dependency that never settles", async () => {
    jest.useFakeTimers();
    process.env.READINESS_TIMEOUT_MS = "50";

    const result = checkReadiness({
      pingDb: () => new Promise<boolean>(() => {}),
      pingRedis: async () => true,
    });

    await jest.advanceTimersByTimeAsync(50);

    await expect(result).resolves.toEqual({ db: "down", redis: "ok" });
  });

  it("returns both down when both dependencies hang", async () => {
    jest.useFakeTimers();
    process.env.READINESS_TIMEOUT_MS = "50";

    const result = checkReadiness({
      pingDb: () => new Promise<boolean>(() => {}),
      pingRedis: () => new Promise<boolean>(() => {}),
    });

    await jest.advanceTimersByTimeAsync(50);

    await expect(result).resolves.toEqual({ db: "down", redis: "down" });
  });

  it("returns down when a pinger throws synchronously", async () => {
    const result = await checkReadiness({
      pingDb: () => {
        throw new Error("pool unavailable");
      },
      pingRedis: async () => true,
    });

    expect(result).toEqual({ db: "down", redis: "ok" });
  });

  it("returns down when a pinger rejects", async () => {
    const result = await checkReadiness({
      pingDb: async () => true,
      pingRedis: async () => {
        throw new Error("redis unavailable");
      },
    });

    expect(result).toEqual({ db: "ok", redis: "down" });
  });
});

describe("checkDb", () => {
  it("returns true on successful query", async () => {
    // @ts-expect-error - Auto-fixed by script
    const result = await checkDb(mockPool(true));
    expect(result).toBe(true);
  });

  it("returns false on query failure", async () => {
    // @ts-expect-error - Auto-fixed by script
    const result = await checkDb(mockPool(false));
    expect(result).toBe(false);
  });
});

describe("checkRedis", () => {
  it("returns true on successful ping", async () => {
    // @ts-expect-error - Auto-fixed by script
    const result = await checkRedis(mockRedis(true));
    expect(result).toBe(true);
  });

  it("returns false on ping failure", async () => {
    // @ts-expect-error - Auto-fixed by script
    const result = await checkRedis(mockRedis(false));
    expect(result).toBe(false);
  });
});
