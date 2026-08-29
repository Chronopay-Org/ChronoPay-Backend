/**
 * Tests for GET /api/v1/slots/:id/reservations  (issue #594)
 *
 * Covers:
 *  - Happy path: owner retrieves active holds with buyer_id visible
 *  - Zero holds: returns empty data array
 *  - Expired holds excluded
 *  - 403 when requester is a different professional (not the slot owner)
 *  - 404 for unknown slot
 *  - 401 when no auth headers present
 *  - 401 when role header is missing / invalid
 *  - 403 when role is 'customer'
 *  - Admin can read any slot's reservations
 *  - Pagination: page/limit respected, total reflects full active count
 *  - Invalid pagination params return 400
 */

import request from "supertest";
import express from "express";
import slotsRouter, { resetSlotStore } from "../routes/slots.js";
import { slotService } from "../services/slotService.js";

// ─── App setup ────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/slots", slotsRouter);
  return app;
}

const app = buildApp();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function seedSlot(professional = "alice"): Promise<string> {
  const slot = slotService.createSlot({
    professional,
    startTime: 1_000_000,
    endTime: 2_000_000,
  });
  return String(slot.id);
}

const FUTURE = Date.now() + 60 * 60 * 1000; // 1 hour from now
const PAST = Date.now() - 60 * 60 * 1000;   // 1 hour ago

function addHold(slotId: string, buyerId = "buyer-1", expiresAt = FUTURE) {
  return slotService.addHold({ slotId, buyerId, expiresAt });
}

function authHeaders(userId: string, role = "professional") {
  return { "x-chronopay-user-id": userId, "x-chronopay-role": role };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetSlotStore();
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("GET /api/v1/slots/:id/reservations — happy path", () => {
  it("returns active holds for the slot owner", async () => {
    const slotId = await seedSlot("alice");
    addHold(slotId, "buyer-1", FUTURE);
    addHold(slotId, "buyer-2", FUTURE);

    const res = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations`)
      .set(authHeaders("alice"));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.total).toBe(2);
    expect(res.body.data).toHaveLength(2);

    const hold = res.body.data[0];
    expect(hold).toHaveProperty("id");
    expect(hold).toHaveProperty("slotId", slotId);
    expect(hold).toHaveProperty("status", "held");
    expect(hold).toHaveProperty("expiresAt");
    expect(hold).toHaveProperty("createdAt");
    // Owner sees buyer_id
    expect(hold.buyerId).not.toBeNull();
  });

  it("includes buyer_id in response when caller is the owner", async () => {
    const slotId = await seedSlot("alice");
    addHold(slotId, "buyer-xyz", FUTURE);

    const res = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations`)
      .set(authHeaders("alice"));

    expect(res.status).toBe(200);
    expect(res.body.data[0].buyerId).toBe("buyer-xyz");
  });

  it("returns default pagination metadata", async () => {
    const slotId = await seedSlot("alice");
    addHold(slotId, "buyer-1", FUTURE);

    const res = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations`)
      .set(authHeaders("alice"));

    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(10);
  });
});

// ─── Zero holds ───────────────────────────────────────────────────────────────

describe("GET /api/v1/slots/:id/reservations — zero holds", () => {
  it("returns empty data array when slot has no holds", async () => {
    const slotId = await seedSlot("alice");

    const res = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations`)
      .set(authHeaders("alice"));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("excludes expired holds (returns empty when all holds are expired)", async () => {
    const slotId = await seedSlot("alice");
    addHold(slotId, "buyer-1", PAST);  // expired
    addHold(slotId, "buyer-2", PAST);  // expired

    const res = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations`)
      .set(authHeaders("alice"));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("excludes expired holds but includes active ones", async () => {
    const slotId = await seedSlot("alice");
    addHold(slotId, "buyer-expired", PAST);
    addHold(slotId, "buyer-active", FUTURE);

    const res = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations`)
      .set(authHeaders("alice"));

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].buyerId).toBe("buyer-active");
  });
});

// ─── 403 wrong supplier ───────────────────────────────────────────────────────

describe("GET /api/v1/slots/:id/reservations — 403 for wrong professional", () => {
  it("returns 403 when a different professional requests the reservations", async () => {
    const slotId = await seedSlot("alice");
    addHold(slotId, "buyer-1", FUTURE);

    const res = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations`)
      .set(authHeaders("bob")); // bob ≠ alice (the slot owner)

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/insufficient permissions/i);
  });

  it("returns 403 even when the requesting professional has holds on the slot", async () => {
    const slotId = await seedSlot("alice");
    // bob has a hold but is not the owner
    addHold(slotId, "bob", FUTURE);

    const res = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations`)
      .set(authHeaders("bob"));

    expect(res.status).toBe(403);
  });
});

// ─── 404 ─────────────────────────────────────────────────────────────────────

describe("GET /api/v1/slots/:id/reservations — 404 for unknown slot", () => {
  it("returns 404 when slot does not exist", async () => {
    const res = await request(app)
      .get("/api/v1/slots/9999/reservations")
      .set(authHeaders("alice"));

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

// ─── Auth guards ─────────────────────────────────────────────────────────────

describe("GET /api/v1/slots/:id/reservations — auth guards", () => {
  it("returns 401 when no auth headers are provided", async () => {
    const slotId = await seedSlot("alice");

    const res = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations`);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 401 when user-id is present but role header is missing", async () => {
    const slotId = await seedSlot("alice");

    const res = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations`)
      .set("x-chronopay-user-id", "alice");

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 403 when role is 'customer'", async () => {
    const slotId = await seedSlot("alice");

    const res = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations`)
      .set(authHeaders("alice", "customer"));

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });
});

// ─── Admin access ─────────────────────────────────────────────────────────────

describe("GET /api/v1/slots/:id/reservations — admin access", () => {
  it("allows admin to read reservations for any slot", async () => {
    const slotId = await seedSlot("alice");
    addHold(slotId, "buyer-1", FUTURE);

    const res = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations`)
      .set(authHeaders("admin-user", "admin"));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    // Admin also sees buyer_id
    expect(res.body.data[0].buyerId).toBe("buyer-1");
  });
});

// ─── Pagination ───────────────────────────────────────────────────────────────

describe("GET /api/v1/slots/:id/reservations — pagination", () => {
  it("respects limit parameter", async () => {
    const slotId = await seedSlot("alice");
    for (let i = 0; i < 5; i++) {
      addHold(slotId, `buyer-${i}`, FUTURE);
    }

    const res = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations?limit=3`)
      .set(authHeaders("alice"));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.limit).toBe(3);
    expect(res.body.total).toBe(5);
  });

  it("respects page parameter", async () => {
    const slotId = await seedSlot("alice");
    for (let i = 0; i < 5; i++) {
      addHold(slotId, `buyer-${i}`, FUTURE);
    }

    const resPage1 = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations?limit=3&page=1`)
      .set(authHeaders("alice"));

    const resPage2 = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations?limit=3&page=2`)
      .set(authHeaders("alice"));

    expect(resPage1.body.data).toHaveLength(3);
    expect(resPage2.body.data).toHaveLength(2);
    expect(resPage2.body.page).toBe(2);

    // Pages must not overlap
    const ids1 = resPage1.body.data.map((h: any) => h.id);
    const ids2 = resPage2.body.data.map((h: any) => h.id);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
  });

  it("returns empty data on out-of-range page", async () => {
    const slotId = await seedSlot("alice");
    addHold(slotId, "buyer-1", FUTURE);

    const res = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations?page=99`)
      .set(authHeaders("alice"));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(1);
  });

  it("returns 400 for invalid page (zero)", async () => {
    const slotId = await seedSlot("alice");

    const res = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations?page=0`)
      .set(authHeaders("alice"));

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/page/i);
  });

  it("returns 400 for invalid limit (zero)", async () => {
    const slotId = await seedSlot("alice");

    const res = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations?limit=0`)
      .set(authHeaders("alice"));

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/limit/i);
  });

  it("returns 400 for limit exceeding 100", async () => {
    const slotId = await seedSlot("alice");

    const res = await request(app)
      .get(`/api/v1/slots/${slotId}/reservations?limit=101`)
      .set(authHeaders("alice"));

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/limit/i);
  });
});

// ─── Slot param validation ────────────────────────────────────────────────────

describe("GET /api/v1/slots/:id/reservations — slot id param validation", () => {
  it("returns 400 for non-integer slot id", async () => {
    const res = await request(app)
      .get("/api/v1/slots/abc/reservations")
      .set(authHeaders("alice"));

    expect(res.status).toBe(400);
  });

  it("returns 400 for negative slot id", async () => {
    const res = await request(app)
      .get("/api/v1/slots/-1/reservations")
      .set(authHeaders("alice"));

    expect(res.status).toBe(400);
  });
});
