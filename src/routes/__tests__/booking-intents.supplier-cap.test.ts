import { describe, expect, it, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import { createApp } from "../../app.js";
import { setRedisClient, type RedisClient } from "../../cache/redisClient.js";
import {
  defaultSupplierBookingCapService,
  nextUtcMidnight,
} from "../../services/supplierCap.js";

class FakeRedisClient implements RedisClient {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
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
    const next = (parseInt(this.store.get(key) ?? "0", 10) || 0) + 1;
    this.store.set(key, String(next));
    return next;
  }

  async expire(): Promise<unknown> {
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

// Bookable slots from InMemorySlotRepository.DEFAULT_SLOTS (alice, bob).
const ALICE_SLOT_ID = "slot-11111111-1111-4111-8111-111111111111";
const BOB_SLOT_ID = "slot-22222222-2222-4222-8222-222222222222";

const CUSTOMER_HEADERS = {
  "x-chronopay-user-id": "buyer-1",
  "x-chronopay-role": "customer",
};

// A single app instance is shared across tests (the repo's rate-limit store is a
// process singleton, so creating multiple apps trips express-rate-limit's
// store-reuse guard). A blocked (429) create never persists an intent, so the
// slot assignments below cannot collide across tests.
const app = createApp({ apiKey: "test-api-key" });

describe("POST /api/v1/booking-intents — supplier daily cap", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    setRedisClient(new FakeRedisClient());
    defaultSupplierBookingCapService.reset();
  });

  afterEach(() => {
    setRedisClient(null);
    defaultSupplierBookingCapService.reset();
  });

  it("allows creates under the default cap", async () => {
    const res = await request(app)
      .post("/api/v1/booking-intents")
      .set(CUSTOMER_HEADERS)
      .send({ slotId: BOB_SLOT_ID });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it("returns 429 + X-DailyCap-Reset when the supplier is soft-blocked (cap 0)", async () => {
    await defaultSupplierBookingCapService.setOverride("alice", 0, "admin");

    const res = await request(app)
      .post("/api/v1/booking-intents")
      .set(CUSTOMER_HEADERS)
      .send({ slotId: ALICE_SLOT_ID });

    expect(res.status).toBe(429);
    expect(res.headers["x-dailycap-reset"]).toBe(nextUtcMidnight(new Date()));
    expect(res.body).toMatchObject({
      success: false,
      code: "RATE_LIMITED",
      details: { supplierId: "alice", used: 1, cap: 0 },
    });
  });

  it("fails open (no cap enforcement) when Redis is unavailable", async () => {
    setRedisClient(null);
    await defaultSupplierBookingCapService.setOverride("alice", 0, "admin");

    const res = await request(app)
      .post("/api/v1/booking-intents")
      .set(CUSTOMER_HEADERS)
      .send({ slotId: ALICE_SLOT_ID });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});
