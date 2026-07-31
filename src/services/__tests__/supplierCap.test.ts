import { describe, expect, it, beforeEach } from "@jest/globals";
import {
  DEFAULT_SUPPLIER_DAILY_BOOKING_CAP,
  SUPPLIER_DAILY_CAP_KEY_TTL_SECONDS,
  MAX_SUPPLIER_DAILY_BOOKING_CAP,
  supplierDailyCapKey,
  utcDateKey,
  nextUtcMidnight,
  SupplierBookingCapService,
  SupplierDailyCapExceededError,
  type RedisClient,
} from "../supplierCap.js";

class FakeRedisClient implements RedisClient {
  readonly store = new Map<string, string>();
  incrCalls: string[] = [];
  expireCalls: { key: string; ttl: number }[] = [];
  failIncr = false;
  failGet = false;

  async get(key: string): Promise<string | null> {
    if (this.failGet) {
      throw new Error("redis unavailable");
    }
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<unknown> {
    return this.store.delete(key) ? 1 : 0;
  }

  async incr(key: string): Promise<number> {
    this.incrCalls.push(key);
    if (this.failIncr) {
      throw new Error("redis unavailable");
    }
    const next = (parseInt(this.store.get(key) ?? "0", 10) || 0) + 1;
    this.store.set(key, String(next));
    return next;
  }

  async expire(key: string, ttl: number): Promise<unknown> {
    this.expireCalls.push({ key, ttl });
    return 1;
  }

  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace("*", "");
    return Array.from(this.store.keys()).filter((k) => k.startsWith(prefix));
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async quit(): Promise<unknown> {
    return "OK";
  }
}

describe("supplierCap helpers", () => {
  it("builds the Redis key per the issue spec", () => {
    expect(supplierDailyCapKey("sup-1", "2026-07-31")).toBe("supplier:sup-1:booking:2026-07-31");
  });

  it("derives a UTC date key", () => {
    expect(utcDateKey(new Date("2026-07-31T23:59:59.999Z"))).toBe("2026-07-31");
    expect(utcDateKey(new Date("2026-08-01T00:00:00.000Z"))).toBe("2026-08-01");
  });

  it("computes the next UTC midnight as the reset boundary", () => {
    expect(nextUtcMidnight(new Date("2026-07-31T12:00:00.000Z"))).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("SupplierBookingCapService", () => {
  let redis: FakeRedisClient;
  let clockIso: string;
  let service: SupplierBookingCapService;

  beforeEach(() => {
    redis = new FakeRedisClient();
    clockIso = "2026-07-31T12:00:00.000Z";
    service = new SupplierBookingCapService({
      getRedis: () => redis,
      nowIso: () => clockIso,
      auditLogger: {
        log: async () => {},
      } as any,
    });
  });

  describe("increment", () => {
    it("returns usage with the default cap and a reset timestamp", async () => {
      const usage = await service.increment("sup-1");
      expect(usage).toEqual({
        supplierId: "sup-1",
        used: 1,
        cap: DEFAULT_SUPPLIER_DAILY_BOOKING_CAP,
        resetAt: "2026-08-01T00:00:00.000Z",
      });
      expect(redis.incrCalls).toEqual(["supplier:sup-1:booking:2026-07-31"]);
    });

    it("sets a 26h TTL on the first increment of the day only", async () => {
      await service.increment("sup-1");
      await service.increment("sup-1");
      expect(redis.expireCalls).toEqual([
        { key: "supplier:sup-1:booking:2026-07-31", ttl: SUPPLIER_DAILY_CAP_KEY_TTL_SECONDS },
      ]);
    });

    it("allows exactly at the cap and rejects one over", async () => {
      await service.setOverride("sup-1", 2, "admin");
      expect((await service.increment("sup-1"))?.used).toBe(1);
      expect((await service.increment("sup-1"))?.used).toBe(2);

      const error = await service.increment("sup-1").catch((e) => e);
      expect(error).toBeInstanceOf(SupplierDailyCapExceededError);
      expect(error.statusCode).toBe(429);
      expect(error.code).toBe("RATE_LIMITED");
      expect(error.usage).toEqual({
        supplierId: "sup-1",
        used: 3,
        cap: 2,
        resetAt: "2026-08-01T00:00:00.000Z",
      });
    });

    it("soft-blocks when the admin override is 0", async () => {
      await service.setOverride("sup-1", 0, "admin");
      const error = await service.increment("sup-1").catch((e) => e);
      expect(error).toBeInstanceOf(SupplierDailyCapExceededError);
      expect(error.usage.cap).toBe(0);
      expect(error.usage.used).toBe(1);
    });

    it("fails open (returns null) when Redis is unavailable", async () => {
      const offline = new SupplierBookingCapService({
        getRedis: () => null,
        nowIso: () => clockIso,
      });
      expect(await offline.increment("sup-1")).toBeNull();
    });

    it("fails open (returns null) when Redis throws", async () => {
      redis.failIncr = true;
      expect(await service.increment("sup-1")).toBeNull();
    });

    it("fails open for an invalid supplier id", async () => {
      expect(await service.increment("")).toBeNull();
      expect(await service.increment("  ")).toBeNull();
    });

    it("uses a fresh counter after midnight rollover", async () => {
      clockIso = "2026-07-31T23:59:59.000Z";
      await service.increment("sup-1");
      expect(redis.store.get("supplier:sup-1:booking:2026-07-31")).toBe("1");

      clockIso = "2026-08-01T00:00:00.000Z";
      const usage = await service.increment("sup-1");
      expect(usage?.used).toBe(1);
      expect(usage?.resetAt).toBe("2026-08-02T00:00:00.000Z");
      expect(redis.store.get("supplier:sup-1:booking:2026-08-01")).toBe("1");
    });
  });

  describe("getUsage", () => {
    it("reads the current count without consuming", async () => {
      await service.increment("sup-1");
      await service.increment("sup-1");
      const usage = await service.getUsage("sup-1");
      expect(usage?.used).toBe(2);
    });

    it("reports zero when the supplier has not booked today", async () => {
      const usage = await service.getUsage("sup-1");
      expect(usage?.used).toBe(0);
      expect(usage?.cap).toBe(DEFAULT_SUPPLIER_DAILY_BOOKING_CAP);
    });

    it("returns null when Redis is unavailable", async () => {
      const offline = new SupplierBookingCapService({ getRedis: () => null });
      expect(await offline.getUsage("sup-1")).toBeNull();
    });

    it("returns null for an invalid supplier id", async () => {
      expect(await service.getUsage("")).toBeNull();
      expect(await service.getUsage("   ")).toBeNull();
    });

    it("returns null when Redis throws", async () => {
      const failing = new FakeRedisClient();
      failing.failGet = true;
      const broken = new SupplierBookingCapService({
        getRedis: () => failing,
        nowIso: () => clockIso,
      });
      await expect(broken.getUsage("sup-1")).resolves.toBeNull();
    });
  });

  describe("admin overrides", () => {
    it("defaults the cap for suppliers without an override", () => {
      expect(service.resolveCap("sup-1")).toBe(DEFAULT_SUPPLIER_DAILY_BOOKING_CAP);
    });

    it("creates, reads, lists, and deletes overrides", async () => {
      const created = await service.setOverride("sup-1", 10, "admin-1", "trial");
      expect(created).toMatchObject({
        supplierId: "sup-1",
        dailyCap: 10,
        createdBy: "admin-1",
        updatedBy: "admin-1",
        description: "trial",
      });
      expect(service.resolveCap("sup-1")).toBe(10);
      expect(service.getOverride("sup-1")?.dailyCap).toBe(10);
      expect(service.listOverrides()).toHaveLength(1);

      const updated = await service.setOverride("sup-1", 25, "admin-2");
      expect(updated.updatedBy).toBe("admin-2");
      expect(updated.createdBy).toBe("admin-1");

      expect(await service.deleteOverride("sup-1", "admin-2")).toBe(true);
      expect(await service.deleteOverride("sup-1", "admin-2")).toBe(false);
      expect(service.getOverride("sup-1")).toBeUndefined();
      expect(service.resolveCap("sup-1")).toBe(DEFAULT_SUPPLIER_DAILY_BOOKING_CAP);
    });

    it("rejects invalid cap values", async () => {
      await expect(service.setOverride("", 5, "admin")).rejects.toThrow("non-empty");
      await expect(service.setOverride("sup-1", -1, "admin")).rejects.toThrow("integer");
      await expect(service.setOverride("sup-1", 1.5, "admin")).rejects.toThrow("integer");
      await expect(service.setOverride("sup-1", MAX_SUPPLIER_DAILY_BOOKING_CAP + 1, "admin")).rejects.toThrow(
        "integer",
      );
      await expect(service.setOverride("sup-1", NaN, "admin")).rejects.toThrow("integer");
    });

    it("reset clears all overrides", async () => {
      await service.setOverride("sup-1", 3, "admin");
      await service.setOverride("sup-2", 4, "admin");
      service.reset();
      expect(service.listOverrides()).toHaveLength(0);
    });

    it("seeds overrides from constructor options and lists them sorted", () => {
      const seeded = new SupplierBookingCapService({
        getRedis: () => redis,
        seed: [
          {
            supplierId: "sup-2",
            dailyCap: 8,
            createdAt: "2026-07-31T00:00:00.000Z",
            updatedAt: "2026-07-31T00:00:00.000Z",
            createdBy: "admin",
            updatedBy: "admin",
          },
          {
            supplierId: "sup-1",
            dailyCap: 7,
            createdAt: "2026-07-31T00:00:00.000Z",
            updatedAt: "2026-07-31T00:00:00.000Z",
            createdBy: "admin",
            updatedBy: "admin",
          },
        ],
      });
      expect(seeded.resolveCap("sup-1")).toBe(7);
      expect(seeded.resolveCap("sup-2")).toBe(8);
      expect(seeded.listOverrides().map((o) => o.supplierId)).toEqual(["sup-1", "sup-2"]);
    });
  });
});
