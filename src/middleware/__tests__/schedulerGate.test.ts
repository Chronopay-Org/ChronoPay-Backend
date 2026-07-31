/**
 * Tests for the schedulerGate middleware.
 *
 * Verifies the three-way contract:
 *   - not paused        → next()
 *   - paused            → 503 SCHEDULER_PAUSED (fail closed)
 *   - Redis unavailable → next() + warning (fail OPEN)
 */
import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { schedulerGate } from "../schedulerGate.js";
import { setRedisClient, pauseScheduler, type RedisLike } from "../../redis.js";

function makeFakeRedis(overrides: Partial<RedisLike> = {}): RedisLike {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => (store.has(key) ? store.get(key)! : null),
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
    del: async (key: string) => {
      store.delete(key);
      return 1;
    },
    ping: async () => "PONG",
    quit: async () => "OK",
    ...overrides,
  };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post("/create", schedulerGate, (_req, res) => {
    res.status(201).json({ success: true, created: true });
  });
  return app;
}

describe("schedulerGate", () => {
  afterEach(() => {
    setRedisClient(null);
    jest.restoreAllMocks();
  });

  it("allows the request when the scheduler is not paused", async () => {
    setRedisClient(makeFakeRedis());
    const res = await request(makeApp()).post("/create").send({});
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, created: true });
  });

  it("blocks with 503 SCHEDULER_PAUSED when paused, exposing metadata + Retry-After", async () => {
    setRedisClient(makeFakeRedis());
    await pauseScheduler({ reason: "db incident", initiatedBy: "alice" });

    const res = await request(makeApp()).post("/create").send({});

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("120");
    expect(res.body).toMatchObject({
      success: false,
      code: "SCHEDULER_PAUSED",
      reason: "db incident",
      initiatedBy: "alice",
    });
    expect(res.body.pausedAt).toBeTruthy();
  });

  it("fails OPEN (allows traffic) when Redis is unavailable", async () => {
    setRedisClient(null); // getRedisClient() → null → RedisUnavailableError
    const res = await request(makeApp()).post("/create").send({});
    expect(res.status).toBe(201);
  });

  it("fails OPEN when the redis read throws mid-flight", async () => {
    setRedisClient(
      makeFakeRedis({
        get: async () => {
          throw new Error("connection reset");
        },
      }),
    );
    const res = await request(makeApp()).post("/create").send({});
    expect(res.status).toBe(201);
  });

  it("nulls out missing metadata fields in the paused response", async () => {
    // Simulate a bare "1" legacy flag with no metadata.
    const store = new Map<string, string>([["scheduler:paused", "1"]]);
    setRedisClient(
      makeFakeRedis({
        get: async (key: string) => store.get(key) ?? null,
      }),
    );

    const res = await request(makeApp()).post("/create").send({});
    expect(res.status).toBe(503);
    expect(res.body.reason).toBeNull();
    expect(res.body.initiatedBy).toBeNull();
    expect(res.body.pausedAt).toBeNull();
  });
});
