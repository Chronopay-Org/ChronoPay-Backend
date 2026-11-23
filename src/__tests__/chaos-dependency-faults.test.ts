import express, { type Request, type Response } from "express";
import request from "supertest";
import Redis from "ioredis-mock";
import type { Pool } from "pg";
import { getCachedSlots, setCachedSlots, type Slot } from "../cache/slotCache.js";
import { setRedisClient, type RedisClient } from "../cache/redisClient.js";
import {
  closePool,
  getPool,
  _resetPoolFactory,
  _setPoolFactory,
} from "../db/connection.js";
import {
  _setDbReadyProbe,
  _setRedisReadyProbe,
} from "../middleware/dependencyStatus.js";
import { requireDependency } from "../middleware/requireDependency.js";
import { register } from "../metrics.js";

type DbFault = "timeout" | "pool_exhausted";

class FaultyPgPool {
  constructor(private readonly fault: DbFault) {}

  async query(): Promise<never> {
    if (this.fault === "pool_exhausted") {
      const err = new Error("remaining connection slots are reserved");
      (err as NodeJS.ErrnoException).code = "53300";
      throw err;
    }

    const err = new Error("statement timeout");
    (err as NodeJS.ErrnoException).code = "57014";
    throw err;
  }

  async end(): Promise<void> {}

  on(): this {
    return this;
  }
}

function createChaosApp() {
  const app = express();
  const fallbackSlots: Slot[] = [
    {
      id: 1,
      professional: "dr-secure",
      startTime: "2026-06-01T09:00:00.000Z",
      endTime: "2026-06-01T10:00:00.000Z",
    },
  ];

  app.get("/redis-guarded", requireDependency("redis"), (_req, res) => {
    res.json({ success: true });
  });

  app.get("/db-guarded", requireDependency("db"), (_req, res) => {
    res.json({ success: true });
  });

  app.get("/slots/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const cached = await getCachedSlots();
    const source = cached ?? fallbackSlots;
    const slot = source.find((entry) => entry.id === id);

    if (!slot) {
      res.status(404).json({ success: false, code: "NOT_FOUND", error: "Slot not found" });
      return;
    }

    if (cached === null) {
      await setCachedSlots(fallbackSlots);
    }

    res.set("X-Cache", cached === null ? "MISS" : "HIT");
    res.json({ success: true, slot });
  });

  return app;
}

async function metricValue(metric: string, labels: Record<string, string>): Promise<number> {
  const metrics = await register.metrics();
  const labelText = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(",");
  const line = metrics
    .split("\n")
    .find((entry) => entry.startsWith(`${metric}{${labelText}}`));

  if (!line) {
    return 0;
  }

  return Number(line.trim().split(/\s+/).at(-1));
}

async function setDbFault(fault: DbFault): Promise<void> {
  await closePool();
  _setPoolFactory(() => new FaultyPgPool(fault) as unknown as Pool);
  _setDbReadyProbe(async () => {
    try {
      await getPool().query("SELECT 1");
      return true;
    } catch {
      return { available: false, fault };
    }
  });
}

describe("dependency chaos faults", () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };

  beforeAll(() => {
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterAll(() => {
    process.off("unhandledRejection", onUnhandledRejection);
  });

  beforeEach(async () => {
    process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/testdb";
    register.resetMetrics();
    unhandledRejections.length = 0;
    setRedisClient(null);
    _setRedisReadyProbe(() => true);
    _setDbReadyProbe(async () => true);
    _resetPoolFactory();
    await closePool();
  });

  afterEach(async () => {
    setRedisClient(null);
    _setRedisReadyProbe(() => true);
    _setDbReadyProbe(async () => true);
    await closePool();
    _resetPoolFactory();
    expect(unhandledRejections).toEqual([]);
  });

  it("returns a typed 503 and records a metric when Redis is disconnected", async () => {
    _setRedisReadyProbe(() => false);

    const res = await request(createChaosApp()).get("/redis-guarded").expect(503);

    expect(res.body).toEqual({
      success: false,
      code: "DEPENDENCY_UNAVAILABLE",
      error: "Redis is currently unavailable",
    });
    expect(
      await metricValue("dependency_faults_total", {
        dependency: "redis",
        fault: "disconnect",
      }),
    ).toBe(1);
  });

  it("returns a typed 503 and records a metric when Postgres times out", async () => {
    await setDbFault("timeout");

    const res = await request(createChaosApp()).get("/db-guarded").expect(503);

    expect(res.body).toEqual({
      success: false,
      code: "DEPENDENCY_UNAVAILABLE",
      error: "Database is currently unavailable",
    });
    expect(
      await metricValue("dependency_faults_total", {
        dependency: "db",
        fault: "timeout",
      }),
    ).toBe(1);
  });

  it("returns a typed 503 and records a metric when the Postgres pool is exhausted", async () => {
    await setDbFault("pool_exhausted");

    const res = await request(createChaosApp()).get("/db-guarded").expect(503);

    expect(res.body).toEqual({
      success: false,
      code: "DEPENDENCY_UNAVAILABLE",
      error: "Database is currently unavailable",
    });
    expect(
      await metricValue("dependency_faults_total", {
        dependency: "db",
        fault: "pool_exhausted",
      }),
    ).toBe(1);
  });

  it("keeps Redis-backed read paths available on partial cache outage", async () => {
    const redis = new Redis() as unknown as RedisClient;
    redis.get = async () => {
      throw new Error("Connection is closed.");
    };
    setRedisClient(redis);
    _setRedisReadyProbe(() => false);

    const res = await request(createChaosApp()).get("/slots/1").expect(200);

    expect(res.header["x-cache"]).toBe("MISS");
    expect(res.body).toEqual({
      success: true,
      slot: {
        id: 1,
        professional: "dr-secure",
        startTime: "2026-06-01T09:00:00.000Z",
        endTime: "2026-06-01T10:00:00.000Z",
      },
    });
    expect(
      await metricValue("dependency_faults_total", {
        dependency: "redis",
        fault: "cache_read",
      }),
    ).toBe(1);
  });
});
