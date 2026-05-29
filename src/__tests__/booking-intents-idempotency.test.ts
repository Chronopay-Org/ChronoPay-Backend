import request from "supertest";
import { jest } from "@jest/globals";
import { setFeatureFlagsFromEnv } from "../flags/index.js";
import { setRedisClient, type RedisClient } from "../cache/redisClient.js";
import { defaultAuditLogger } from "../services/auditLogger.js";

type StoredValue = { value: string; expiresAt?: number };

class InMemoryRedisMock implements RedisClient {
  private store = new Map<string, StoredValue>();

  constructor(private readonly delayedCompleteWriteMs = 0) {}

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(
    key: string,
    value: string,
    exMode: "EX",
    ttl: number,
    condition?: "NX",
  ): Promise<unknown> {
    if (exMode !== "EX") {
      throw new Error("Mock only supports EX mode");
    }

    if (condition === "NX" && this.store.has(key)) {
      return null;
    }

    // Delay non-NX writes to make concurrent retry tests deterministic.
    if (!condition && this.delayedCompleteWriteMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayedCompleteWriteMs));
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttl * 1000,
    });

    return "OK";
  }

  async del(key: string): Promise<unknown> {
    this.store.delete(key);
    return 1;
  }

  async keys(pattern: string): Promise<string[]> {
    if (pattern === "*") {
      return Array.from(this.store.keys());
    }

    const prefix = pattern.replace("*", "");
    return Array.from(this.store.keys()).filter((k) => k.startsWith(prefix));
  }

  async quit(): Promise<unknown> {
    this.store.clear();
    return "OK";
  }
}

describe("POST /api/v1/booking-intents idempotency", () => {
  let app: any;
  let createApp: (options?: { enableDocs?: boolean }) => any;
  let auditSpy: ReturnType<typeof jest.spyOn>;

  beforeAll(async () => {
    process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
    process.env.FF_CREATE_BOOKING_INTENT = "true";
    setFeatureFlagsFromEnv(process.env);
    const mod = await import("../app.js");
    createApp = mod.createApp;
  });

  beforeEach(() => {
    setFeatureFlagsFromEnv({ ...process.env, FF_CREATE_BOOKING_INTENT: "true" });
    app = createApp({ enableDocs: false });
    auditSpy = jest.spyOn(defaultAuditLogger, "log").mockResolvedValue();
  });

  afterEach(() => {
    auditSpy.mockRestore();
    setRedisClient(null);
  });

  const actorHeaders = {
    "x-chronopay-user-id": "customer-123",
    "x-chronopay-role": "customer",
  };

  const url = "/api/v1/booking-intents";
  const body = { slotId: "slot-100", note: "window seat" };

  it("replays original response for same key and same body", async () => {
    const redisMock = new InMemoryRedisMock();
    setRedisClient(redisMock);

    const first = await request(app)
      .post(url)
      .set(actorHeaders)
      .set("x-forwarded-for", "127.0.0.1")
      .set("Idempotency-Key", "booking-intent-key-1")
      .send(body);

    const second = await request(app)
      .post(url)
      .set(actorHeaders)
      .set("x-forwarded-for", "127.0.0.1")
      .set("Idempotency-Key", "booking-intent-key-1")
      .send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);

    // Ensure idempotency data persisted in Redis for the key
    const storageKey = `idempotency:req:booking-intent-key-1`;
    const raw = await redisMock.get(storageKey);
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw as string);
    expect(stored.status).toBe("completed");
    expect(stored.statusCode).toBe(201);

    // Audit middleware should have been called only for the first (original) request
    expect(auditSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 422 for same key with different payload", async () => {
    setRedisClient(new InMemoryRedisMock());

    const first = await request(app)
      .post(url)
      .set(actorHeaders)
      .set("x-forwarded-for", "127.0.0.1")
      .set("Idempotency-Key", "booking-intent-key-2")
      .send(body);

    const second = await request(app)
      .post(url)
      .set(actorHeaders)
      .set("x-forwarded-for", "127.0.0.1")
      .set("Idempotency-Key", "booking-intent-key-2")
      .send({ slotId: "slot-100", note: "different payload" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(422);
    expect(second.body.error).toMatch(/Idempotency-Key used with different payload/i);
  });

  it("without idempotency key does normal non-idempotent behavior", async () => {
    setRedisClient(new InMemoryRedisMock());

    const first = await request(app).post(url).set(actorHeaders).set("x-forwarded-for", "127.0.0.1").send(body);
    const second = await request(app).post(url).set(actorHeaders).set("x-forwarded-for", "127.0.0.1").send(body);

    expect(first.status).toBe(201);
    // second attempt without key follows regular business rules (duplicate conflict)
    expect(second.status).toBe(409);
  });

  it("returns 409 for concurrent retries while first request is processing", async () => {
    setRedisClient(new InMemoryRedisMock(80));

    const [r1, r2] = await Promise.all([
      request(app)
        .post(url)
        .set(actorHeaders)
        .set("x-forwarded-for", "127.0.0.1")
        .set("Idempotency-Key", "booking-intent-key-3")
        .send(body),
      request(app)
        .post(url)
        .set(actorHeaders)
        .set("x-forwarded-for", "127.0.0.1")
        .set("Idempotency-Key", "booking-intent-key-3")
        .send(body),
    ]);

    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
  });

  it("returns 503 when Redis is unavailable and Idempotency-Key provided", async () => {
    // Simulate no Redis client configured
    setRedisClient(null);

    const resp = await request(app)
      .post(url)
      .set(actorHeaders)
      .set("x-forwarded-for", "127.0.0.1")
      .set("Idempotency-Key", "booking-intent-key-no-redis")
      .send(body);

    expect(resp.status).toBe(503);
    expect(resp.body.code).toBe("DEPENDENCY_UNAVAILABLE");
  });
});
