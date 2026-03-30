import request from "supertest";
import app, { __resetSlotsForTests } from "../index.js";

describe("DELETE /api/v1/slots/:id", () => {
  beforeEach(() => {
    __resetSlotsForTests();
  });

  const createSlot = async (professional: string) => {
    const created = await request(app).post("/api/v1/slots").send({
      professional,
      startTime: 1000,
      endTime: 2000,
    });
    return created.body.slot.id as number;
  };

  it("deletes a slot when called by the owner", async () => {
    const slotId = await createSlot("alice");

    const res = await request(app)
      .delete(`/api/v1/slots/${slotId}`)
      .set("x-user-id", "alice");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.deletedSlotId).toBe(slotId);

    const list = await request(app).get("/api/v1/slots");
    expect(list.body.slots).toHaveLength(0);
  });

  it("deletes a slot when called by admin", async () => {
    const slotId = await createSlot("alice");

    const res = await request(app)
      .delete(`/api/v1/slots/${slotId}`)
      .set("x-role", "admin");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 401 when caller identity is missing", async () => {
    const slotId = await createSlot("alice");

    const res = await request(app).delete(`/api/v1/slots/${slotId}`);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 403 when caller does not own the slot", async () => {
    const slotId = await createSlot("alice");

    const res = await request(app)
      .delete(`/api/v1/slots/${slotId}`)
      .set("x-user-id", "bob");

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("returns 404 for unknown slot id", async () => {
    const res = await request(app)
      .delete("/api/v1/slots/999")
      .set("x-user-id", "alice");

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 for invalid slot id", async () => {
    const res = await request(app)
      .delete("/api/v1/slots/not-a-number")
      .set("x-user-id", "alice");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
