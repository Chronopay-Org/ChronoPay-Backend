import { describe, expect, it, jest } from "@jest/globals";
import type { Pool } from "pg";

import type { RedisClient } from "../cache/redisClient.js";
import {
  checkDb,
  checkReadiness,
  checkRedis,
  type ReadinessPingers,
  type ReadinessResult,
} from "./readiness.js";

describe("ReadinessResult and checkReadiness", () => {
  it.each([
    [true, true, { db: "ok", redis: "ok" }],
    [false, true, { db: "down", redis: "ok" }],
    [true, false, { db: "ok", redis: "down" }],
    [false, false, { db: "down", redis: "down" }],
  ] as const)("maps db=%s and redis=%s into the public result", async (db, redis, expected) => {
    const pingers: ReadinessPingers = {
      pingDb: jest.fn<() => Promise<boolean>>().mockResolvedValue(db),
      pingRedis: jest.fn<() => Promise<boolean>>().mockResolvedValue(redis),
    };

    const result: ReadinessResult = await checkReadiness(pingers);

    expect(result).toEqual(expected);
    expect(pingers.pingDb).toHaveBeenCalledTimes(1);
    expect(pingers.pingRedis).toHaveBeenCalledTimes(1);
  });

  it("starts both pingers before waiting for either one", async () => {
    let resolveDb!: (value: boolean) => void;
    const pingDb = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveDb = resolve;
        }),
    );
    const pingRedis = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);

    const resultPromise = checkReadiness({ pingDb, pingRedis });

    expect(pingDb).toHaveBeenCalledTimes(1);
    expect(pingRedis).toHaveBeenCalledTimes(1);
    resolveDb(false);
    await expect(resultPromise).resolves.toEqual({ db: "down", redis: "ok" });
  });

  it("preserves a rejected custom pinger as a rejected readiness check", async () => {
    const failure = new Error("pinger misconfigured");
    const pingers: ReadinessPingers = {
      pingDb: jest.fn<() => Promise<boolean>>().mockRejectedValue(failure),
      pingRedis: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    };

    await expect(checkReadiness(pingers)).rejects.toBe(failure);
    expect(pingers.pingRedis).toHaveBeenCalledTimes(1);
  });
});

describe("readiness dependency adapters", () => {
  it.each([null, undefined])("treats a %s database pool as down", async (pool) => {
    await expect(checkDb(pool)).resolves.toBe(false);
  });

  it("uses SELECT 1 and reports a successful database query", async () => {
    const query = jest.fn<Pool["query"]>().mockResolvedValue({ rows: [], rowCount: 1 } as never);

    await expect(checkDb({ query })).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith("SELECT 1");
  });

  it("converts a database query rejection into false", async () => {
    const query = jest.fn<Pool["query"]>().mockRejectedValue(new Error("database down"));

    await expect(checkDb({ query })).resolves.toBe(false);
  });

  it("returns true for PONG and false for a rejected Redis ping", async () => {
    const ping = jest.fn<RedisClient["ping"]>().mockResolvedValue("PONG");
    await expect(checkRedis({ ping } as RedisClient)).resolves.toBe(true);

    ping.mockRejectedValueOnce(new Error("redis down"));
    await expect(checkRedis({ ping } as RedisClient)).resolves.toBe(false);
  });
});
