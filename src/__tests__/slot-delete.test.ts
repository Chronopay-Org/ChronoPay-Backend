import express from "express";
import request from "supertest";
import slotsRouter, { resetSlotStore } from "../routes/slots.js";
import { slotService } from "../services/slotService.js";

describe("DELETE /api/v1/slots/:id", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use("/api/v1/slots", slotsRouter);
    resetSlotStore();
  });

  it("allows the owner to delete their own slot", async () => {
    const slot = slotService.createSlot({ professional: "owner", startTime: 1000, endTime: 2000 });

    const response = await request(app)
      .delete(`/api/v1/slots/${slot.id}`)
      .set("x-user-id", "owner")
      .set("x-role", "user");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, deletedSlotId: slot.id });
  });

  it("returns 404 for a foreign user instead of revealing the slot exists", async () => {
    const slot = slotService.createSlot({ professional: "owner", startTime: 2000, endTime: 3000 });

    const response = await request(app)
      .delete(`/api/v1/slots/${slot.id}`)
      .set("x-user-id", "other-user")
      .set("x-role", "user");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ success: false, error: "Slot not found" });
  });

  it("allows an admin to delete any slot", async () => {
    const slot = slotService.createSlot({ professional: "owner", startTime: 3000, endTime: 4000 });

    const response = await request(app)
      .delete(`/api/v1/slots/${slot.id}`)
      .set("x-role", "admin");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, deletedSlotId: slot.id });
  });

  it("returns 404 when the slot does not exist", async () => {
    const response = await request(app)
      .delete("/api/v1/slots/999")
      .set("x-user-id", "owner")
      .set("x-role", "user");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ success: false, error: "Slot not found" });
  });
});
