/**
 * Route-level tests for /api/v1/bookings/search, including the end-to-end
 * noisy-tenant scenario: one tenant burns its entire bucket while another
 * tenant's traffic stays unaffected.
 */

import request from "supertest";
import express from "express";

const { createBookingsRouter } = await import("../bookings.js");
const { InMemoryBookingIntentRepository } = await import(
  "../../modules/booking-intents/booking-intent-repository.js"
);
const { createTenantLeakyBucketRateLimiter, InMemoryLeakyBucketStore } = await import(
  "../../middleware/tenantLeakyBucket.js"
);

const T0 = 1_700_000_000_000;
const AUTH = { "x-chronopay-user-id": "buyer-1", "x-chronopay-role": "customer" };
const PRO = { "x-chronopay-user-id": "pro-1", "x-chronopay-role": "professional" };

function seed(repository: InstanceType<typeof InMemoryBookingIntentRepository>) {
  const base = {
    professional: "dr-smith",
    startTime: Date.parse("2026-08-01T10:00:00Z"),
    endTime: Date.parse("2026-08-01T11:00:00Z"),
    createdAt: "2026-07-01T00:00:00Z",
  };
  return Promise.all([
    repository.create({ ...base, slotId: "slot-1", customerId: "buyer-1", status: "pending", note: "teeth cleaning" }),
    repository.create({ ...base, slotId: "slot-2", customerId: "buyer-1", status: "confirmed", note: "root canal" }),
    repository.create({
      ...base,
      slotId: "slot-3",
      customerId: "buyer-1",
      status: "cancelled",
      note: "checkup",
      startTime: Date.parse("2026-09-01T10:00:00Z"),
      endTime: Date.parse("2026-09-01T11:00:00Z"),
    }),
    repository.create({ ...base, slotId: "slot-9", customerId: "other-buyer", status: "confirmed", note: "not mine" }),
  ]);
}

function buildApp(options: {
  repository?: InstanceType<typeof InMemoryBookingIntentRepository>;
  rateLimiter?: express.RequestHandler;
} = {}) {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/bookings", createBookingsRouter(options));
  return app;
}

describe("GET /api/v1/bookings/search", () => {
  let repository: InstanceType<typeof InMemoryBookingIntentRepository>;
  let app: express.Express;

  beforeEach(async () => {
    repository = new InMemoryBookingIntentRepository();
    await seed(repository);
    app = buildApp({ repository });
  });

  it("rejects unauthenticated callers with 401", async () => {
    const res = await request(app).get("/api/v1/bookings/search").expect(401);
    expect(res.body.success).toBe(false);
  });

  it("rejects unknown roles with 400", async () => {
    await request(app)
      .get("/api/v1/bookings/search")
      .set({ "x-chronopay-user-id": "u", "x-chronopay-role": "overlord" })
      .expect(400);
  });

  it("returns only the caller's bookings", async () => {
    const res = await request(app).get("/api/v1/bookings/search").set(AUTH).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.total).toBe(3); // "not mine" belongs to other-buyer
    for (const record of res.body.data.results) {
      expect(record.customerId).toBe("buyer-1");
    }
  });

  it("supports professional and support/admin roles", async () => {
    await request(app).get("/api/v1/bookings/search").set(PRO).expect(200);
    await request(app)
      .get("/api/v1/bookings/search")
      .set({ "x-chronopay-user-id": "s1", "x-chronopay-role": "admin" })
      .expect(200);
  });

  it("filters by status", async () => {
    const res = await request(app)
      .get("/api/v1/bookings/search?status=confirmed")
      .set(AUTH)
      .expect(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.results[0].slotId).toBe("slot-2");
  });

  it("rejects invalid status values", async () => {
    const res = await request(app)
      .get("/api/v1/bookings/search?status=invented")
      .set(AUTH)
      .expect(400);
    expect(res.body.error).toMatch(/status must be one of/);
  });

  it("filters by free-text q over note/slot/id (case-insensitive)", async () => {
    const res = await request(app)
      .get("/api/v1/bookings/search?q=ROOT")
      .set(AUTH)
      .expect(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.results[0].slotId).toBe("slot-2");
  });

  it("filters by slotId", async () => {
    const res = await request(app)
      .get("/api/v1/bookings/search?slotId=slot-3")
      .set(AUTH)
      .expect(200);
    expect(res.body.data.total).toBe(1);
  });

  it("filters by overlapping date range and validates the range", async () => {
    const res = await request(app)
      .get("/api/v1/bookings/search?from=2026-08-15T00:00:00Z&to=2026-09-15T00:00:00Z")
      .set(AUTH)
      .expect(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.results[0].slotId).toBe("slot-3");

    await request(app)
      .get("/api/v1/bookings/search?from=not-a-date")
      .set(AUTH)
      .expect(400);
    await request(app)
      .get("/api/v1/bookings/search?to=not-a-date")
      .set(AUTH)
      .expect(400);
    await request(app)
      .get("/api/v1/bookings/search?from=2026-09-02T00:00:00Z&to=2026-08-01T00:00:00Z")
      .set(AUTH)
      .expect(400);
  });

  it("free-text search matches note-less bookings by id/slot and tolerates empty search params", async () => {
    repository = new InMemoryBookingIntentRepository();
    await repository.create({
      slotId: "slot-plain",
      customerId: "buyer-1",
      professional: "dr-no-notes",
      startTime: Date.parse("2026-08-01T10:00:00Z"),
      endTime: Date.parse("2026-08-01T11:00:00Z"),
      status: "pending",
      createdAt: "2026-07-01T00:00:00Z",
      // deliberately no `note`
    });
    app = buildApp({ repository });

    const res = await request(app)
      .get("/api/v1/bookings/search?q=no-notes")
      .set(AUTH)
      .expect(200);
    expect(res.body.data.total).toBe(1);

    // q present but blank behaves like no filter; non-string query values are ignored
    const blank = await request(app)
      .get("/api/v1/bookings/search?q=%20&status=")
      .set(AUTH)
      .expect(200);
    expect(blank.body.data.total).toBe(1);
  });

  it("supports one-sided ranges (only `to`, only `from`)", async () => {
    const beforeMid = await request(app)
      .get("/api/v1/bookings/search?to=2026-08-15T00:00:00Z")
      .set(AUTH)
      .expect(200);
    expect(beforeMid.body.data.total).toBe(2); // both August bookings, slot-3 excluded

    const afterMid = await request(app)
      .get("/api/v1/bookings/search?from=2026-08-15T00:00:00Z")
      .set(AUTH)
      .expect(200);
    expect(afterMid.body.data.total).toBe(1);
    expect(afterMid.body.data.results[0].slotId).toBe("slot-3");
  });

  it("paginates with limit/offset and validates them", async () => {
    const page1 = await request(app)
      .get("/api/v1/bookings/search?limit=2&offset=0")
      .set(AUTH)
      .expect(200);
    expect(page1.body.data.results).toHaveLength(2);
    expect(page1.body.data.total).toBe(3);

    const page2 = await request(app)
      .get("/api/v1/bookings/search?limit=2&offset=2")
      .set(AUTH)
      .expect(200);
    expect(page2.body.data.results).toHaveLength(1);

    await request(app).get("/api/v1/bookings/search?limit=0").set(AUTH).expect(400);
    await request(app).get("/api/v1/bookings/search?limit=101").set(AUTH).expect(400);
    await request(app).get("/api/v1/bookings/search?offset=-1").set(AUTH).expect(400);
  });

  it("rejects overlong q", async () => {
    await request(app)
      .get(`/api/v1/bookings/search?q=${"a".repeat(201)}`)
      .set(AUTH)
      .expect(400);
  });

  it("surfaces repository failures as 500 without leaking internals", async () => {
    const broken = new InMemoryBookingIntentRepository();
    broken.listByCustomer = async () => {
      throw new Error("db exploded with sensitive detail");
    };
    const brokenApp = buildApp({ repository: broken });
    const res = await request(brokenApp).get("/api/v1/bookings/search").set(AUTH).expect(500);
    expect(res.body).toEqual({ success: false, error: "Search failed" });
  });
});

describe("GET /api/v1/bookings/search — per-tenant leaky bucket E2E", () => {
  it("a noisy tenant is throttled at 120 burst + 60 rps while other tenants stay unaffected", async () => {
    let now = T0;
    const store = new InMemoryLeakyBucketStore(() => now);
    const rateLimiter = createTenantLeakyBucketRateLimiter({
      ratePerSecond: 60,
      capacity: 120,
      routeScope: "bookings:search",
      store,
    });
    const app = buildApp({ repository: new InMemoryBookingIntentRepository(), rateLimiter });

    const noisy = { "x-chronopay-user-id": "noisy-tenant", "x-chronopay-role": "customer" };
    const quiet = { "x-chronopay-user-id": "quiet-tenant", "x-chronopay-role": "customer" };

    // Noisy tenant burns the full 120-token burst.
    for (let i = 0; i < 120; i++) {
      await request(app).get("/api/v1/bookings/search").set(noisy).expect(200);
    }
    const throttled = await request(app).get("/api/v1/bookings/search").set(noisy).expect(429);
    expect(throttled.headers["retry-after"]).toBe("1");
    expect(throttled.body.retryAfter).toBe(1);

    // The quiet tenant still gets full service — no starvation.
    const ok = await request(app).get("/api/v1/bookings/search").set(quiet).expect(200);
    expect(ok.body.success).toBe(true);

    // One second of drain gives the noisy tenant its 60 rps sustained budget back.
    now += 1000;
    for (let i = 0; i < 60; i++) {
      await request(app).get("/api/v1/bookings/search").set(noisy).expect(200);
    }
    await request(app).get("/api/v1/bookings/search").set(noisy).expect(429);
  });

  it("uses the default limiter (config-driven 60 rps / 120 burst) when none is injected", async () => {
    const app = buildApp({ repository: new InMemoryBookingIntentRepository() });
    const res = await request(app).get("/api/v1/bookings/search").set(AUTH).expect(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("120");
  });
});
