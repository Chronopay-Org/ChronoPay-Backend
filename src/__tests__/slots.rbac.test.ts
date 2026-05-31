import request from "supertest";
import express from "express";
import slotsRouter, { resetSlotStore } from "../routes/slots.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/slots", slotsRouter);
  return app;
}

const app = buildApp();

async function seedSlot(
  professional = "alice",
  startTime = 1_000_000,
  endTime = 2_000_000,
): Promise<number> {
  const res = await request(app)
    .post("/api/v1/slots")
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
      .set("x-user-role", "customer")
      .send({ professional: "bob" });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("rejects professional role with 403", async () => {
    const slotId = await seedSlot();
    const res = await request(app)
      .patch(`/api/v1/slots/${slotId}`)
      .set("x-user-role", "professional")
      .send({ professional: "bob" });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("allows admin to update a slot", async () => {
    const slotId = await seedSlot("alice");
    const res = await request(app)
      .patch(`/api/v1/slots/${slotId}`)
      .set("x-user-role", "admin")
      .send({ professional: "carol", startTime: 1_000_000, endTime: 3_000_000 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.slot.professional).toBe("carol");
  });

  it("returns 404 when admin targets a non-existent slot", async () => {
    await seedSlot();
    const res = await request(app)
      .patch("/api/v1/slots/9999")
      .set("x-user-role", "admin")
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
      .set("x-chronopay-user-id", "bob")
      .set("x-chronopay-role", "customer");
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("allows the slot owner to delete their slot", async () => {
    const slotId = await seedSlot("alice");
    const res = await request(app)
      .delete(`/api/v1/slots/${slotId}`)
      .set("x-chronopay-user-id", "alice")
      .set("x-chronopay-role", "customer");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.deletedSlotId).toBe(slotId);
  });

  it("allows an admin to delete any slot", async () => {
    const slotId = await seedSlot("alice");
    const res = await request(app)
      .delete(`/api/v1/slots/${slotId}`)
      .set("x-chronopay-user-id", "admin-user")
      .set("x-chronopay-role", "admin");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.deletedSlotId).toBe(slotId);
  });

  it("returns 404 when targeting a non-existent slot", async () => {
    const res = await request(app)
      .delete("/api/v1/slots/9999")
      .set("x-chronopay-user-id", "alice")
      .set("x-chronopay-role", "customer");
    expect(res.status).toBe(404);
  });

  it("slot is actually gone after a successful owner delete", async () => {
    const slotId = await seedSlot("alice");
    await request(app)
      .delete(`/api/v1/slots/${slotId}`)
      .set("x-chronopay-user-id", "alice")
      .set("x-chronopay-role", "customer");

    const getRes = await request(app).get(`/api/v1/slots/${slotId}`);
    expect(getRes.status).toBe(404);
  });
});
