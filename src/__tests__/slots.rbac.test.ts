import { createTestAuthorization } from "../../test/auth.js";
import request from "supertest";
import { jest } from "@jest/globals";
import { resetSlotStore } from "../routes/slots.js";
import express from "express";
import { jest } from "@jest/globals";
import slotsRouter, { resetSlotStore } from "../routes/slots.js";
import { featureFlagContextMiddleware } from "../middleware/featureFlags.js";
import { partnerTierService } from "../services/partnerTierService.js";
import { createApp } from "../app.js";
import { SlotRepository } from "../repositories/slotRepository.js";

// The route's requireApiKey derives the partner tier from the API key; seed
// requests use the shared test key, so pin the tier service to "premium" to
// keep this suite focused on RBAC rather than partner-tier gating.
jest
  .spyOn(partnerTierService, "fetchPartnerTier")
  .mockResolvedValue("premium");

// The real slots router is mounted by createApp at /api/v1/slots. We inject a
// fresh in-memory repository per suite so tests exercise the production wiring
// (router + SlotService + authorizeSlotDelete) rather than inline mocks.
function buildApp() {
  const slotRepository = new SlotRepository();
  return createApp({ slotRepository });
}

const app = buildApp();

async function seedSlot(
  professional = "alice",
  startTime = 1_000_000,
  endTime = 2_000_000,
): Promise<number> {
  const res = await request(app)
    .post("/api/v1/slots")
    .set("x-api-key", "test-api-key")
    .send({ professional, startTime, endTime });
  return res.body.slot.id as number;
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

describe("PATCH /api/v1/slots/:id — RBAC", () => {
  beforeEach(() => {
    resetSlotStore();
  });

  it("rejects unauthenticated request (missing x-user-role) with 401", async () => {
    const slotId = await seedSlot();
    const res = await request(app)
      .patch(`/api/v1/slots/${slotId}`)
      .send({ professional: "bob" });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("rejects customer role with 403", async () => {
    const slotId = await seedSlot();
    const res = await request(app)
      .patch(`/api/v1/slots/${slotId}`)
      .set("Authorization", createTestAuthorization("test-user", "customer"))
      .send({ professional: "bob" });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("rejects professional role with 403", async () => {
    const slotId = await seedSlot();
    const res = await request(app)
      .patch(`/api/v1/slots/${slotId}`)
      .set("Authorization", createTestAuthorization("test-user", "professional"))
      .send({ professional: "bob" });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("allows admin to update a slot", async () => {
    const slotId = await seedSlot("alice");
    const res = await request(app)
      .patch(`/api/v1/slots/${slotId}`)
      .set("Authorization", createTestAuthorization("test-user", "admin"))
      .send({ professional: "carol", startTime: 1_000_000, endTime: 3_000_000 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.slot.professional).toBe("carol");
  });

  it("returns 404 when admin targets a non-existent slot", async () => {
    await seedSlot();
    const res = await request(app)
      .patch("/api/v1/slots/9999")
      .set("Authorization", createTestAuthorization("test-user", "admin"))
      .send({ professional: "carol" });
    expect(res.status).toBe(404);
  });
});

// ─── DELETE ───────────────────────────────────────────────────────────────────

describe("DELETE /api/v1/slots/:id — RBAC", () => {
  beforeEach(() => {
    resetSlotStore();
  });

  it("rejects unauthenticated request (missing x-chronopay-user-id) with 401", async () => {
    const slotId = await seedSlot();
    const res = await request(app).delete(`/api/v1/slots/${slotId}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("rejects a foreign user (non-owner, non-admin) with 403", async () => {
    const slotId = await seedSlot("alice");
    const res = await request(app)
      .delete(`/api/v1/slots/${slotId}`)
      .set("Authorization", createTestAuthorization("bob", "customer"));
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("allows the slot owner to delete their slot", async () => {
    const slotId = await seedSlot("alice");
    const res = await request(app)
      .delete(`/api/v1/slots/${slotId}`)
      .set("Authorization", createTestAuthorization("alice", "customer"));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.deletedSlotId).toBe(slotId);
  });

  it("allows an admin to delete any slot", async () => {
    const slotId = await seedSlot("alice");
    const res = await request(app)
      .delete(`/api/v1/slots/${slotId}`)
      .set("Authorization", createTestAuthorization("admin-user", "admin"));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.deletedSlotId).toBe(slotId);
  });

  it("returns 404 when targeting a non-existent slot", async () => {
    const res = await request(app)
      .delete("/api/v1/slots/9999")
      .set("Authorization", createTestAuthorization("alice", "customer"));
    expect(res.status).toBe(404);
  });

  it("slot is actually gone after a successful owner delete", async () => {
    const slotId = await seedSlot("alice");
    await request(app)
      .delete(`/api/v1/slots/${slotId}`)
      .set("Authorization", createTestAuthorization("alice", "customer"));

    const getRes = await request(app).get(`/api/v1/slots/${slotId}`);
    expect(getRes.status).toBe(404);
  });
});

// ─── Persistence & pagination (real router wiring) ───────────────────────────

describe("POST/GET /api/v1/slots — real persistence via createApp", () => {
  beforeEach(() => {
    resetSlotStore();
  });

  it("a slot created via POST is retrievable via GET with the generated id", async () => {
    const createRes = await request(app)
      .post("/api/v1/slots")
      .set("x-api-key", "test-api-key")
      .send({ professional: "alice", startTime: 1_000_000, endTime: 2_000_000 });
    expect(createRes.status).toBe(201);
    const createdId = createRes.body.slot.id;
    expect(createdId).toBeDefined();
    expect(createdId).not.toBe("slot-new");

    const getRes = await request(app).get(`/api/v1/slots/${createdId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.slot.id).toBe(createdId);
    expect(getRes.body.slot.professional).toBe("alice");
  });

  it("GET ?page=2&limit=1 returns the second slot when two exist", async () => {
    const firstId = await seedSlot("alice", 1_000_000, 2_000_000);
    const secondId = await seedSlot("carol", 3_000_000, 4_000_000);
    expect(firstId).not.toBe(secondId);

    const res = await request(app).get("/api/v1/slots?page=2&limit=1");
    expect(res.status).toBe(200);
    const data = res.body.data ?? res.body.slots ?? [];
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(secondId);
  });

  it("DELETE by a non-owner is rejected by authorizeSlotDelete (no username special cases)", async () => {
    const slotId = await seedSlot("alice");
    const res = await request(app)
      .delete(`/api/v1/slots/${slotId}`)
      .set("x-chronopay-user-id", "bob")
      .set("x-chronopay-role", "customer");
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);

    const getRes = await request(app).get(`/api/v1/slots/${slotId}`);
    expect(getRes.status).toBe(200);
  });
});
